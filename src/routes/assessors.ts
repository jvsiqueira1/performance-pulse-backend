import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import sharp from "sharp";
import { env } from "../env.js";
import { getPhotoStorage } from "../services/photoStorage.js";

const assessorLevelSchema = z.enum(["BRONZE", "SILVER", "GOLD"]);

const assessorResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  initials: z.string(),
  photoUrl: z.string().nullable(),
  level: assessorLevelSchema,
  active: z.boolean(),
  totalLeads: z.number(),
  totalClients: z.number(),
  vacationUntil: z.string().nullable(),
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
  totalLeads: z.number().int().min(0).optional(),
  totalClients: z.number().int().min(0).optional(),
  // Data de retorno de férias. Null/string vazia = sem férias agendadas.
  vacationUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
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
  totalLeads: number;
  totalClients: number;
  vacationUntil: Date | null;
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
    totalLeads: a.totalLeads,
    totalClients: a.totalClients,
    vacationUntil: a.vacationUntil ? a.vacationUntil.toISOString().slice(0, 10) : null,
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
        description: "Lista assessores. PUBLIC — consumido pela rota /tv. Shape já não expõe email/telefone.",
        tags: ["assessors"],
        querystring: listQuerySchema,
        response: { 200: z.array(assessorResponseSchema) },
      },
      // Sem auth: usado pela TV pública (`/tv`).
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
        // Converte vacationUntil string YYYY-MM-DD → Date pra Prisma.
        const data: Record<string, unknown> = { ...req.body };
        if (req.body.vacationUntil !== undefined) {
          data.vacationUntil = req.body.vacationUntil
            ? new Date(`${req.body.vacationUntil}T00:00:00.000Z`)
            : null;
        }
        const updated = await app.prisma.assessor.update({
          where: { id: req.params.id },
          data,
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

      let file;
      try {
        file = await req.file();
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
          return reply
            .status(413)
            .send({ error: `Arquivo maior que ${env.MAX_UPLOAD_SIZE_MB}MB` } as never);
        }
        app.log.error({ err }, "Erro ao processar upload de foto");
        return reply.status(400).send({ error: "Falha ao processar upload" } as never);
      }
      if (!file) return reply.status(400).send({ error: "Arquivo não enviado" } as never);

      let buffer;
      try {
        buffer = await file.toBuffer();
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE") {
          return reply
            .status(413)
            .send({ error: `Arquivo maior que ${env.MAX_UPLOAD_SIZE_MB}MB` } as never);
        }
        throw err;
      }

      let resized;
      try {
        resized = await sharp(buffer)
          .resize(256, 256, { fit: "cover", position: "centre" })
          .jpeg({ quality: 85 })
          .toBuffer();
      } catch (err) {
        app.log.error({ err }, "Sharp falhou ao processar imagem");
        return reply
          .status(400)
          .send({ error: "Imagem inválida ou corrompida" } as never);
      }

      // Grava via storage adapter: R2 se configurado, senão disco local.
      let photoUrl: string;
      try {
        photoUrl = await getPhotoStorage().uploadAssessorPhoto(id, resized);
      } catch (err) {
        app.log.error({ err, assessorId: id }, "Falha ao gravar foto no storage");
        return reply
          .status(500)
          .send({ error: "Falha ao armazenar foto" } as never);
      }

      const updated = await app.prisma.assessor.update({
        where: { id },
        data: { photoUrl },
      });

      return serializeAssessor(updated);
    },
  );
}
