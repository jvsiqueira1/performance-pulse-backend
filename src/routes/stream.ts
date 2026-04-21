import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eventBus } from "../services/eventBus.js";
import { corsOrigins } from "../env.js";

/**
 * Replica a lógica do plugin CORS pra este endpoint — precisamos adicionar
 * headers MANUALMENTE porque usamos reply.raw.writeHead() (SSE), que pula
 * todo o pipeline do Fastify incluindo o plugin @fastify/cors.
 */
function resolveCorsOrigin(req: FastifyRequest): string | null {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (corsOrigins.includes(origin)) return origin;
  try {
    if (/\.vercel\.app$/.test(new URL(origin).hostname)) return origin;
  } catch {
    /* origem malformada */
  }
  return null;
}

/**
 * SSE endpoint pra realtime updates no Modo TV.
 *
 * PÚBLICO — sem auth. O evento emitido é apenas "ranking:update" com
 * timestamp (nenhum dado sensível). O cliente usa isso como sinal pra
 * invalidar caches e re-fetch dos endpoints públicos de ranking.
 *
 * Consumido pela rota /tv (sem login) e pela rota / autenticada. O
 * parâmetro `token` é aceito mas opcional — preservado por compat com
 * a implementação anterior, que passava o JWT via query (EventSource
 * não suporta Authorization header).
 */
export default async function streamRoutes(app: FastifyInstance) {
  app.get(
    "/api/stream/rankings",
    {
      schema: {
        description:
          "SSE stream de ranking updates. PUBLIC — sem auth. " +
          "Conecte via EventSource. Emite 'ranking:update' com timestamp; cliente deve re-fetch.",
        tags: ["stream"],
        querystring: z.object({ token: z.string().optional() }),
      },
    },
    async (req, reply) => {
      // SSE headers + CORS manual (reply.raw pula o plugin @fastify/cors)
      const allowedOrigin = resolveCorsOrigin(req);
      const sseHeaders: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      };
      if (allowedOrigin) {
        sseHeaders["Access-Control-Allow-Origin"] = allowedOrigin;
        sseHeaders["Access-Control-Allow-Credentials"] = "true";
        sseHeaders["Vary"] = "Origin";
      }
      reply.raw.writeHead(200, sseHeaders);

      reply.raw.write(
        `event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`,
      );

      const heartbeat = setInterval(() => {
        reply.raw.write(`: heartbeat\n\n`);
      }, 15_000);

      const unsubscribeRanking = eventBus.onRankingUpdate(() => {
        reply.raw.write(
          `event: ranking:update\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`,
        );
      });

      const unsubscribeTournament = eventBus.onTournamentFinished((payload) => {
        reply.raw.write(
          `event: tournament:finished\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      });

      const unsubscribeGoalHit = eventBus.onGoalHit((payload) => {
        reply.raw.write(
          `event: goal:hit\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      });

      req.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribeRanking();
        unsubscribeTournament();
        unsubscribeGoalHit();
        app.log.info("SSE client disconnected");
      });
    },
  );
}
