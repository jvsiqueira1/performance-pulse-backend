import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  computeAssessorRollup,
  type MetricEntryForRollup,
} from "../services/scoring.js";
import {
  parseDateOnly,
  todayInAppTz,
  weekStart as getWeekStart,
  weekEnd as getWeekEnd,
} from "../lib/dates.js";

const rankingEntrySchema = z.object({
  assessor: z.object({
    id: z.string(),
    name: z.string(),
    initials: z.string(),
    photoUrl: z.string().nullable(),
    level: z.enum(["BRONZE", "SILVER", "GOLD"]),
  }),
  rollup: z.object({
    points: z.number(),
    weeklyGoalPercent: z.number(),
    streak: z.number(),
    kpiTotals: z.record(z.string(), z.number()),
    activeDays: z.array(z.string()),
  }),
});

const dailyRankingResponseSchema = z.object({
  date: z.string(),
  rankings: z.array(rankingEntrySchema),
});

const weeklyRankingResponseSchema = z.object({
  weekStart: z.string(),
  weekEnd: z.string(),
  rankings: z.array(rankingEntrySchema),
});

const dailyQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const weeklyQuerySchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export default async function rankingRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // ─── DAILY ───────────────────────────────────────────────────────────────
  typed.get(
    "/api/rankings/daily",
    {
      schema: {
        description:
          "Ranking do dia: lista assessores ativos ordenados por pontos do dia. Default: hoje (BRT).",
        tags: ["rankings"],
        security: [{ bearerAuth: [] }],
        querystring: dailyQuerySchema,
        response: { 200: dailyRankingResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const date = req.query.date ? parseDateOnly(req.query.date) : todayInAppTz();

      const assessors = await app.prisma.assessor.findMany({
        where: { active: true },
        include: {
          metricEntries: {
            where: { date },
            include: { kpi: { select: { key: true } } },
          },
        },
      });

      const rankings = assessors
        .map((a) => {
          const entries: MetricEntryForRollup[] = a.metricEntries;
          const rollup = computeAssessorRollup(entries, date);
          return {
            assessor: {
              id: a.id,
              name: a.name,
              initials: a.initials,
              photoUrl: a.photoUrl,
              level: a.level as "BRONZE" | "SILVER" | "GOLD",
            },
            rollup,
          };
        })
        .sort((a, b) => b.rollup.points - a.rollup.points);

      return {
        date: date.toISOString().slice(0, 10),
        rankings,
      };
    },
  );

  // ─── WEEKLY ──────────────────────────────────────────────────────────────
  typed.get(
    "/api/rankings/weekly",
    {
      schema: {
        description:
          "Ranking da semana: lista assessores ativos ordenados por pontos acumulados na semana (segunda→domingo). Default: semana corrente (BRT).",
        tags: ["rankings"],
        security: [{ bearerAuth: [] }],
        querystring: weeklyQuerySchema,
        response: { 200: weeklyRankingResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const reference = req.query.weekStart
        ? parseDateOnly(req.query.weekStart)
        : todayInAppTz();
      const start = getWeekStart(reference);
      const end = getWeekEnd(reference);

      const assessors = await app.prisma.assessor.findMany({
        where: { active: true },
        include: {
          metricEntries: {
            where: { date: { gte: start, lte: end } },
            include: { kpi: { select: { key: true } } },
          },
        },
      });

      const rankings = assessors
        .map((a) => {
          const entries: MetricEntryForRollup[] = a.metricEntries;
          // Usa end do range como referência (não today) pra que o daily e weekly
          // deem resultado consistente no primeiro dia da semana.
          const rollup = computeAssessorRollup(entries, end);
          return {
            assessor: {
              id: a.id,
              name: a.name,
              initials: a.initials,
              photoUrl: a.photoUrl,
              level: a.level as "BRONZE" | "SILVER" | "GOLD",
            },
            rollup,
          };
        })
        .sort((a, b) => b.rollup.points - a.rollup.points);

      return {
        weekStart: start.toISOString().slice(0, 10),
        weekEnd: end.toISOString().slice(0, 10),
        rankings,
      };
    },
  );
}
