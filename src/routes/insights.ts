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

// Linha do histórico — inclui periodKey/periodKind pra diferenciar snapshots
// do mesmo período (cada inputHash distinto = nova linha).
const insightHistoryItemSchema = z.object({
  id: z.string(),
  textMarkdown: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  model: z.string(),
  periodKind: insightPeriodSchema,
  periodKey: z.string(),
  createdAt: z.string(),
});

const insightHistoryResponseSchema = z.object({
  items: z.array(insightHistoryItemSchema),
});

const historyQuerySchema = z.object({
  periodKind: insightPeriodSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
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
      const period = req.body.period;
      const periodKey = req.body.periodKey ?? defaultPeriodKey(period);

      // Rate limit só barra se o caller forçou regeneração (force=true).
      // Sem force, deixa passar — generateInsight vai retornar cache se houver
      // (sem custo de IA), ou gerar pela primeira vez. Antes barrava antes do
      // cache check, fazendo PDF/Apresentação dar 429 mesmo com cache disponível.
      if (req.body.force && now - last < RATE_LIMIT_MS) {
        const wait = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
        return reply.status(429).send({
          error: `Rate limit: aguarde ${wait}s antes de forçar regeneração`,
        } as never);
      }

      try {
        const result = await generateInsight(app, app.prisma, {
          assessorId: req.params.id,
          periodKind: period,
          periodKey,
          force: req.body.force,
        });

        // Marca rate limit só se realmente chamou o modelo (não cache)
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
      const period = req.body.period;
      const periodKey = req.body.periodKey ?? defaultPeriodKey(period);

      // Rate limit só barra se o caller forçou regeneração (force=true).
      // Sem force, deixa cache responder. Antes barrava antes do cache check
      // → PDF/Apresentação dava 429 logo após gerar análise no KpiAnalytics.
      if (req.body.force && now - last < RATE_LIMIT_MS) {
        const wait = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
        return reply.status(429).send({
          error: `Rate limit: aguarde ${wait}s antes de forçar regeneração`,
        } as never);
      }

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

  // ─── History endpoints ───────────────────────────────────────────────────
  // Cada inputHash distinto vira uma linha nova em AiInsight (constraint
  // única `assessorId+periodKind+periodKey+inputHash`). Esses endpoints
  // expõem essa timeline pra UI mostrar evolução do que a IA disse ao longo
  // do tempo. Sem rate limit — leitura pura.

  typed.get(
    "/api/insights/assessor/:id/history",
    {
      schema: {
        description:
          "Lista insights anteriores de um assessor (cronológico desc). " +
          "Filtra opcionalmente por periodKind. Limit default 10, max 50.",
        tags: ["insights"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        querystring: historyQuerySchema,
        response: { 200: insightHistoryResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const rows = await app.prisma.aiInsight.findMany({
        where: {
          assessorId: req.params.id,
          ...(req.query.periodKind ? { periodKind: req.query.periodKind } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: req.query.limit,
      });

      return {
        items: rows.map((r) => ({
          id: r.id,
          textMarkdown: r.textMarkdown,
          summary: r.summary,
          tags: r.tags,
          model: r.model,
          periodKind: r.periodKind as InsightPeriod,
          periodKey: r.periodKey,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  );

  typed.get(
    "/api/insights/team/history",
    {
      schema: {
        description:
          "Lista insights do TIME (assessorId=null, squadId=null) cronológico desc. " +
          "Filtra opcionalmente por periodKind. Limit default 10, max 50.",
        tags: ["insights"],
        security: [{ bearerAuth: [] }],
        querystring: historyQuerySchema,
        response: { 200: insightHistoryResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const rows = await app.prisma.aiInsight.findMany({
        where: {
          assessorId: null,
          squadId: null,
          ...(req.query.periodKind ? { periodKind: req.query.periodKind } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: req.query.limit,
      });

      return {
        items: rows.map((r) => ({
          id: r.id,
          textMarkdown: r.textMarkdown,
          summary: r.summary,
          tags: r.tags,
          model: r.model,
          periodKind: r.periodKind as InsightPeriod,
          periodKey: r.periodKey,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  );
}
