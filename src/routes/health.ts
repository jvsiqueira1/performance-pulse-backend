import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const healthResponseSchema = z.object({
  status: z.literal("ok"),
  uptime: z.number(),
  timestamp: z.string(),
});

const readyResponseSchema = z.object({
  status: z.literal("ok"),
  uptime: z.number(),
  timestamp: z.string(),
  db: z.enum(["ok", "error"]),
});

export default async function healthRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/health",
    {
      schema: {
        description: "Health check leve (não toca DB)",
        tags: ["health"],
        response: { 200: healthResponseSchema },
      },
    },
    async () => {
      return {
        status: "ok" as const,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };
    },
  );

  typed.get(
    "/api/health/ready",
    {
      schema: {
        description: "Readiness check — inclui status do Postgres",
        tags: ["health"],
        response: { 200: readyResponseSchema },
      },
    },
    async () => {
      let db: "ok" | "error" = "error";
      try {
        await app.prisma.$queryRaw`SELECT 1`;
        db = "ok";
      } catch {
        // db stays "error"
      }
      return {
        status: "ok" as const,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        db,
      };
    },
  );
}
