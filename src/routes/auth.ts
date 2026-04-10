import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import bcrypt from "bcryptjs";

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const userResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
});

const loginResponseSchema = z.object({
  token: z.string(),
  user: userResponseSchema,
});

export default async function authRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/api/auth/login",
    {
      schema: {
        description: "Login do gestor — retorna JWT",
        tags: ["auth"],
        body: loginBodySchema,
        response: { 200: loginResponseSchema },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;

      const user = await app.prisma.user.findUnique({ where: { email } });
      if (!user) {
        return reply.status(401).send({ error: "Credenciais inválidas" } as never);
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return reply.status(401).send({ error: "Credenciais inválidas" } as never);
      }

      const token = app.jwt.sign({ sub: user.id, role: user.role });

      return {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
    },
  );

  typed.get(
    "/api/auth/me",
    {
      schema: {
        description: "Retorna o usuário autenticado",
        tags: ["auth"],
        security: [{ bearerAuth: [] }],
        response: { 200: userResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const user = await app.prisma.user.findUniqueOrThrow({
        where: { id: req.user.sub },
      });

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      };
    },
  );
}
