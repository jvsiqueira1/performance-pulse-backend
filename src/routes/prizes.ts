import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const prizeResponseSchema = z.object({
  id: z.string(),
  assessorId: z.string(),
  assessorName: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  period: z.string(),
  awardedById: z.string(),
  awardedByName: z.string(),
  createdAt: z.string(),
});

const createPrizeBodySchema = z.object({
  assessorId: z.string().min(1),
  title: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  period: z.string().min(1).max(20),
});

const listQuerySchema = z.object({
  assessorId: z.string().optional(),
  period: z.string().optional(),
});

type PrizeRow = {
  id: string;
  assessorId: string;
  title: string;
  description: string | null;
  period: string;
  awardedById: string;
  createdAt: Date;
  assessor: { name: string };
  awardedBy: { name: string };
};

function serializePrize(r: PrizeRow) {
  return {
    id: r.id,
    assessorId: r.assessorId,
    assessorName: r.assessor.name,
    title: r.title,
    description: r.description,
    period: r.period,
    awardedById: r.awardedById,
    awardedByName: r.awardedBy.name,
    createdAt: r.createdAt.toISOString(),
  };
}

const prizeInclude = {
  assessor: { select: { name: true } },
  awardedBy: { select: { name: true } },
} as const;

export default async function prizeRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/prizes",
    {
      schema: {
        description: "Lista premiações individuais",
        tags: ["prizes"],
        security: [{ bearerAuth: [] }],
        querystring: listQuerySchema,
        response: { 200: z.array(prizeResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const { assessorId, period } = req.query;
      const rows = await app.prisma.prize.findMany({
        where: {
          ...(assessorId ? { assessorId } : {}),
          ...(period ? { period } : {}),
        },
        include: prizeInclude,
        orderBy: { createdAt: "desc" },
      });
      return rows.map(serializePrize);
    },
  );

  typed.post(
    "/api/prizes",
    {
      schema: {
        description: "Cria uma premiação individual (ADMIN)",
        tags: ["prizes"],
        security: [{ bearerAuth: [] }],
        body: createPrizeBodySchema,
        response: { 201: prizeResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      if (req.user.role !== "ADMIN") {
        return reply.status(403).send({ error: "Apenas ADMIN pode criar premiações" } as never);
      }
      const assessor = await app.prisma.assessor.findUnique({ where: { id: req.body.assessorId } });
      if (!assessor) return reply.status(404).send({ error: "Assessor não encontrado" } as never);

      const created = await app.prisma.prize.create({
        data: {
          assessorId: req.body.assessorId,
          title: req.body.title,
          description: req.body.description ?? null,
          period: req.body.period,
          awardedById: req.user.sub,
        },
        include: prizeInclude,
      });
      reply.status(201);
      return serializePrize(created);
    },
  );

  typed.delete(
    "/api/prizes/:id",
    {
      schema: {
        description: "Remove uma premiação (ADMIN)",
        tags: ["prizes"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 204: z.null() },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      if (req.user.role !== "ADMIN") {
        return reply.status(403).send({ error: "Apenas ADMIN pode remover premiações" } as never);
      }
      try {
        await app.prisma.prize.delete({ where: { id: req.params.id } });
      } catch {
        return reply.status(404).send({ error: "Premiação não encontrada" } as never);
      }
      reply.status(204);
      return null;
    },
  );
}
