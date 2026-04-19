import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eventBus } from "../services/eventBus.js";

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
      // SSE headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      reply.raw.write(
        `event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`,
      );

      const heartbeat = setInterval(() => {
        reply.raw.write(`: heartbeat\n\n`);
      }, 15_000);

      const unsubscribe = eventBus.onRankingUpdate(() => {
        reply.raw.write(
          `event: ranking:update\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`,
        );
      });

      req.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        app.log.info("SSE client disconnected");
      });
    },
  );
}
