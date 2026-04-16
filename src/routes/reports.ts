import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  aggregateKpiSeries,
  buildOverview,
  buildAssessorReport,
  buildFunnelReport,
  buildActivityFeed,
} from "../services/reports.js";
import { parseDateOnly, todayInAppTz, weekStart, weekEnd } from "../lib/dates.js";

// ─── Shared schemas ──────────────────────────────────────────────────────────

const granularitySchema = z.enum(["day", "week", "month"]);

function resolveRange(fromStr?: string, toStr?: string): { from: Date; to: Date } {
  if (fromStr && toStr) {
    return { from: parseDateOnly(fromStr), to: parseDateOnly(toStr) };
  }
  const ref = todayInAppTz();
  return { from: weekStart(ref), to: weekEnd(ref) };
}

const dateRangeQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ─── KPI series schema ──────────────────────────────────────────────────────

const kpiSeriesBucketSchema = z.object({
  label: z.string(),
  displayLabel: z.string(),
  start: z.string(),
  end: z.string(),
  value: z.number(),
  target: z.number(),
  percentOfTarget: z.number(),
});

const kpiSeriesResponseSchema = z.object({
  kpi: z.object({ id: z.string(), key: z.string(), label: z.string(), unit: z.string() }),
  granularity: granularitySchema,
  from: z.string(),
  to: z.string(),
  buckets: z.array(kpiSeriesBucketSchema),
  total: z.number(),
  totalTarget: z.number(),
  overallPercent: z.number(),
});

const kpiSeriesQuerySchema = dateRangeQuerySchema.extend({
  kpiId: z.string().min(1),
  granularity: granularitySchema.default("day"),
  assessorId: z.string().optional(),
});

// ─── Overview schema ─────────────────────────────────────────────────────────

const overviewByKpiSchema = z.object({
  kpiId: z.string(),
  key: z.string(),
  label: z.string(),
  unit: z.string(),
  actual: z.number(),
  target: z.number(),
  percent: z.number(),
  series: z.array(z.object({ date: z.string(), value: z.number() })),
});

const overviewPerformerSchema = z.object({
  assessorId: z.string(),
  name: z.string(),
  initials: z.string(),
  points: z.number(),
  weeklyGoalPercent: z.number(),
});

const overviewResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  totalMetricEntries: z.number(),
  byKpi: z.array(overviewByKpiSchema),
  topPerformers: z.array(overviewPerformerSchema),
  bottomPerformers: z.array(overviewPerformerSchema),
  allPerformers: z.array(overviewPerformerSchema),
});

// ─── Assessor report schema ──────────────────────────────────────────────────

const assessorKpiHistorySchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.string(),
  total: z.number(),
  target: z.number(),
  percentOfTarget: z.number(),
  history: z.array(z.object({ date: z.string(), value: z.number() })),
});

const assessorReportResponseSchema = z.object({
  assessor: z.object({
    id: z.string(),
    name: z.string(),
    initials: z.string(),
    photoUrl: z.string().nullable(),
    level: z.enum(["BRONZE", "SILVER", "GOLD"]),
  }),
  from: z.string(),
  to: z.string(),
  kpis: z.array(assessorKpiHistorySchema),
  rollup: z.object({
    points: z.number(),
    weeklyGoalPercent: z.number(),
    streak: z.number(),
    kpiTotals: z.record(z.string(), z.number()),
    activeDays: z.array(z.string()),
  }),
  badgeUnlocks: z.array(
    z.object({
      id: z.string(),
      badgeId: z.string(),
      slug: z.string(),
      name: z.string(),
      icon: z.string(),
      scope: z.enum(["INDIVIDUAL", "SQUAD"]),
      periodKey: z.string(),
      unlockedAt: z.string(),
    }),
  ),
  observations: z.array(
    z.object({
      date: z.string(),
      notes: z.string(),
      kpiLabel: z.string(),
    }),
  ),
});

// ─── Funnel schema ───────────────────────────────────────────────────────────

const funnelResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  ligacoes: z.number(),
  reunioesAgendadas: z.number(),
  reunioesRealizadas: z.number(),
  fechamentos: z.number(),
  perdidas: z.number(),
  conversaoReuniao: z.number(),
  conversaoRealizacao: z.number(),
  conversaoFechamento: z.number(),
  ticketMedio: z.number(),
  ticketTotal: z.number(),
});

const funnelQuerySchema = dateRangeQuerySchema.extend({
  assessorId: z.string().optional(),
});

// ─── Activity feed schema ────────────────────────────────────────────────────

const activityFeedItemSchema = z.object({
  id: z.string(),
  type: z.enum(["metric", "badge_unlock", "observation", "meeting", "meeting_area"]),
  timestamp: z.string(),
  assessorId: z.string(),
  assessorName: z.string(),
  description: z.string(),
  icon: z.string(),
});

const activityFeedQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  assessorId: z.string().optional(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function reportRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/reports/kpi",
    {
      schema: {
        description: "Série temporal de um KPI com buckets (day/week/month)",
        tags: ["reports"],
        security: [{ bearerAuth: [] }],
        querystring: kpiSeriesQuerySchema,
        response: { 200: kpiSeriesResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const { from, to } = resolveRange(req.query.from, req.query.to);
      return aggregateKpiSeries(app.prisma, {
        kpiId: req.query.kpiId,
        from,
        to,
        granularity: req.query.granularity,
        assessorId: req.query.assessorId,
      });
    },
  );

  typed.get(
    "/api/reports/overview",
    {
      schema: {
        description: "Agregado global no período: byKpi + topPerformers + bottomPerformers",
        tags: ["reports"],
        security: [{ bearerAuth: [] }],
        querystring: dateRangeQuerySchema,
        response: { 200: overviewResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const { from, to } = resolveRange(req.query.from, req.query.to);
      return buildOverview(app.prisma, { from, to });
    },
  );

  typed.get(
    "/api/reports/assessor/:id",
    {
      schema: {
        description: "Perfil completo do assessor no período: histórico diário por KPI + rollup + badges",
        tags: ["reports"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        querystring: dateRangeQuerySchema,
        response: { 200: assessorReportResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { from, to } = resolveRange(req.query.from, req.query.to);
      const report = await buildAssessorReport(app.prisma, req.params.id, { from, to });
      if (!report) return reply.status(404).send({ error: "Assessor não encontrado" } as never);
      return report;
    },
  );

  typed.get(
    "/api/reports/funnel",
    {
      schema: {
        description:
          "Funil de conversão: ligações → reuniões agendadas → realizadas → fechamentos. Usa MetricEntry (ligações, reuniões) + MeetingOutcome (realizadas, fechamentos).",
        tags: ["reports"],
        security: [{ bearerAuth: [] }],
        querystring: funnelQuerySchema,
        response: { 200: funnelResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const { from, to } = resolveRange(req.query.from, req.query.to);
      return buildFunnelReport(app.prisma, { from, to, assessorId: req.query.assessorId });
    },
  );

  typed.get(
    "/api/reports/activity-feed",
    {
      schema: {
        description:
          "Feed de atividade recente: mistura de metric entries + badge unlocks ordenadas desc por timestamp",
        tags: ["reports"],
        security: [{ bearerAuth: [] }],
        querystring: activityFeedQuerySchema,
        response: { 200: z.array(activityFeedItemSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      return buildActivityFeed(app.prisma, {
        limit: req.query.limit,
        assessorId: req.query.assessorId,
      });
    },
  );
}
