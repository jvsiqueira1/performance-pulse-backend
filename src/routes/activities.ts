import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { parseDateOnly, todayInAppTz, formatDateOnly } from "../lib/dates.js";
import { isActivityActiveOn } from "../lib/biweekly.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const cadenceTypeSchema = z.enum(["WEEKLY", "BIWEEKLY"]);

const activityKpiResponseSchema = z.object({
  kpiId: z.string(),
  key: z.string(),
  label: z.string(),
  unit: z.string(),
  /** Target resolvido: targetOverride > activeGoal.value > Kpi.defaultTarget */
  target: z.number(),
  /** Raw override (null = usa goal/default). Útil pra UI admin da Fase 8. */
  targetOverride: z.number().nullable(),
});

const activityResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  dayOfWeek: z.number().int().min(1).max(5),
  startTime: z.string(),
  endTime: z.string(),
  cadenceType: cadenceTypeSchema,
  /** YYYY-MM-DD ou null */
  biweeklyAnchorDate: z.string().nullable(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  kpis: z.array(activityKpiResponseSchema),
});

const createActivityBodySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  dayOfWeek: z.number().int().min(1).max(5),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "HH:mm"),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, "HH:mm"),
  cadenceType: cadenceTypeSchema.optional(),
  biweeklyAnchorDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
    .nullable()
    .optional(),
  sortOrder: z.number().int().optional(),
});

const updateActivityBodySchema = createActivityBodySchema.partial().extend({
  active: z.boolean().optional(),
});

const listQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
    .optional(),
});

const attachKpiBodySchema = z.object({
  kpiId: z.string().min(1),
  targetOverride: z.number().nullable().optional(),
});

const updateKpiOverrideBodySchema = z.object({
  targetOverride: z.number().nullable(),
});

// ─── Tipos internos ──────────────────────────────────────────────────────────

type ActivityRowWithKpis = {
  id: string;
  name: string;
  description: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  cadenceType: string;
  biweeklyAnchorDate: Date | null;
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  kpis: Array<{
    targetOverride: number | null;
    kpi: {
      id: string;
      key: string;
      label: string;
      unit: string;
      defaultTarget: number;
      goals: Array<{ value: number }>;
    };
  }>;
};

function serializeActivity(row: ActivityRowWithKpis) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    dayOfWeek: row.dayOfWeek,
    startTime: row.startTime,
    endTime: row.endTime,
    cadenceType: row.cadenceType as "WEEKLY" | "BIWEEKLY",
    biweeklyAnchorDate: row.biweeklyAnchorDate ? formatDateOnly(row.biweeklyAnchorDate) : null,
    sortOrder: row.sortOrder,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    kpis: row.kpis.map((ak) => {
      const goalValue = ak.kpi.goals[0]?.value;
      const target = ak.targetOverride ?? goalValue ?? ak.kpi.defaultTarget;
      return {
        kpiId: ak.kpi.id,
        key: ak.kpi.key,
        label: ak.kpi.label,
        unit: ak.kpi.unit,
        target,
        targetOverride: ak.targetOverride,
      };
    }),
  };
}

/** Include payload reusado por todas as queries que retornam ActivityResponse. */
const activityInclude = {
  kpis: {
    include: {
      kpi: {
        include: {
          goals: {
            where: { validTo: null },
            orderBy: { validFrom: "desc" as const },
            take: 1,
          },
        },
      },
    },
  },
} as const;

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function activityRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/activities?date=YYYY-MM-DD — ativas no dia (resolve biweekly)
  typed.get(
    "/api/activities",
    {
      schema: {
        description:
          "Lista activities ativas em uma data específica (default: hoje BRT). Resolve biweekly automaticamente.",
        tags: ["activities"],
        security: [{ bearerAuth: [] }],
        querystring: listQuerySchema,
        response: { 200: z.array(activityResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const date = req.query.date ? parseDateOnly(req.query.date) : todayInAppTz();
      const dayOfWeek = date.getUTCDay(); // 0=dom, 1=seg, ..., 5=sex, 6=sab

      // Sábados/domingos retornam vazio (cronograma é seg-sex)
      if (dayOfWeek < 1 || dayOfWeek > 5) return [];

      const rows = await app.prisma.activity.findMany({
        where: { dayOfWeek, active: true },
        orderBy: [{ sortOrder: "asc" }, { startTime: "asc" }],
        include: activityInclude,
      });

      // Filtra biweekly em memória (não dá pra fazer a aritmética em SQL Prisma facilmente)
      return rows
        .filter((r) =>
          isActivityActiveOn(
            { cadenceType: r.cadenceType as "WEEKLY" | "BIWEEKLY", biweeklyAnchorDate: r.biweeklyAnchorDate },
            date,
          ),
        )
        .map(serializeActivity);
    },
  );

  // GET /api/activities/all — todas, inclusive inativas (admin)
  typed.get(
    "/api/activities/all",
    {
      schema: {
        description: "Lista TODAS as activities (inclusive inativas). Sem filtro biweekly. Pra admin UI.",
        tags: ["activities"],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(activityResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async () => {
      const rows = await app.prisma.activity.findMany({
        orderBy: [{ dayOfWeek: "asc" }, { sortOrder: "asc" }],
        include: activityInclude,
      });
      return rows.map(serializeActivity);
    },
  );

  // GET /api/activities/:id
  typed.get(
    "/api/activities/:id",
    {
      schema: {
        description: "Busca uma activity por id",
        tags: ["activities"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: activityResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const row = await app.prisma.activity.findUnique({
        where: { id: req.params.id },
        include: activityInclude,
      });
      if (!row) return reply.status(404).send({ error: "Activity não encontrada" } as never);
      return serializeActivity(row);
    },
  );

  // POST /api/activities
  typed.post(
    "/api/activities",
    {
      schema: {
        description: "Cria uma nova activity",
        tags: ["activities"],
        security: [{ bearerAuth: [] }],
        body: createActivityBodySchema,
        response: { 201: activityResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { biweeklyAnchorDate, ...rest } = req.body;
      const created = await app.prisma.activity.create({
        data: {
          ...rest,
          cadenceType: rest.cadenceType ?? "WEEKLY",
          biweeklyAnchorDate: biweeklyAnchorDate ? parseDateOnly(biweeklyAnchorDate) : null,
          sortOrder: rest.sortOrder ?? 0,
        },
        include: activityInclude,
      });
      reply.status(201);
      return serializeActivity(created);
    },
  );

  // PATCH /api/activities/:id
  typed.patch(
    "/api/activities/:id",
    {
      schema: {
        description: "Atualiza uma activity (partial update)",
        tags: ["activities"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: updateActivityBodySchema,
        response: { 200: activityResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { biweeklyAnchorDate, ...rest } = req.body;

      // Build data: só inclui biweeklyAnchorDate se vier no body (preserve null vs undefined)
      const data: Record<string, unknown> = { ...rest };
      if (biweeklyAnchorDate !== undefined) {
        data.biweeklyAnchorDate = biweeklyAnchorDate ? parseDateOnly(biweeklyAnchorDate) : null;
      }

      try {
        const updated = await app.prisma.activity.update({
          where: { id: req.params.id },
          data,
          include: activityInclude,
        });
        return serializeActivity(updated);
      } catch {
        return reply.status(404).send({ error: "Activity não encontrada" } as never);
      }
    },
  );

  // DELETE /api/activities/:id (soft delete)
  typed.delete(
    "/api/activities/:id",
    {
      schema: {
        description: "Soft-delete (marca active=false)",
        tags: ["activities"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: activityResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      try {
        const updated = await app.prisma.activity.update({
          where: { id: req.params.id },
          data: { active: false },
          include: activityInclude,
        });
        return serializeActivity(updated);
      } catch {
        return reply.status(404).send({ error: "Activity não encontrada" } as never);
      }
    },
  );

  // POST /api/activities/:id/kpis — anexar KPI
  typed.post(
    "/api/activities/:id/kpis",
    {
      schema: {
        description: "Anexa um KPI à activity (com targetOverride opcional)",
        tags: ["activities"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: attachKpiBodySchema,
        response: { 201: activityResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { id } = req.params;
      const { kpiId, targetOverride } = req.body;

      const activity = await app.prisma.activity.findUnique({ where: { id } });
      if (!activity) return reply.status(404).send({ error: "Activity não encontrada" } as never);

      const kpi = await app.prisma.kpi.findUnique({ where: { id: kpiId } });
      if (!kpi) return reply.status(404).send({ error: "KPI não encontrado" } as never);

      await app.prisma.activityKpi.upsert({
        where: { activityId_kpiId: { activityId: id, kpiId } },
        update: { targetOverride: targetOverride ?? null },
        create: { activityId: id, kpiId, targetOverride: targetOverride ?? null },
      });

      const fresh = await app.prisma.activity.findUniqueOrThrow({
        where: { id },
        include: activityInclude,
      });
      reply.status(201);
      return serializeActivity(fresh);
    },
  );

  // PATCH /api/activities/:id/kpis/:kpiId — atualiza override
  typed.patch(
    "/api/activities/:id/kpis/:kpiId",
    {
      schema: {
        description: "Atualiza targetOverride de um ActivityKpi",
        tags: ["activities"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string(), kpiId: z.string() }),
        body: updateKpiOverrideBodySchema,
        response: { 200: activityResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { id, kpiId } = req.params;
      try {
        await app.prisma.activityKpi.update({
          where: { activityId_kpiId: { activityId: id, kpiId } },
          data: { targetOverride: req.body.targetOverride },
        });
      } catch {
        return reply.status(404).send({ error: "ActivityKpi não encontrado" } as never);
      }
      const fresh = await app.prisma.activity.findUniqueOrThrow({
        where: { id },
        include: activityInclude,
      });
      return serializeActivity(fresh);
    },
  );

  // DELETE /api/activities/:id/kpis/:kpiId — desanexa
  typed.delete(
    "/api/activities/:id/kpis/:kpiId",
    {
      schema: {
        description: "Remove um KPI da activity",
        tags: ["activities"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string(), kpiId: z.string() }),
        response: { 204: z.null() },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { id, kpiId } = req.params;
      try {
        await app.prisma.activityKpi.delete({
          where: { activityId_kpiId: { activityId: id, kpiId } },
        });
      } catch {
        return reply.status(404).send({ error: "ActivityKpi não encontrado" } as never);
      }
      reply.status(204);
      return null;
    },
  );
}
