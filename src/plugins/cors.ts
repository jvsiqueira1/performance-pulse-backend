import fp from "fastify-plugin";
import cors from "@fastify/cors";
import { corsOrigins } from "../env.js";

/**
 * CORS com suporte a:
 * - lista explícita via CORS_ORIGIN (separada por vírgula)
 * - regex automática pra previews da Vercel (*.vercel.app)
 * - localhost em dev
 */
export default fp(async (app) => {
  const vercelPreview = /\.vercel\.app$/;

  await app.register(cors, {
    origin: (origin, cb) => {
      // Requests sem origin (curl, server-to-server, health checks)
      if (!origin) return cb(null, true);

      if (corsOrigins.includes(origin)) return cb(null, true);
      if (vercelPreview.test(new URL(origin).hostname)) return cb(null, true);

      app.log.warn({ origin }, "CORS: origem bloqueada");
      return cb(new Error("Origem não permitida pelo CORS"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
});
