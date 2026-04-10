import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eventBus } from "../services/eventBus.js";

/**
 * SSE endpoint pra realtime updates no Modo TV.
 *
 * EventSource não suporta Authorization header, então aceita token via
 * query param. A autenticação é feita manualmente (não usa app.authenticate
 * decorator porque ele roda em onRequest antes de podermos copiar o token).
 */
export default async function streamRoutes(app: FastifyInstance) {
  app.get(
    "/api/stream/rankings",
    {
      schema: {
        description:
          "SSE stream de ranking updates. Conecte via EventSource com ?token=xxx.",
        tags: ["stream"],
        querystring: z.object({ token: z.string().min(1) }),
      },
      // Auth manual — não usa app.authenticate porque EventSource não manda header
      onRequest: [
        async (req, reply) => {
          const token = (req.query as { token?: string }).token;
          if (!token) {
            return reply.status(401).send({ error: "Token ausente" } as never);
          }
          // Inject header pra que jwtVerify funcione
          req.headers.authorization = `Bearer ${token}`;
          try {
            await req.jwtVerify();
          } catch {
            return reply.status(401).send({ error: "Token inválido" } as never);
          }
        },
      ],
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
