import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import bcrypt from "bcryptjs";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const roleSchema = z.enum(["ADMIN", "MANAGER"]);

const userResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createUserBodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  password: z.string().min(8).max(100),
  role: roleSchema.optional(),
});

const updateUserBodySchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(8).max(100).optional(),
  role: roleSchema.optional(),
});

// ─── Serializer ──────────────────────────────────────────────────────────────

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
};

function serializeUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role as "ADMIN" | "MANAGER",
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

// ─── Helper: require admin ─────────────────────────────────────────────────

function ensureAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user.role !== "ADMIN") {
    reply.status(403).send({ error: "Apenas ADMIN pode gerenciar usuários" } as never);
    return false;
  }
  return true;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function userRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/users",
    {
      schema: {
        description: "Lista usuários do sistema (somente ADMIN)",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(userResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      if (!ensureAdmin(req, reply)) return;
      const rows = await app.prisma.user.findMany({
        orderBy: { createdAt: "asc" },
      });
      return rows.map(serializeUser);
    },
  );

  typed.get(
    "/api/users/:id",
    {
      schema: {
        description: "Busca um usuário por id (ADMIN)",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: userResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      if (!ensureAdmin(req, reply)) return;
      const row = await app.prisma.user.findUnique({ where: { id: req.params.id } });
      if (!row) return reply.status(404).send({ error: "Usuário não encontrado" } as never);
      return serializeUser(row);
    },
  );

  typed.post(
    "/api/users",
    {
      schema: {
        description: "Cria um novo usuário com senha hashada (ADMIN)",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        body: createUserBodySchema,
        response: { 201: userResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      if (!ensureAdmin(req, reply)) return;
      const { email, name, password, role } = req.body;

      const existing = await app.prisma.user.findUnique({ where: { email } });
      if (existing) {
        return reply.status(409).send({ error: "E-mail já cadastrado" } as never);
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const created = await app.prisma.user.create({
        data: {
          email,
          name,
          passwordHash,
          role: role ?? "ADMIN",
        },
      });
      reply.status(201);
      return serializeUser(created);
    },
  );

  typed.patch(
    "/api/users/:id",
    {
      schema: {
        description:
          "Atualiza usuário (ADMIN). Senha opcional — só atualiza se vier no body. Email tem check de unicidade.",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: updateUserBodySchema,
        response: { 200: userResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      if (!ensureAdmin(req, reply)) return;

      const { email, name, password, role } = req.body;

      // Check email unicidade se vier
      if (email) {
        const existing = await app.prisma.user.findUnique({ where: { email } });
        if (existing && existing.id !== req.params.id) {
          return reply.status(409).send({ error: "E-mail já cadastrado" } as never);
        }
      }

      const data: Record<string, unknown> = {};
      if (email !== undefined) data.email = email;
      if (name !== undefined) data.name = name;
      if (role !== undefined) data.role = role;
      if (password !== undefined) data.passwordHash = await bcrypt.hash(password, 10);

      try {
        const updated = await app.prisma.user.update({
          where: { id: req.params.id },
          data,
        });
        return serializeUser(updated);
      } catch {
        return reply.status(404).send({ error: "Usuário não encontrado" } as never);
      }
    },
  );

  typed.delete(
    "/api/users/:id",
    {
      schema: {
        description:
          "Deleta usuário (ADMIN). Proteção: não pode deletar a si mesmo.",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 204: z.null() },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      if (!ensureAdmin(req, reply)) return;

      if (req.user.sub === req.params.id) {
        return reply.status(400).send({ error: "Você não pode deletar a si mesmo" } as never);
      }

      try {
        await app.prisma.user.delete({ where: { id: req.params.id } });
      } catch {
        return reply.status(404).send({ error: "Usuário não encontrado" } as never);
      }
      reply.status(204);
      return null;
    },
  );
}
