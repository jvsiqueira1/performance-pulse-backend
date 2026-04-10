import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { env } from "../env.js";

const assessorLevelSchema = z.enum(["BRONZE", "SILVER", "GOLD"]);

const assessorResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  initials: z.string(),
  photoUrl: z.string().nullable(),
  level: assessorLevelSchema,
  active: z.boolean(),
  hiredAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createAssessorBodySchema = z.object({
  name: z.string().min(1).max(120),
  initials: z.string().min(1).max(4).optional(),
  level: assessorLevelSchema.optional(),
});

const updateAssessorBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  initials: z.string().min(1).max(4).optional(),
  level: assessorLevelSchema.optional(),
  active: z.boolean().optional(),
});

const listQuerySchema = z.object({
  active: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase();
}

function serializeAssessor(a: {
  id: string;
  name: string;
  initials: string;
  photoUrl: string | null;
  level: string;
  active: boolean;
  hiredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: a.id,
    name: a.name,
    initials: a.initials,
    photoUrl: a.photoUrl,
    level: a.level as "BRONZE" | "SILVER" | "GOLD",
    active: a.active,
    hiredAt: a.hiredAt.toISOString(),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export default async function assessorRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // ─── LIST ────────────────────────────────────────────────────────────────
  typed.get(
    "/api/assessors",
    {
      schema: {
        description: "Lista assessores",
        tags: ["assessors"],
        security: [{ bearerAuth: [] }],
        querystring: listQuerySchema,
        response: { 200: z.array(assessorResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const { active } = req.query;
      const rows = await app.prisma.assessor.findMany({
        where: active === undefined ? undefined : { active },
        orderBy: [{ active: "desc" }, { name: "asc" }],
      });
      return rows.map(serializeAssessor);
    },
  );

  // ─── CREATE ──────────────────────────────────────────────────────────────
  typed.post(
    "/api/assessors",
    {
      schema: {
        description: "Cria um novo assessor",
        tags: ["assessors"],
        security: [{ bearerAuth: [] }],
        body: createAssessorBodySchema,
        response: { 201: assessorResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { name, initials, level } = req.body;
      const created = await app.prisma.assessor.create({
        data: {
          name,
          initials: initials ?? deriveInitials(name),
          level: level ?? "BRONZE",
        },
      });
      reply.status(201);
      return serializeAssessor(created);
    },
  );

  // ─── GET ONE ─────────────────────────────────────────────────────────────
  typed.get(
    "/api/assessors/:id",
    {
      schema: {
        description: "Busca um assessor por id",
        tags: ["assessors"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: assessorResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const row = await app.prisma.assessor.findUnique({ where: { id: req.params.id } });
      if (!row) return reply.status(404).send({ error: "Assessor não encontrado" } as never);
      return serializeAssessor(row);
    },
  );

  // ─── UPDATE ──────────────────────────────────────────────────────────────
  typed.patch(
    "/api/assessors/:id",
    {
      schema: {
        description: "Atualiza um assessor",
        tags: ["assessors"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: updateAssessorBodySchema,
        response: { 200: assessorResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      try {
        const updated = await app.prisma.assessor.update({
          where: { id: req.params.id },
          data: req.body,
        });
        return serializeAssessor(updated);
      } catch {
        return reply.status(404).send({ error: "Assessor não encontrado" } as never);
      }
    },
  );

  // ─── DELETE (soft) ───────────────────────────────────────────────────────
  typed.delete(
    "/api/assessors/:id",
    {
      schema: {
        description: "Remove (soft-delete) um assessor",
        tags: ["assessors"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: assessorResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      try {
        const updated = await app.prisma.assessor.update({
          where: { id: req.params.id },
          data: { active: false },
        });
        return serializeAssessor(updated);
      } catch {
        return reply.status(404).send({ error: "Assessor não encontrado" } as never);
      }
    },
  );

  // ─── PHOTO UPLOAD ────────────────────────────────────────────────────────
  typed.post(
    "/api/assessors/:id/photo",
    {
      schema: {
        description: "Upload de foto do assessor (resize automático 256x256)",
        tags: ["assessors"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: assessorResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { id } = req.params;
      const exists = await app.prisma.assessor.findUnique({ where: { id } });
      if (!exists) return reply.status(404).send({ error: "Assessor não encontrado" } as never);

      const file = await req.file();
      if (!file) return reply.status(400).send({ error: "Arquivo não enviado" } as never);

      const buffer = await file.toBuffer();
      const resized = await sharp(buffer)
        .resize(256, 256, { fit: "cover", position: "centre" })
        .jpeg({ quality: 85 })
        .toBuffer();

      const uploadRoot = resolve(env.UPLOAD_DIR);
      const assessorsDir = join(uploadRoot, "assessors");
      await mkdir(assessorsDir, { recursive: true });

      const fileName = `${id}.jpg`;
      await writeFile(join(assessorsDir, fileName), resized);

      const photoUrl = `/uploads/assessors/${fileName}`;
      const updated = await app.prisma.assessor.update({
        where: { id },
        data: { photoUrl },
      });

      return serializeAssessor(updated);
    },
  );
}
