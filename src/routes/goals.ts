import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const goalPeriodSchema = z.enum(["DAILY", "WEEKLY", "MONTHLY"]);

const goalResponseSchema = z.object({
  id: z.string(),
  kpiId: z.string(),
  value: z.number(),
  period: goalPeriodSchema,
  validFrom: z.string(),
  validTo: z.string().nullable(),
  appliesRetroactively: z.boolean(),
  createdById: z.string(),
  createdAt: z.string(),
});

const createGoalBodySchema = z.object({
  kpiId: z.string().min(1),
  value: z.number().nonnegative(),
  period: goalPeriodSchema,
  validFrom: z.string().datetime().optional(),
  appliesRetroactively: z.boolean().optional(),
});

const listQuerySchema = z.object({
  kpiId: z.string().optional(),
  period: goalPeriodSchema.optional(),
  activeOn: z.string().datetime().optional(),
});

type GoalRow = {
  id: string;
  kpiId: string;
  value: number;
  period: string;
  validFrom: Date;
  validTo: Date | null;
  appliesRetroactively: boolean;
  createdById: string;
  createdAt: Date;
};

function serializeGoal(g: GoalRow) {
  return {
    id: g.id,
    kpiId: g.kpiId,
    value: g.value,
    period: g.period as "DAILY" | "WEEKLY" | "MONTHLY",
    validFrom: g.validFrom.toISOString(),
    validTo: g.validTo ? g.validTo.toISOString() : null,
    appliesRetroactively: g.appliesRetroactively,
    createdById: g.createdById,
    createdAt: g.createdAt.toISOString(),
  };
}

export default async function goalRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // ─── LIST ────────────────────────────────────────────────────────────────
  typed.get(
    "/api/goals",
    {
      schema: {
        description: "Lista goals (filtra por kpiId, period, data ativa)",
        tags: ["goals"],
        security: [{ bearerAuth: [] }],
        querystring: listQuerySchema,
        response: { 200: z.array(goalResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const { kpiId, period, activeOn } = req.query;

      const where: {
        kpiId?: string;
        period?: "DAILY" | "WEEKLY" | "MONTHLY";
        validFrom?: { lte: Date };
        OR?: Array<{ validTo: null } | { validTo: { gte: Date } }>;
      } = {};
      if (kpiId) where.kpiId = kpiId;
      if (period) where.period = period;
      if (activeOn) {
        const dt = new Date(activeOn);
        where.validFrom = { lte: dt };
        where.OR = [{ validTo: null }, { validTo: { gte: dt } }];
      }

      const rows = await app.prisma.goal.findMany({
        where,
        orderBy: [{ kpiId: "asc" }, { validFrom: "desc" }],
      });
      return rows.map(serializeGoal);
    },
  );

  // ─── CREATE (fecha goal anterior automaticamente) ────────────────────────
  typed.post(
    "/api/goals",
    {
      schema: {
        description:
          "Cria uma nova goal. Fecha automaticamente a goal ativa anterior (mesmo kpi+period) setando validTo = novo validFrom.",
        tags: ["goals"],
        security: [{ bearerAuth: [] }],
        body: createGoalBodySchema,
        response: { 201: goalResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { kpiId, value, period, validFrom, appliesRetroactively } = req.body;
      const validFromDate = validFrom ? new Date(validFrom) : new Date();
      const userId = req.user.sub;

      const kpi = await app.prisma.kpi.findUnique({ where: { id: kpiId } });
      if (!kpi) return reply.status(404).send({ error: "KPI não encontrado" } as never);

      const created = await app.prisma.$transaction(async (tx) => {
        await tx.goal.updateMany({
          where: { kpiId, period, validTo: null },
          data: { validTo: validFromDate },
        });
        return tx.goal.create({
          data: {
            kpiId,
            value,
            period,
            validFrom: validFromDate,
            appliesRetroactively: appliesRetroactively ?? false,
            createdById: userId,
          },
        });
      });

      reply.status(201);
      return serializeGoal(created);
    },
  );
}
