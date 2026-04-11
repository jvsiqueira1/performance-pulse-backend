import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { generateInsight, generateTeamInsight, type InsightPeriod } from "../services/insightService.js";
import { format } from "date-fns";
import { todayInAppTz, weekStart } from "../lib/dates.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const insightPeriodSchema = z.enum(["DAY", "WEEK", "MONTH"]);

const insightResponseSchema = z.object({
  id: z.string(),
  textMarkdown: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  model: z.string(),
  cached: z.boolean(),
  createdAt: z.string(),
});

const generateBodySchema = z.object({
  period: insightPeriodSchema.default("WEEK"),
  periodKey: z.string().optional(),
  force: z.boolean().optional(),
});

const getQuerySchema = z.object({
  period: insightPeriodSchema.optional(),
  periodKey: z.string().optional(),
});

// ─── Rate limit simples em memória ──────────────────────────────────────────

const lastGeneration = new Map<string, number>(); // userId → timestamp
const RATE_LIMIT_MS = 60_000; // 1 por minuto

// ─── Helper: default periodKey ──────────────────────────────────────────────

function defaultPeriodKey(period: InsightPeriod): string {
  const ref = todayInAppTz();
  switch (period) {
    case "DAY":
      return ref.toISOString().slice(0, 10);
    case "WEEK":
      return format(weekStart(ref), "yyyy-'W'II");
    case "MONTH":
      return format(ref, "yyyy-MM");
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function insightRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/api/insights/assessor/:id",
    {
      schema: {
        description:
          "Gera insight de IA pro assessor. Retorna cache se dados não mudaram (inputHash match). " +
          "Use `force: true` pra forçar regeneração. Rate limit: 1 geração/min por admin.",
        tags: ["insights"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: generateBodySchema,
        response: { 200: insightResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const now = Date.now();
      const last = lastGeneration.get(userId) ?? 0;
      if (now - last < RATE_LIMIT_MS) {
        const wait = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
        return reply.status(429).send({
          error: `Rate limit: aguarde ${wait}s antes de gerar outro insight`,
        } as never);
      }

      const period = req.body.period;
      const periodKey = req.body.periodKey ?? defaultPeriodKey(period);

      try {
        const result = await generateInsight(app, app.prisma, {
          assessorId: req.params.id,
          periodKind: period,
          periodKey,
          force: req.body.force,
        });

        // Só marca rate limit se realmente chamou o modelo (não cache)
        if (!result.cached) {
          lastGeneration.set(userId, now);
        }

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Erro ao gerar insight";
        app.log.error({ err, assessorId: req.params.id }, "insight generation failed");
        return reply.status(500).send({ error: message } as never);
      }
    },
  );

  typed.get(
    "/api/insights/assessor/:id",
    {
      schema: {
        description: "Lê o insight mais recente do cache (sem gerar). Retorna 404 se não houver cache.",
        tags: ["insights"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        querystring: getQuerySchema,
        response: { 200: insightResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const period = req.query.period ?? "WEEK";
      const periodKey = req.query.periodKey ?? defaultPeriodKey(period);

      const cached = await app.prisma.aiInsight.findFirst({
        where: {
          assessorId: req.params.id,
          periodKind: period,
          periodKey,
        },
        orderBy: { createdAt: "desc" },
      });

      if (!cached) {
        return reply.status(404).send({ error: "Nenhum insight em cache pra este período" } as never);
      }

      return {
        id: cached.id,
        textMarkdown: cached.textMarkdown,
        summary: cached.summary,
        tags: cached.tags,
        model: cached.model,
        cached: true,
        createdAt: cached.createdAt.toISOString(),
      };
    },
  );

  // ─── Team insight ────────────────────────────────────────────────────────
  typed.post(
    "/api/insights/team",
    {
      schema: {
        description:
          "Gera insight de IA pra o TIME inteiro (visão geral). Cache por inputHash. Rate limit 1/min.",
        tags: ["insights"],
        security: [{ bearerAuth: [] }],
        body: generateBodySchema,
        response: { 200: insightResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const now = Date.now();
      const last = lastGeneration.get(userId) ?? 0;
      if (now - last < RATE_LIMIT_MS) {
        const wait = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
        return reply.status(429).send({
          error: `Rate limit: aguarde ${wait}s antes de gerar outro insight`,
        } as never);
      }

      const period = req.body.period;
      const periodKey = req.body.periodKey ?? defaultPeriodKey(period);

      try {
        const result = await generateTeamInsight(app, app.prisma, {
          periodKind: period,
          periodKey,
          force: req.body.force,
        });

        if (!result.cached) {
          lastGeneration.set(userId, now);
        }

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Erro ao gerar insight do time";
        app.log.error({ err }, "team insight generation failed");
        return reply.status(500).send({ error: message } as never);
      }
    },
  );
}
