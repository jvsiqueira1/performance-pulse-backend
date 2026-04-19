import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const announcementResponseSchema = z.object({
  id: z.string(),
  message: z.string(),
  emoji: z.string().nullable(),
  active: z.boolean(),
  expiresAt: z.string().nullable(),
  sortOrder: z.number(),
  createdById: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createBodySchema = z.object({
  message: z.string().min(1).max(500),
  emoji: z.string().max(8).nullable().optional(),
  active: z.boolean().optional().default(true),
  expiresAt: z.string().datetime().nullable().optional(),
  sortOrder: z.number().int().optional().default(0),
});

const updateBodySchema = z.object({
  message: z.string().min(1).max(500).optional(),
  emoji: z.string().max(8).nullable().optional(),
  active: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const listQuerySchema = z.object({
  // includeInactive=true retorna todos (admin); default só ativos não expirados
  includeInactive: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "true"),
});

function serialize(a: {
  id: string;
  message: string;
  emoji: string | null;
  active: boolean;
  expiresAt: Date | null;
  sortOrder: number;
  createdById: string;
  createdBy: { name: string };
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: a.id,
    message: a.message,
    emoji: a.emoji,
    active: a.active,
    expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
    sortOrder: a.sortOrder,
    createdById: a.createdById,
    createdByName: a.createdBy.name,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export default async function announcementRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // ─── LIST ────────────────────────────────────────────────────────────────
  typed.get(
    "/api/announcements",
    {
      schema: {
        description:
          "Lista avisos manuais. Default: só ativos e não expirados. ?includeInactive=true retorna todos (pra admin). PUBLIC — consumido pela rota /tv.",
        tags: ["announcements"],
        querystring: listQuerySchema,
        response: { 200: z.array(announcementResponseSchema) },
      },
      // Sem auth: usado pela TV pública (`/tv`). Avisos são projetados pra ser exibidos publicamente.
    },
    async (req) => {
      const includeInactive = req.query.includeInactive ?? false;
      const now = new Date();
      const rows = await app.prisma.announcement.findMany({
        where: includeInactive
          ? {}
          : {
              active: true,
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
        include: { createdBy: { select: { name: true } } },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      });
      return rows.map(serialize);
    },
  );

  // ─── CREATE ──────────────────────────────────────────────────────────────
  typed.post(
    "/api/announcements",
    {
      schema: {
        description: "Cria novo aviso pra rolar no ticker.",
        tags: ["announcements"],
        security: [{ bearerAuth: [] }],
        body: createBodySchema,
        response: { 201: announcementResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const created = await app.prisma.announcement.create({
        data: {
          message: req.body.message,
          emoji: req.body.emoji ?? null,
          active: req.body.active ?? true,
          expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
          sortOrder: req.body.sortOrder ?? 0,
          createdById: req.user.sub,
        },
        include: { createdBy: { select: { name: true } } },
      });
      reply.status(201);
      return serialize(created);
    },
  );

  // ─── UPDATE ──────────────────────────────────────────────────────────────
  typed.patch(
    "/api/announcements/:id",
    {
      schema: {
        description: "Atualiza um aviso (texto, emoji, active, expiração, ordem).",
        tags: ["announcements"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: updateBodySchema,
        response: { 200: announcementResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const data: Record<string, unknown> = { ...req.body };
      if (req.body.expiresAt !== undefined) {
        data.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
      }
      try {
        const updated = await app.prisma.announcement.update({
          where: { id: req.params.id },
          data,
          include: { createdBy: { select: { name: true } } },
        });
        return serialize(updated);
      } catch {
        return reply.status(404).send({ error: "Aviso não encontrado" } as never);
      }
    },
  );

  // ─── DELETE ──────────────────────────────────────────────────────────────
  typed.delete(
    "/api/announcements/:id",
    {
      schema: {
        description: "Remove um aviso.",
        tags: ["announcements"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 204: z.null() },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      try {
        await app.prisma.announcement.delete({ where: { id: req.params.id } });
      } catch {
        return reply.status(404).send({ error: "Aviso não encontrado" } as never);
      }
      reply.status(204);
      return null;
    },
  );
}
