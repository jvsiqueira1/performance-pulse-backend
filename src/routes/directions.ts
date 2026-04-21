import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { parseDateOnly } from "../lib/dates.js";
import { computeDirectionCompliance } from "../services/directionCompliance.js";

const directionPeriodSchema = z.enum(["DAILY", "WEEKLY", "MONTHLY"]);
const directionStatusSchema = z.enum(["PENDING", "ACHIEVED", "PARTIAL", "MISSED"]);

const kpiComplianceSchema = z.object({
  kpiKey: z.string(),
  realized: z.number(),
  baseline: z.number(),
  deltaPct: z.number().nullable(),
});

const directionResponseSchema = z.object({
  id: z.string(),
  date: z.string(),
  text: z.string(),
  period: directionPeriodSchema,
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  targetKpiKeys: z.array(z.string()),
  status: directionStatusSchema,
  reviewNote: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewedById: z.string().nullable(),
  reviewedByName: z.string().nullable(),
  createdById: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const directionWithComplianceSchema = directionResponseSchema.extend({
  compliance: z.array(kpiComplianceSchema),
});

const upsertDirectionBodySchema = z.object({
  text: z.string().max(2000),
  // Campos novos opcionais — chamadas legadas continuam funcionando
  period: directionPeriodSchema.optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  targetKpiKeys: z.array(z.string()).optional(),
});

const reviewBodySchema = z.object({
  status: directionStatusSchema,
  reviewNote: z.string().max(1000).optional(),
});

const dateParamsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const idParamsSchema = z.object({
  id: z.string(),
});

const complianceQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  period: directionPeriodSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type DirectionRow = {
  id: string;
  date: Date;
  text: string;
  period: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  targetKpiKeys: string[];
  status: string;
  reviewNote: string | null;
  reviewedAt: Date | null;
  reviewedById: string | null;
  reviewedBy: { name: string } | null;
  createdById: string;
  createdBy: { name: string };
  createdAt: Date;
  updatedAt: Date;
};

function serializeDirection(d: DirectionRow) {
  return {
    id: d.id,
    date: d.date.toISOString().slice(0, 10),
    text: d.text,
    period: d.period as "DAILY" | "WEEKLY" | "MONTHLY",
    periodStart: d.periodStart ? d.periodStart.toISOString().slice(0, 10) : null,
    periodEnd: d.periodEnd ? d.periodEnd.toISOString().slice(0, 10) : null,
    targetKpiKeys: d.targetKpiKeys,
    status: d.status as "PENDING" | "ACHIEVED" | "PARTIAL" | "MISSED",
    reviewNote: d.reviewNote,
    reviewedAt: d.reviewedAt ? d.reviewedAt.toISOString() : null,
    reviewedById: d.reviewedById,
    reviewedByName: d.reviewedBy?.name ?? null,
    createdById: d.createdById,
    createdByName: d.createdBy.name,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

const directionInclude = {
  createdBy: { select: { name: true } },
  reviewedBy: { select: { name: true } },
} as const;

export default async function directionRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // GET — busca direcionamento de uma data específica.
  // PUBLIC: consumido pela rota /tv (sem login) via AnnouncementTicker +
  // useWeekDirections. Direcionamento é basicamente um aviso de foco do
  // dia — mesma natureza de announcements, que já é público.
  typed.get(
    "/api/directions/:date",
    {
      schema: {
        description:
          "Busca o direcionamento pra uma data específica. PUBLIC — consumido pela /tv.",
        tags: ["directions"],
        params: dateParamsSchema,
        response: {
          200: directionResponseSchema,
          204: z.null(),
        },
      },
      // Sem auth: usado pela TV pública.
    },
    async (req, reply) => {
      const date = parseDateOnly(req.params.date);
      const direction = await app.prisma.dailyDirection.findUnique({
        where: { date },
        include: directionInclude,
      });
      if (!direction) {
        reply.status(204);
        return null;
      }
      return serializeDirection(direction);
    },
  );

  // PUT — upsert do direcionamento de uma data (aceita campos novos opcionais)
  typed.put(
    "/api/directions/:date",
    {
      schema: {
        description:
          "Cria ou atualiza direcionamento pra uma data. Suporta period (DAILY/WEEKLY/MONTHLY), periodStart/End, targetKpiKeys. Texto vazio remove.",
        tags: ["directions"],
        security: [{ bearerAuth: [] }],
        params: dateParamsSchema,
        body: upsertDirectionBodySchema,
        response: {
          200: directionResponseSchema,
          204: z.null(),
        },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const date = parseDateOnly(req.params.date);
      const text = req.body.text.trim();
      const userId = req.user.sub;

      if (text.length === 0) {
        await app.prisma.dailyDirection
          .delete({ where: { date } })
          .catch(() => null);
        reply.status(204);
        return null;
      }

      const periodStart = req.body.periodStart ? parseDateOnly(req.body.periodStart) : null;
      const periodEnd = req.body.periodEnd ? parseDateOnly(req.body.periodEnd) : null;
      const period = req.body.period ?? "DAILY";
      const targetKpiKeys = req.body.targetKpiKeys ?? [];

      const direction = await app.prisma.dailyDirection.upsert({
        where: { date },
        create: {
          date,
          text,
          period,
          periodStart,
          periodEnd,
          targetKpiKeys,
          createdById: userId,
        },
        update: {
          text,
          period,
          periodStart,
          periodEnd,
          targetKpiKeys,
          createdById: userId,
        },
        include: directionInclude,
      });
      return serializeDirection(direction);
    },
  );

  // PATCH — admin marca status de cumprimento
  typed.patch(
    "/api/directions/:id/review",
    {
      schema: {
        description:
          "Admin marca status de cumprimento (ACHIEVED/PARTIAL/MISSED) + nota opcional.",
        tags: ["directions"],
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: reviewBodySchema,
        response: { 200: directionResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const direction = await app.prisma.dailyDirection
        .update({
          where: { id: req.params.id },
          data: {
            status: req.body.status,
            reviewNote: req.body.reviewNote ?? null,
            reviewedAt: new Date(),
            reviewedById: userId,
          },
          include: directionInclude,
        })
        .catch(() => null);

      if (!direction) {
        return reply.status(404).send({ error: "Direction não encontrada" } as never);
      }
      return serializeDirection(direction);
    },
  );

  // GET — lista directions com compliance (cumprimento medido)
  typed.get(
    "/api/directions/compliance",
    {
      schema: {
        description:
          "Lista directions ordenadas por data desc com cumprimento dos targetKpiKeys (delta vs período anterior).",
        tags: ["directions"],
        security: [{ bearerAuth: [] }],
        querystring: complianceQuerySchema,
        response: { 200: z.array(directionWithComplianceSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const where: {
        date?: { gte?: Date; lte?: Date };
        period?: "DAILY" | "WEEKLY" | "MONTHLY";
      } = {};
      if (req.query.from) where.date = { ...where.date, gte: parseDateOnly(req.query.from) };
      if (req.query.to) where.date = { ...where.date, lte: parseDateOnly(req.query.to) };
      if (req.query.period) where.period = req.query.period;

      const directions = await app.prisma.dailyDirection.findMany({
        where,
        orderBy: { date: "desc" },
        take: req.query.limit,
        include: directionInclude,
      });

      const out = await Promise.all(
        directions.map(async (d) => ({
          ...serializeDirection(d),
          compliance: await computeDirectionCompliance(app.prisma, d),
        })),
      );

      return out;
    },
  );
}
