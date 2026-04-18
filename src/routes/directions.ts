import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { parseDateOnly } from "../lib/dates.js";

const directionResponseSchema = z.object({
  id: z.string(),
  date: z.string(), // YYYY-MM-DD
  text: z.string(),
  createdById: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const upsertDirectionBodySchema = z.object({
  text: z.string().max(2000),
});

const dateParamsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function serializeDirection(d: {
  id: string;
  date: Date;
  text: string;
  createdById: string;
  createdBy: { name: string };
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: d.id,
    date: d.date.toISOString().slice(0, 10),
    text: d.text,
    createdById: d.createdById,
    createdByName: d.createdBy.name,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export default async function directionRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // GET — busca direcionamento de uma data específica
  typed.get(
    "/api/directions/:date",
    {
      schema: {
        description: "Busca o direcionamento diário pra uma data específica.",
        tags: ["directions"],
        security: [{ bearerAuth: [] }],
        params: dateParamsSchema,
        response: {
          200: directionResponseSchema,
          204: z.null(),
        },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const date = parseDateOnly(req.params.date);
      const direction = await app.prisma.dailyDirection.findUnique({
        where: { date },
        include: { createdBy: { select: { name: true } } },
      });
      if (!direction) {
        reply.status(204);
        return null;
      }
      return serializeDirection(direction);
    },
  );

  // PUT — upsert do direcionamento de uma data
  typed.put(
    "/api/directions/:date",
    {
      schema: {
        description:
          "Cria ou atualiza o direcionamento diário pra uma data. Texto vazio remove.",
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

      // Texto vazio = deletar (se existir)
      if (text.length === 0) {
        await app.prisma.dailyDirection
          .delete({ where: { date } })
          .catch(() => null);
        reply.status(204);
        return null;
      }

      const direction = await app.prisma.dailyDirection.upsert({
        where: { date },
        create: { date, text, createdById: userId },
        update: { text, createdById: userId },
        include: { createdBy: { select: { name: true } } },
      });
      return serializeDirection(direction);
    },
  );
}
