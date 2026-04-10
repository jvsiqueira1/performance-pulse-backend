import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const squadMemberResponseSchema = z.object({
  assessorId: z.string(),
  name: z.string(),
  initials: z.string(),
  photoUrl: z.string().nullable(),
  level: z.enum(["BRONZE", "SILVER", "GOLD"]),
  isLeader: z.boolean(),
  joinedAt: z.string(),
});

const squadResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  emoji: z.string(),
  color: z.string(),
  leaderId: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  members: z.array(squadMemberResponseSchema),
});

const createSquadBodySchema = z.object({
  name: z.string().min(1).max(60),
  emoji: z.string().min(1).max(8),
  color: z.string().min(1).max(40),
  leaderId: z.string().min(1),
  memberIds: z.array(z.string()).min(1),
});

const updateSquadBodySchema = z.object({
  name: z.string().min(1).max(60).optional(),
  emoji: z.string().min(1).max(8).optional(),
  color: z.string().min(1).max(40).optional(),
  leaderId: z.string().optional(),
  active: z.boolean().optional(),
});

const listQuerySchema = z.object({
  active: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

const addMemberBodySchema = z.object({
  assessorId: z.string().min(1),
});

// ─── Serializer ──────────────────────────────────────────────────────────────

type SquadRowWithMembers = {
  id: string;
  name: string;
  emoji: string;
  color: string;
  leaderId: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  members: Array<{
    assessorId: string;
    joinedAt: Date;
    assessor: {
      name: string;
      initials: string;
      photoUrl: string | null;
      level: string;
    };
  }>;
};

function serializeSquad(row: SquadRowWithMembers) {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    leaderId: row.leaderId,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    members: row.members.map((m) => ({
      assessorId: m.assessorId,
      name: m.assessor.name,
      initials: m.assessor.initials,
      photoUrl: m.assessor.photoUrl,
      level: m.assessor.level as "BRONZE" | "SILVER" | "GOLD",
      isLeader: m.assessorId === row.leaderId,
      joinedAt: m.joinedAt.toISOString(),
    })),
  };
}

const squadInclude = {
  members: {
    where: { leftAt: null },
    include: {
      assessor: {
        select: {
          name: true,
          initials: true,
          photoUrl: true,
          level: true,
        },
      },
    },
  },
} as const;

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function squadRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/squads",
    {
      schema: {
        description: "Lista squads com membros ativos embutidos",
        tags: ["squads"],
        security: [{ bearerAuth: [] }],
        querystring: listQuerySchema,
        response: { 200: z.array(squadResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const { active } = req.query;
      const rows = await app.prisma.squad.findMany({
        where: active === undefined ? undefined : { active },
        orderBy: [{ active: "desc" }, { name: "asc" }],
        include: squadInclude,
      });
      return rows.map(serializeSquad);
    },
  );

  typed.post(
    "/api/squads",
    {
      schema: {
        description: "Cria uma nova squad com seus membros iniciais",
        tags: ["squads"],
        security: [{ bearerAuth: [] }],
        body: createSquadBodySchema,
        response: { 201: squadResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { name, emoji, color, leaderId, memberIds } = req.body;

      // Garante leader na lista de membros
      const uniqueMembers = Array.from(new Set([leaderId, ...memberIds]));

      const created = await app.prisma.$transaction(async (tx) => {
        const squad = await tx.squad.create({
          data: { name, emoji, color, leaderId },
        });
        for (const assessorId of uniqueMembers) {
          await tx.squadMember.create({
            data: { squadId: squad.id, assessorId },
          });
        }
        return tx.squad.findUniqueOrThrow({
          where: { id: squad.id },
          include: squadInclude,
        });
      });

      reply.status(201);
      return serializeSquad(created);
    },
  );

  typed.get(
    "/api/squads/:id",
    {
      schema: {
        description: "Busca uma squad por id",
        tags: ["squads"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: squadResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const row = await app.prisma.squad.findUnique({
        where: { id: req.params.id },
        include: squadInclude,
      });
      if (!row) return reply.status(404).send({ error: "Squad não encontrada" } as never);
      return serializeSquad(row);
    },
  );

  typed.patch(
    "/api/squads/:id",
    {
      schema: {
        description: "Atualiza uma squad (partial)",
        tags: ["squads"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: updateSquadBodySchema,
        response: { 200: squadResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      try {
        const updated = await app.prisma.squad.update({
          where: { id: req.params.id },
          data: req.body,
          include: squadInclude,
        });
        return serializeSquad(updated);
      } catch {
        return reply.status(404).send({ error: "Squad não encontrada" } as never);
      }
    },
  );

  typed.delete(
    "/api/squads/:id",
    {
      schema: {
        description: "Soft-delete (active=false)",
        tags: ["squads"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: squadResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      try {
        const updated = await app.prisma.squad.update({
          where: { id: req.params.id },
          data: { active: false },
          include: squadInclude,
        });
        return serializeSquad(updated);
      } catch {
        return reply.status(404).send({ error: "Squad não encontrada" } as never);
      }
    },
  );

  typed.post(
    "/api/squads/:id/members",
    {
      schema: {
        description: "Adiciona um assessor como membro da squad",
        tags: ["squads"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: addMemberBodySchema,
        response: { 201: squadResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { id } = req.params;
      const { assessorId } = req.body;

      const squad = await app.prisma.squad.findUnique({ where: { id } });
      if (!squad) return reply.status(404).send({ error: "Squad não encontrada" } as never);

      // Se já é membro ativo, no-op
      const existing = await app.prisma.squadMember.findFirst({
        where: { squadId: id, assessorId, leftAt: null },
      });
      if (!existing) {
        await app.prisma.squadMember.create({
          data: { squadId: id, assessorId },
        });
      }

      const fresh = await app.prisma.squad.findUniqueOrThrow({
        where: { id },
        include: squadInclude,
      });
      reply.status(201);
      return serializeSquad(fresh);
    },
  );

  typed.delete(
    "/api/squads/:id/members/:assessorId",
    {
      schema: {
        description: "Remove um membro da squad (soft: seta leftAt=now)",
        tags: ["squads"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string(), assessorId: z.string() }),
        response: { 200: squadResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { id, assessorId } = req.params;
      await app.prisma.squadMember.updateMany({
        where: { squadId: id, assessorId, leftAt: null },
        data: { leftAt: new Date() },
      });
      const fresh = await app.prisma.squad.findUnique({
        where: { id },
        include: squadInclude,
      });
      if (!fresh) return reply.status(404).send({ error: "Squad não encontrada" } as never);
      return serializeSquad(fresh);
    },
  );
}
