import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { parseDateOnly } from "../lib/dates.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const outcomeStatusSchema = z.enum([
  "SCHEDULED",
  "NO_SHOW",
  "DONE",
  "CLOSED_WON",
  "CLOSED_LOST",
]);

const meetingResponseSchema = z.object({
  id: z.string(),
  assessorId: z.string(),
  assessorName: z.string(),
  scheduledDate: z.string(),
  scheduledMetricEntryId: z.string().nullable(),
  outcome: outcomeStatusSchema,
  closedAt: z.string().nullable(),
  ticketValue: z.number().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createMeetingBodySchema = z.object({
  assessorId: z.string().min(1),
  scheduledDate: z.string().datetime(),
  scheduledMetricEntryId: z.string().optional(),
  outcome: outcomeStatusSchema.optional(),
  ticketValue: z.number().nonnegative().optional(),
  notes: z.string().max(500).optional(),
});

const updateMeetingBodySchema = z.object({
  scheduledDate: z.string().datetime().optional(),
  outcome: outcomeStatusSchema.optional(),
  closedAt: z.string().datetime().nullable().optional(),
  ticketValue: z.number().nonnegative().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const listQuerySchema = z.object({
  assessorId: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  outcome: outcomeStatusSchema.optional(),
});

// ─── Serializer ──────────────────────────────────────────────────────────────

type MeetingRow = {
  id: string;
  assessorId: string;
  scheduledDate: Date;
  scheduledMetricEntryId: string | null;
  outcome: string;
  closedAt: Date | null;
  ticketValue: number | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  assessor: { name: string };
};

function serializeMeeting(row: MeetingRow) {
  return {
    id: row.id,
    assessorId: row.assessorId,
    assessorName: row.assessor.name,
    scheduledDate: row.scheduledDate.toISOString(),
    scheduledMetricEntryId: row.scheduledMetricEntryId,
    outcome: row.outcome as
      | "SCHEDULED"
      | "NO_SHOW"
      | "DONE"
      | "CLOSED_WON"
      | "CLOSED_LOST",
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    ticketValue: row.ticketValue,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const meetingInclude = {
  assessor: { select: { name: true } },
} as const;

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function meetingRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/meetings",
    {
      schema: {
        description: "Lista meetings com filtros",
        tags: ["meetings"],
        security: [{ bearerAuth: [] }],
        querystring: listQuerySchema,
        response: { 200: z.array(meetingResponseSchema) },
      },
      onRequest: [app.authenticate],
    },
    async (req) => {
      const { assessorId, from, to, outcome } = req.query;
      const where: {
        assessorId?: string;
        outcome?: "SCHEDULED" | "NO_SHOW" | "DONE" | "CLOSED_WON" | "CLOSED_LOST";
        scheduledDate?: { gte?: Date; lte?: Date };
      } = {};
      if (assessorId) where.assessorId = assessorId;
      if (outcome) where.outcome = outcome;
      if (from || to) {
        where.scheduledDate = {};
        if (from) where.scheduledDate.gte = parseDateOnly(from);
        if (to) where.scheduledDate.lte = parseDateOnly(to);
      }
      const rows = await app.prisma.meetingOutcome.findMany({
        where,
        include: meetingInclude,
        orderBy: { scheduledDate: "desc" },
        take: 500,
      });
      return rows.map(serializeMeeting);
    },
  );

  typed.get(
    "/api/meetings/:id",
    {
      schema: {
        description: "Busca uma meeting por id",
        tags: ["meetings"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: meetingResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const row = await app.prisma.meetingOutcome.findUnique({
        where: { id: req.params.id },
        include: meetingInclude,
      });
      if (!row) return reply.status(404).send({ error: "Meeting não encontrada" } as never);
      return serializeMeeting(row);
    },
  );

  typed.post(
    "/api/meetings",
    {
      schema: {
        description: "Cria uma meeting. Default outcome=SCHEDULED.",
        tags: ["meetings"],
        security: [{ bearerAuth: [] }],
        body: createMeetingBodySchema,
        response: { 201: meetingResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { assessorId, scheduledDate, scheduledMetricEntryId, outcome, ticketValue, notes } =
        req.body;

      const assessor = await app.prisma.assessor.findUnique({ where: { id: assessorId } });
      if (!assessor) return reply.status(404).send({ error: "Assessor não encontrado" } as never);

      const created = await app.prisma.meetingOutcome.create({
        data: {
          assessorId,
          scheduledDate: new Date(scheduledDate),
          scheduledMetricEntryId: scheduledMetricEntryId ?? null,
          outcome: outcome ?? "SCHEDULED",
          ticketValue: ticketValue ?? null,
          notes: notes ?? null,
        },
        include: meetingInclude,
      });
      reply.status(201);
      return serializeMeeting(created);
    },
  );

  typed.patch(
    "/api/meetings/:id",
    {
      schema: {
        description:
          "Atualiza uma meeting. Quando outcome muda pra CLOSED_WON/CLOSED_LOST/DONE e closedAt é null, backend preenche com now().",
        tags: ["meetings"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        body: updateMeetingBodySchema,
        response: { 200: meetingResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const existing = await app.prisma.meetingOutcome.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) return reply.status(404).send({ error: "Meeting não encontrada" } as never);

      const body = req.body;
      const data: Record<string, unknown> = {};
      if (body.scheduledDate !== undefined) data.scheduledDate = new Date(body.scheduledDate);
      if (body.outcome !== undefined) data.outcome = body.outcome;
      if (body.ticketValue !== undefined) data.ticketValue = body.ticketValue;
      if (body.notes !== undefined) data.notes = body.notes;
      if (body.closedAt !== undefined) {
        data.closedAt = body.closedAt ? new Date(body.closedAt) : null;
      }

      // Auto-fill closedAt quando transicionar pra estado final sem closedAt explícito
      const finalStates = new Set(["DONE", "CLOSED_WON", "CLOSED_LOST"]);
      if (
        body.outcome &&
        finalStates.has(body.outcome) &&
        body.closedAt === undefined &&
        existing.closedAt === null
      ) {
        data.closedAt = new Date();
      }

      const updated = await app.prisma.meetingOutcome.update({
        where: { id: req.params.id },
        data,
        include: meetingInclude,
      });
      return serializeMeeting(updated);
    },
  );

  typed.delete(
    "/api/meetings/:id",
    {
      schema: {
        description: "Deleta meeting (somente ADMIN)",
        tags: ["meetings"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 204: z.null() },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      if (req.user.role !== "ADMIN") {
        return reply.status(403).send({ error: "Apenas ADMIN pode deletar meetings" } as never);
      }
      try {
        await app.prisma.meetingOutcome.delete({ where: { id: req.params.id } });
      } catch {
        return reply.status(404).send({ error: "Meeting não encontrada" } as never);
      }
      reply.status(204);
      return null;
    },
  );
}
