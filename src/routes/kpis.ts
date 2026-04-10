import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const kpiInputModeSchema = z.enum(["ABSOLUTE", "PERCENT", "QUANTITY_OVER_BASE"]);
const goalPeriodSchema = z.enum(["DAILY", "WEEKLY", "MONTHLY"]);

const activeGoalSchema = z
  .object({
    id: z.string(),
    value: z.number(),
    period: goalPeriodSchema,
    validFrom: z.string(),
    validTo: z.string().nullable(),
  })
  .nullable();

const kpiResponseSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  unit: z.string(),
  inputMode: kpiInputModeSchema,
  baseSource: z.string().nullable(),
  defaultTarget: z.number(),
  isDerived: z.boolean(),
  derivedFormula: z.string().nullable(),
  sortOrder: z.number(),
  active: z.boolean(),
  activeGoal: activeGoalSchema,
});

const updateKpiBodySchema = z.object({
  label: z.string().min(1).max(60).optional(),
  unit: z.string().max(10).optional(),
  inputMode: kpiInputModeSchema.optional(),
  baseSource: z.string().max(40).nullable().optional(),
  defaultTarget: z.number().optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

const listQuerySchema = z.object({
  active: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

type KpiRow = {
  id: string;
  key: string;
  label: string;
  unit: string;
  inputMode: string;
  baseSource: string | null;
  defaultTarget: number;
  isDerived: boolean;
  derivedFormula: string | null;
  sortOrder: number;
  active: boolean;
  goals: Array<{
    id: string;
    value: number;
    period: string;
    validFrom: Date;
    validTo: Date | null;
  }>;
};

function serializeKpi(row: KpiRow) {
  const activeGoalRow = row.goals[0] ?? null;
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    unit: row.unit,
    inputMode: row.inputMode as "ABSOLUTE" | "PERCENT" | "QUANTITY_OVER_BASE",
    baseSource: row.baseSource,
    defaultTarget: row.defaultTarget,
    isDerived: row.isDerived,
    derivedFormula: row.derivedFormula,
    sortOrder: row.sortOrder,
    active: row.active,
    activeGoal: activeGoalRow
      ? {
          id: activeGoalRow.id,
          value: activeGoalRow.value,
          period: activeGoalRow.period as "DAILY" | "WEEKLY" | "MONTHLY",
          validFrom: activeGoalRow.validFrom.toISOString(),
          validTo: activeGoalRow.validTo ? activeGoalRow.validTo.toISOString() : null,
        }
      : null,
  };
}

export default async function kpiRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // ─── LIST ────────────────────────────────────────────────────────────────
  typed.get(
    "/api/kpis",
    {
      schema: {
        description: "Lista KPIs com a goal ativa embutida",
        tags: ["kpis"],
        security: [{ bearerAuth: [] }],
        querystring: listQuerySchema,
        response: { 200: z.array(kpiResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const { active } = req.query;
      const rows = await app.prisma.kpi.findMany({
        where: active === undefined ? undefined : { active },
        orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
        include: {
          goals: {
            where: { validTo: null },
            orderBy: { validFrom: "desc" },
            take: 1,
          },
        },
      });
      return rows.map(serializeKpi);
    },
  );

  // ─── UPDATE ──────────────────────────────────────────────────────────────
  typed.patch(
    "/api/kpis/:id",
    {
      schema: {
        description: "Atualiza um KPI (label, unit, defaultTarget, ordem, ativo)",
        tags: ["kpis"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: updateKpiBodySchema,
        response: { 200: kpiResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      try {
        await app.prisma.kpi.update({
          where: { id: req.params.id },
          data: req.body,
        });
      } catch {
        return reply.status(404).send({ error: "KPI não encontrado" } as never);
      }
      const fresh = await app.prisma.kpi.findUniqueOrThrow({
        where: { id: req.params.id },
        include: {
          goals: {
            where: { validTo: null },
            orderBy: { validFrom: "desc" },
            take: 1,
          },
        },
      });
      return serializeKpi(fresh);
    },
  );
}
