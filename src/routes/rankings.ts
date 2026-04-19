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
  monthStart as getMonthStart,
  monthEnd as getMonthEnd,
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
    penaltyPoints: z.number(),
    penaltyDays: z.number(),
  }),
});

const dailyRankingResponseSchema = z.object({
  date: z.string(),
  rankings: z.array(rankingEntrySchema),
});

const periodRankingResponseSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
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

const monthlyQuerySchema = z.object({
  monthStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const semesterQuerySchema = z.object({
  semesterStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Calcula início e fim do semestre que contém a data referência.
 * Janeiro–Junho → S1, Julho–Dezembro → S2.
 */
function semesterRange(reference: Date): { start: Date; end: Date } {
  const year = reference.getUTCFullYear();
  const month = reference.getUTCMonth(); // 0-indexed
  const isFirstHalf = month < 6;
  const start = new Date(Date.UTC(year, isFirstHalf ? 0 : 6, 1));
  const end = new Date(Date.UTC(year, isFirstHalf ? 5 : 11, isFirstHalf ? 30 : 31));
  return { start, end };
}

interface RankingEntry {
  assessor: {
    id: string;
    name: string;
    initials: string;
    photoUrl: string | null;
    level: "BRONZE" | "SILVER" | "GOLD";
  };
  rollup: ReturnType<typeof computeAssessorRollup>;
}

/**
 * Sort do ranking com zero-guard.
 *
 * Bug que isso fixa: quando todos têm 0 pontos (início do mês/semana sem
 * registros ainda), o tie-break caía no localeCompare(name) e quem tinha
 * nome alfabeticamente primeiro virava "líder" — sugestão visual
 * enganosa. Agora "inativo" (0 pts E 0 dias ativos) vai pro fim sempre,
 * antes de qualquer tie-break.
 */
function sortByRanking(a: RankingEntry, b: RankingEntry): number {
  const aInactive = a.rollup.points === 0 && a.rollup.activeDays.length === 0;
  const bInactive = b.rollup.points === 0 && b.rollup.activeDays.length === 0;
  if (aInactive !== bInactive) return aInactive ? 1 : -1;

  if (b.rollup.points !== a.rollup.points) {
    return b.rollup.points - a.rollup.points;
  }
  if (b.rollup.weeklyGoalPercent !== a.rollup.weeklyGoalPercent) {
    return b.rollup.weeklyGoalPercent - a.rollup.weeklyGoalPercent;
  }
  if (b.rollup.streak !== a.rollup.streak) {
    return b.rollup.streak - a.rollup.streak;
  }
  return a.assessor.name.localeCompare(b.assessor.name);
}

/**
 * Constrói ranking pra um range de datas. Reutilizado por weekly, monthly
 * e semester (daily usa lógica própria pra otimizar query single-date).
 */
async function buildRangeRanking(
  app: FastifyInstance,
  start: Date,
  end: Date,
): Promise<RankingEntry[]> {
  const assessors = await app.prisma.assessor.findMany({
    where: {
      active: true,
      // Esconde quem está em férias durante TODO o período (vacationUntil >= end)
      OR: [{ vacationUntil: null }, { vacationUntil: { lt: end } }],
    },
    include: {
      metricEntries: {
        where: { date: { gte: start, lte: end } },
        include: { kpi: { select: { key: true } } },
      },
    },
  });

  return assessors
    .map((a) => {
      const entries: MetricEntryForRollup[] = a.metricEntries;
      // Usa end do range como referência pra rollup ficar consistente
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
    .sort(sortByRanking);
}

export default async function rankingRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // ─── DAILY ───────────────────────────────────────────────────────────────
  typed.get(
    "/api/rankings/daily",
    {
      schema: {
        description:
          "Ranking do dia: lista assessores ativos ordenados por pontos do dia. Default: hoje (BRT). PUBLIC — consumido pela rota /tv.",
        tags: ["rankings"],
        querystring: dailyQuerySchema,
        response: { 200: dailyRankingResponseSchema },
      },
      // Sem auth: usado pela TV pública (`/tv`) na sala de vendas.
    },
    async (req) => {
      const date = req.query.date ? parseDateOnly(req.query.date) : todayInAppTz();

      const assessors = await app.prisma.assessor.findMany({
        where: {
          active: true,
          OR: [{ vacationUntil: null }, { vacationUntil: { lt: date } }],
        },
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
        .sort(sortByRanking);

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
          "Ranking da semana: lista assessores ativos ordenados por pontos acumulados na semana (segunda→domingo). Default: semana corrente (BRT). PUBLIC — consumido pela rota /tv.",
        tags: ["rankings"],
        querystring: weeklyQuerySchema,
        response: { 200: weeklyRankingResponseSchema },
      },
    },
    async (req) => {
      const reference = req.query.weekStart
        ? parseDateOnly(req.query.weekStart)
        : todayInAppTz();
      const start = getWeekStart(reference);
      const end = getWeekEnd(reference);

      const rankings = await buildRangeRanking(app, start, end);

      return {
        weekStart: start.toISOString().slice(0, 10),
        weekEnd: end.toISOString().slice(0, 10),
        rankings,
      };
    },
  );

  // ─── MONTHLY ─────────────────────────────────────────────────────────────
  typed.get(
    "/api/rankings/monthly",
    {
      schema: {
        description:
          "Ranking do mês: assessores ativos ordenados por pontos do mês corrente (ou de monthStart). PUBLIC.",
        tags: ["rankings"],
        querystring: monthlyQuerySchema,
        response: { 200: periodRankingResponseSchema },
      },
    },
    async (req) => {
      const reference = req.query.monthStart
        ? parseDateOnly(req.query.monthStart)
        : todayInAppTz();
      const start = getMonthStart(reference);
      const end = getMonthEnd(reference);

      const rankings = await buildRangeRanking(app, start, end);

      return {
        periodStart: start.toISOString().slice(0, 10),
        periodEnd: end.toISOString().slice(0, 10),
        rankings,
      };
    },
  );

  // ─── SEMESTER ────────────────────────────────────────────────────────────
  typed.get(
    "/api/rankings/semester",
    {
      schema: {
        description:
          "Ranking do semestre: 6 meses (jan-jun ou jul-dez baseado em semesterStart ou hoje). PUBLIC.",
        tags: ["rankings"],
        querystring: semesterQuerySchema,
        response: { 200: periodRankingResponseSchema },
      },
    },
    async (req) => {
      const reference = req.query.semesterStart
        ? parseDateOnly(req.query.semesterStart)
        : todayInAppTz();
      const { start, end } = semesterRange(reference);

      const rankings = await buildRangeRanking(app, start, end);

      return {
        periodStart: start.toISOString().slice(0, 10),
        periodEnd: end.toISOString().slice(0, 10),
        rankings,
      };
    },
  );
}
