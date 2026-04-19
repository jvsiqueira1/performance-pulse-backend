import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { computeMetricFields } from "../services/scoring.js";
import { evaluateBadgesForAssessor } from "../services/badgeEngine.js";
import { eventBus } from "../services/eventBus.js";
import { parseDateOnly, todayInAppTz } from "../lib/dates.js";

// Markers no campo `notes` pra reuniões que geram pontos automáticos.
// Backend sobrescreve pointsAwarded. Sem migration.
const MEETING_NOTE_PREFIX = "[REUNIAO]";
const MEETING_BONUS_POINTS = 10;
const MEETING_AREA_PREFIX = "[REUNIAO_AREA]";
const MEETING_AREA_POINTS = 5;

const metricResponseSchema = z.object({
  id: z.string(),
  assessorId: z.string(),
  kpiId: z.string(),
  kpiKey: z.string(),
  activityId: z.string().nullable(),
  date: z.string(), // YYYY-MM-DD
  rawValue: z.number(),
  baseValue: z.number().nullable(),
  convertedPercent: z.number().nullable(),
  pointsAwarded: z.number().nullable(),
  enteredById: z.string(),
  notes: z.string().nullable(),
  /// Sprint C - quando a entry foi criada/editada em data ≠ hoje (retroativa)
  backfilledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const upsertMetricBodySchema = z.object({
  assessorId: z.string().min(1),
  /** Pode vir kpiId direto OU kpiKey (mais conveniente do frontend). */
  kpiKey: z.string().min(1).optional(),
  kpiId: z.string().optional(),
  /** Default: hoje no fuso BRT. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Esperado YYYY-MM-DD")
    .optional(),
  rawValue: z.number().min(0),
  baseValue: z.number().min(0).optional(),
  notes: z.string().max(500).optional(),
  /** Opcional: vincula a entry a uma activity. Se houver targetOverride no
   *  ActivityKpi correspondente, ele sobrescreve a meta padrão. */
  activityId: z.string().optional(),
});

const patchMetricBodySchema = z.object({
  rawValue: z.number().min(0).optional(),
  baseValue: z.number().min(0).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const listQuerySchema = z.object({
  assessorId: z.string().optional(),
  kpiId: z.string().optional(),
  kpiKey: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

type MetricRow = {
  id: string;
  assessorId: string;
  kpiId: string;
  activityId: string | null;
  date: Date;
  rawValue: number;
  baseValue: number | null;
  convertedPercent: number | null;
  pointsAwarded: number | null;
  enteredById: string;
  notes: string | null;
  backfilledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  kpi: { key: string };
};

function serializeMetric(m: MetricRow) {
  return {
    id: m.id,
    assessorId: m.assessorId,
    kpiId: m.kpiId,
    kpiKey: m.kpi.key,
    activityId: m.activityId,
    date: m.date.toISOString().slice(0, 10),
    rawValue: m.rawValue,
    baseValue: m.baseValue,
    convertedPercent: m.convertedPercent,
    pointsAwarded: m.pointsAwarded,
    enteredById: m.enteredById,
    notes: m.notes,
    backfilledAt: m.backfilledAt ? m.backfilledAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export default async function metricRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // ─── UPSERT (POST) ───────────────────────────────────────────────────────
  typed.post(
    "/api/metrics",
    {
      schema: {
        description:
          "Upsert de métrica diária. Backend resolve activeGoal e calcula convertedPercent + pointsAwarded.",
        tags: ["metrics"],
        security: [{ bearerAuth: [] }],
        body: upsertMetricBodySchema,
        response: { 200: metricResponseSchema, 201: metricResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { assessorId, kpiKey, kpiId, date, rawValue, baseValue, notes, activityId } =
        req.body;
      const enteredById = req.user.sub;

      if (!kpiKey && !kpiId) {
        return reply.status(400).send({ error: "Informe kpiKey ou kpiId" } as never);
      }

      // Resolver KPI + scoring rule
      const kpi = await app.prisma.kpi.findUnique({
        where: kpiId ? { id: kpiId } : { key: kpiKey! },
        include: { scoringRule: true },
      });
      if (!kpi) return reply.status(404).send({ error: "KPI não encontrado" } as never);

      // Validar assessor
      const assessor = await app.prisma.assessor.findUnique({ where: { id: assessorId } });
      if (!assessor) return reply.status(404).send({ error: "Assessor não encontrado" } as never);

      // Resolver data
      const targetDate = date ? parseDateOnly(date) : todayInAppTz();

      // Backfill detection: marca quando admin lança métrica em data ≠ hoje
      // (Sprint C - visibilidade que Felipe pediu pra "pontuação retroativa").
      const today = todayInAppTz();
      const isBackfill = targetDate.getTime() !== today.getTime();

      // Resolver active goal pra essa data
      const activeGoal = await app.prisma.goal.findFirst({
        where: {
          kpiId: kpi.id,
          validFrom: { lte: targetDate },
          OR: [{ validTo: null }, { validTo: { gt: targetDate } }],
        },
        orderBy: { validFrom: "desc" },
      });

      // Override por atividade: se entry vinculada a uma activity e existir
      // ActivityKpi com targetOverride não-nulo, ele sobrescreve a meta padrão.
      let effectiveGoal = activeGoal;
      if (activityId) {
        const activityKpi = await app.prisma.activityKpi.findUnique({
          where: { activityId_kpiId: { activityId, kpiId: kpi.id } },
        });
        if (activityKpi?.targetOverride !== undefined && activityKpi?.targetOverride !== null) {
          effectiveGoal = { value: activityKpi.targetOverride } as typeof activeGoal;
        }
      }

      // Calcular campos derivados (passa scoring rule do banco se houver)
      const computed = computeMetricFields(
        kpi,
        effectiveGoal,
        rawValue,
        baseValue ?? null,
        kpi.scoringRule && kpi.scoringRule.active
          ? {
              ruleType: kpi.scoringRule.ruleType,
              divisor: kpi.scoringRule.divisor,
              pointsPerBucket: kpi.scoringRule.pointsPerBucket,
              thresholdPct: kpi.scoringRule.thresholdPct,
              thresholdPoints: kpi.scoringRule.thresholdPoints,
            }
          : null,
      );

      // Bonus de reunião: markers no notes sobrescrevem pontos.
      // [REUNIAO] → +10 pts, [REUNIAO_AREA] → +5 pts.
      // convertedPercent fica null pra não afetar weeklyGoalPercent.
      const trimmedNotes = notes?.trimStart() ?? "";
      const isMeetingBonus =
        trimmedNotes.startsWith(MEETING_NOTE_PREFIX) &&
        !trimmedNotes.startsWith(MEETING_AREA_PREFIX) &&
        trimmedNotes.slice(MEETING_NOTE_PREFIX.length).trim().length > 0;
      const isMeetingAreaBonus =
        trimmedNotes.startsWith(MEETING_AREA_PREFIX) &&
        trimmedNotes.slice(MEETING_AREA_PREFIX.length).trim().length > 0;

      let pointsAwarded = computed.pointsAwarded;
      let convertedPercent: number | null = computed.convertedPercent;
      if (isMeetingBonus) {
        pointsAwarded = MEETING_BONUS_POINTS;
        convertedPercent = null;
      } else if (isMeetingAreaBonus) {
        pointsAwarded = MEETING_AREA_POINTS;
        convertedPercent = null;
      }

      // Manual upsert: findFirst em (assessorId, kpiId, activityId, date)
      // (Postgres trata NULL como distinct em UNIQUE, então não dá pra usar
      // o upsert nativo do Prisma com a chave composta)
      const existing = await app.prisma.metricEntry.findFirst({
        where: {
          assessorId,
          kpiId: kpi.id,
          date: targetDate,
          activityId: activityId ?? null,
        },
      });

      let row: MetricRow;
      let created = false;
      if (existing) {
        row = await app.prisma.metricEntry.update({
          where: { id: existing.id },
          data: {
            rawValue,
            baseValue: baseValue ?? null,
            convertedPercent,
            pointsAwarded,
            notes: notes ?? null,
            enteredById,
            // Atualiza backfilledAt só se a edição é em data ≠ hoje. Se admin
            // edita entry de hoje, nunca marca como backfill. Se edita entry
            // de dia passado, sempre marca (mesmo se já estava marcada antes).
            backfilledAt: isBackfill ? new Date() : null,
          },
          include: { kpi: { select: { key: true } } },
        });
      } else {
        row = await app.prisma.metricEntry.create({
          data: {
            assessorId,
            kpiId: kpi.id,
            activityId: activityId ?? null,
            date: targetDate,
            rawValue,
            baseValue: baseValue ?? null,
            convertedPercent,
            pointsAwarded,
            notes: notes ?? null,
            enteredById,
            backfilledAt: isBackfill ? new Date() : null,
          },
          include: { kpi: { select: { key: true } } },
        });
        created = true;
      }

      // Detecta cruzamento de 100% pra broadcastar goal:hit (toast 🎯 no frontend)
      const prevPct = existing?.convertedPercent ?? 0;
      const newPct = convertedPercent ?? 0;
      const crossedGoal = prevPct < 100 && newPct >= 100;

      // Fire badge evaluation + ranking update + goal:hit em background.
      setImmediate(async () => {
        try {
          await evaluateBadgesForAssessor(app.prisma, assessorId, targetDate, app.log);
        } catch (err) {
          app.log.error({ err, assessorId }, "badgeEngine failed");
        }
        eventBus.emitRankingUpdate();

        if (crossedGoal) {
          try {
            const assessor = await app.prisma.assessor.findUnique({
              where: { id: assessorId },
              select: { name: true, initials: true, photoUrl: true },
            });
            if (assessor) {
              eventBus.emitGoalHit({
                assessorName: assessor.name,
                assessorInitials: assessor.initials,
                photoUrl: assessor.photoUrl,
                kpiLabel: kpi.label,
                kpiKey: kpi.key,
                percent: Math.round(newPct),
              });
            }
          } catch (err) {
            app.log.error({ err, assessorId }, "goal:hit emit failed");
          }
        }
      });

      reply.status(created ? 201 : 200);
      return serializeMetric(row);
    },
  );

  // ─── PATCH ───────────────────────────────────────────────────────────────
  typed.patch(
    "/api/metrics/:id",
    {
      schema: {
        description: "Atualiza uma metric entry existente (recalcula percent e points)",
        tags: ["metrics"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: patchMetricBodySchema,
        response: { 200: metricResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const existing = await app.prisma.metricEntry.findUnique({
        where: { id: req.params.id },
        include: { kpi: { include: { scoringRule: true } } },
      });
      if (!existing) {
        return reply.status(404).send({ error: "Métrica não encontrada" } as never);
      }

      const newRaw = req.body.rawValue ?? existing.rawValue;
      const newBase =
        req.body.baseValue === undefined ? existing.baseValue : req.body.baseValue;

      const activeGoal = await app.prisma.goal.findFirst({
        where: {
          kpiId: existing.kpiId,
          validFrom: { lte: existing.date },
          OR: [{ validTo: null }, { validTo: { gt: existing.date } }],
        },
        orderBy: { validFrom: "desc" },
      });

      const { convertedPercent, pointsAwarded } = computeMetricFields(
        existing.kpi,
        activeGoal,
        newRaw,
        newBase,
        existing.kpi.scoringRule && existing.kpi.scoringRule.active
          ? {
              ruleType: existing.kpi.scoringRule.ruleType,
              divisor: existing.kpi.scoringRule.divisor,
              pointsPerBucket: existing.kpi.scoringRule.pointsPerBucket,
              thresholdPct: existing.kpi.scoringRule.thresholdPct,
              thresholdPoints: existing.kpi.scoringRule.thresholdPoints,
            }
          : null,
      );

      const updated = await app.prisma.metricEntry.update({
        where: { id: req.params.id },
        data: {
          rawValue: newRaw,
          baseValue: newBase,
          convertedPercent,
          pointsAwarded,
          notes: req.body.notes === undefined ? existing.notes : req.body.notes,
        },
        include: { kpi: { select: { key: true } } },
      });
      return serializeMetric(updated);
    },
  );

  // ─── DELETE (admin only) ─────────────────────────────────────────────────
  typed.delete(
    "/api/metrics/:id",
    {
      schema: {
        description: "Remove uma metric entry (somente ADMIN)",
        tags: ["metrics"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 204: z.null() },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      if (req.user.role !== "ADMIN") {
        return reply.status(403).send({ error: "Apenas ADMIN pode deletar métricas" } as never);
      }
      try {
        await app.prisma.metricEntry.delete({ where: { id: req.params.id } });
      } catch {
        return reply.status(404).send({ error: "Métrica não encontrada" } as never);
      }
      reply.status(204);
      return null;
    },
  );

  // ─── LIST ────────────────────────────────────────────────────────────────
  typed.get(
    "/api/metrics",
    {
      schema: {
        description: "Lista metric entries com filtros (assessor, kpi, range de datas)",
        tags: ["metrics"],
        security: [{ bearerAuth: [] }],
        querystring: listQuerySchema,
        response: { 200: z.array(metricResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const { assessorId, kpiId, kpiKey, from, to } = req.query;

      const where: {
        assessorId?: string;
        kpiId?: string;
        kpi?: { key: string };
        date?: { gte?: Date; lte?: Date };
      } = {};
      if (assessorId) where.assessorId = assessorId;
      if (kpiId) where.kpiId = kpiId;
      if (kpiKey) where.kpi = { key: kpiKey };
      if (from || to) {
        where.date = {};
        if (from) where.date.gte = parseDateOnly(from);
        if (to) where.date.lte = parseDateOnly(to);
      }

      const rows = await app.prisma.metricEntry.findMany({
        where,
        include: { kpi: { select: { key: true } } },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        take: 500,
      });
      return rows.map(serializeMetric);
    },
  );
}
