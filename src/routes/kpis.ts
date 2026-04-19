import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const kpiInputModeSchema = z.enum(["ABSOLUTE", "PERCENT", "QUANTITY_OVER_BASE"]);
const goalPeriodSchema = z.enum(["DAILY", "WEEKLY", "MONTHLY"]);
const scoringRuleTypeSchema = z.enum(["LINEAR", "THRESHOLD_PERCENT"]);

const activeGoalSchema = z
  .object({
    id: z.string(),
    value: z.number(),
    period: goalPeriodSchema,
    validFrom: z.string(),
    validTo: z.string().nullable(),
  })
  .nullable();

const scoringRuleSchema = z
  .object({
    ruleType: scoringRuleTypeSchema,
    divisor: z.number().nullable(),
    pointsPerBucket: z.number().nullable(),
    thresholdPct: z.number().nullable(),
    thresholdPoints: z.number().nullable(),
    active: z.boolean(),
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
  scoringRule: scoringRuleSchema,
});

const upsertScoringRuleBodySchema = z
  .object({
    ruleType: scoringRuleTypeSchema,
    divisor: z.number().min(0).nullable().optional(),
    pointsPerBucket: z.number().nullable().optional(),
    thresholdPct: z.number().min(0).max(150).nullable().optional(),
    thresholdPoints: z.number().nullable().optional(),
    active: z.boolean().optional().default(true),
  })
  .refine(
    (v) =>
      v.ruleType !== "LINEAR" ||
      (v.divisor != null && v.divisor > 0 && v.pointsPerBucket != null),
    { message: "LINEAR requer divisor > 0 e pointsPerBucket" },
  )
  .refine(
    (v) =>
      v.ruleType !== "THRESHOLD_PERCENT" ||
      (v.thresholdPct != null && v.thresholdPoints != null),
    { message: "THRESHOLD_PERCENT requer thresholdPct e thresholdPoints" },
  );

const updateKpiBodySchema = z.object({
  label: z.string().min(1).max(60).optional(),
  unit: z.string().max(10).optional(),
  inputMode: kpiInputModeSchema.optional(),
  baseSource: z.string().max(40).nullable().optional(),
  defaultTarget: z.number().optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

const createKpiBodySchema = z.object({
  // key: identificador único interno (snake_case ou kebab-case sem espaços)
  key: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, "key deve ser snake_case (ex: ativacao_conta)"),
  label: z.string().min(1).max(60),
  unit: z.string().max(10).default(""),
  inputMode: kpiInputModeSchema.default("ABSOLUTE"),
  baseSource: z.string().max(40).nullable().optional(),
  defaultTarget: z.number().min(0).default(1),
  sortOrder: z.number().int().default(99),
  // Goal inicial opcional. Se omitida, KPI nasce sem meta ativa.
  goal: z
    .object({
      value: z.number().min(0),
      period: goalPeriodSchema,
    })
    .optional(),
  // Regra de pontuação inicial opcional. Se omitida, cai no fallback proporcional.
  scoringRule: z
    .object({
      ruleType: scoringRuleTypeSchema,
      divisor: z.number().min(0).nullable().optional(),
      pointsPerBucket: z.number().nullable().optional(),
      thresholdPct: z.number().min(0).max(150).nullable().optional(),
      thresholdPoints: z.number().nullable().optional(),
    })
    .optional(),
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
  scoringRule: {
    ruleType: string;
    divisor: number | null;
    pointsPerBucket: number | null;
    thresholdPct: number | null;
    thresholdPoints: number | null;
    active: boolean;
  } | null;
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
    scoringRule: row.scoringRule
      ? {
          ruleType: row.scoringRule.ruleType as "LINEAR" | "THRESHOLD_PERCENT",
          divisor: row.scoringRule.divisor,
          pointsPerBucket: row.scoringRule.pointsPerBucket,
          thresholdPct: row.scoringRule.thresholdPct,
          thresholdPoints: row.scoringRule.thresholdPoints,
          active: row.scoringRule.active,
        }
      : null,
  };
}

const KPI_INCLUDE = {
  goals: {
    where: { validTo: null },
    orderBy: { validFrom: "desc" as const },
    take: 1,
  },
  scoringRule: true,
} as const;

export default async function kpiRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // ─── LIST ────────────────────────────────────────────────────────────────
  typed.get(
    "/api/kpis",
    {
      schema: {
        description: "Lista KPIs com a goal ativa embutida. PUBLIC — consumido pela rota /tv.",
        tags: ["kpis"],
        querystring: listQuerySchema,
        response: { 200: z.array(kpiResponseSchema) },
      },
      // Sem auth: usado pela TV pública (`/tv`).
    },
    async (req) => {
      const { active } = req.query;
      const rows = await app.prisma.kpi.findMany({
        where: active === undefined ? undefined : { active },
        orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
        include: KPI_INCLUDE,
      });
      return rows.map(serializeKpi);
    },
  );

  // ─── CREATE ──────────────────────────────────────────────────────────────
  typed.post(
    "/api/kpis",
    {
      schema: {
        description: "Cria novo KPI. Opcionalmente já cria a goal ativa.",
        tags: ["kpis"],
        security: [{ bearerAuth: [] }],
        body: createKpiBodySchema,
        response: { 201: kpiResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { goal, scoringRule, ...kpiData } = req.body;
      // Verifica se key já existe
      const existing = await app.prisma.kpi.findUnique({
        where: { key: kpiData.key },
      });
      if (existing) {
        return reply.status(409).send({ error: "Já existe KPI com essa key" } as never);
      }

      const created = await app.prisma.kpi.create({
        data: {
          ...kpiData,
          baseSource: kpiData.baseSource ?? null,
        },
      });

      if (goal) {
        await app.prisma.goal.create({
          data: {
            kpiId: created.id,
            value: goal.value,
            period: goal.period,
            validFrom: new Date(),
            validTo: null,
            createdById: req.user.sub,
          },
        });
      }

      if (scoringRule) {
        await app.prisma.scoringRule.create({
          data: {
            kpiId: created.id,
            ruleType: scoringRule.ruleType,
            divisor: scoringRule.divisor ?? null,
            pointsPerBucket: scoringRule.pointsPerBucket ?? null,
            thresholdPct: scoringRule.thresholdPct ?? null,
            thresholdPoints: scoringRule.thresholdPoints ?? null,
          },
        });
      }

      const fresh = await app.prisma.kpi.findUniqueOrThrow({
        where: { id: created.id },
        include: KPI_INCLUDE,
      });

      reply.status(201);
      return serializeKpi(fresh);
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
        include: KPI_INCLUDE,
      });
      return serializeKpi(fresh);
    },
  );

  // ─── SCORING RULE: PUT (upsert) ─────────────────────────────────────────
  typed.put(
    "/api/kpis/:id/scoring-rule",
    {
      schema: {
        description:
          "Cria ou atualiza a regra de pontuação do KPI. Substitui POINTS_RULES hardcoded.",
        tags: ["kpis"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: upsertScoringRuleBodySchema,
        response: { 200: kpiResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const kpi = await app.prisma.kpi.findUnique({
        where: { id: req.params.id },
      });
      if (!kpi) {
        return reply.status(404).send({ error: "KPI não encontrado" } as never);
      }

      const data = {
        ruleType: req.body.ruleType,
        divisor: req.body.divisor ?? null,
        pointsPerBucket: req.body.pointsPerBucket ?? null,
        thresholdPct: req.body.thresholdPct ?? null,
        thresholdPoints: req.body.thresholdPoints ?? null,
        active: req.body.active ?? true,
      };

      await app.prisma.scoringRule.upsert({
        where: { kpiId: kpi.id },
        create: { kpiId: kpi.id, ...data },
        update: data,
      });

      const fresh = await app.prisma.kpi.findUniqueOrThrow({
        where: { id: req.params.id },
        include: KPI_INCLUDE,
      });
      return serializeKpi(fresh);
    },
  );
}
