import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { computeBetWinner } from "../services/betEngine.js";
import { parseDateOnly, todayInAppTz, weekStart, weekEnd } from "../lib/dates.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const betStatusSchema = z.enum(["ACTIVE", "FINISHED", "CANCELED"]);
const betTypeSchema = z.enum(["WEEKLY", "MONTHLY", "CUSTOM"]);

const winnerCriteriaSchema = z.union([
  z.object({ kind: z.literal("avgKpi"), kpiKey: z.string() }),
  z.object({ kind: z.literal("totalPoints") }),
  z.object({ kind: z.literal("sumKpi"), kpiKey: z.string() }),
]);

const betParticipantResponseSchema = z.object({
  squadId: z.string(),
  finalScore: z.number().nullable(),
  squadName: z.string(),
  squadEmoji: z.string(),
});

const betResponseSchema = z.object({
  id: z.string(),
  roundLabel: z.string(),
  type: betTypeSchema,
  value: z.number(),
  startDate: z.string(),
  endDate: z.string(),
  status: betStatusSchema,
  winnerSquadId: z.string().nullable(),
  winnerSquad: z
    .object({ id: z.string(), name: z.string(), emoji: z.string() })
    .nullable(),
  winnerCriteriaJson: winnerCriteriaSchema,
  createdById: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  participants: z.array(betParticipantResponseSchema),
});

const createBetBodySchema = z.object({
  roundLabel: z.string().min(1).max(80),
  type: betTypeSchema,
  value: z.number().nonnegative(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  winnerCriteriaJson: winnerCriteriaSchema,
  /** Se omitido, pega todas as squads ativas como participantes. */
  squadIds: z.array(z.string()).optional(),
});

const listQuerySchema = z.object({
  status: betStatusSchema.optional(),
});

// ─── Serializer ──────────────────────────────────────────────────────────────

type BetRow = {
  id: string;
  roundLabel: string;
  type: string;
  value: number;
  startDate: Date;
  endDate: Date;
  status: string;
  winnerSquadId: string | null;
  winnerCriteriaJson: unknown;
  createdById: string;
  createdAt: Date;
  finishedAt: Date | null;
  winnerSquad: { id: string; name: string; emoji: string } | null;
  participants: Array<{
    squadId: string;
    finalScore: number | null;
    squad: { name: string; emoji: string };
  }>;
};

function serializeBet(row: BetRow) {
  return {
    id: row.id,
    roundLabel: row.roundLabel,
    type: row.type as "WEEKLY" | "MONTHLY" | "CUSTOM",
    value: row.value,
    startDate: row.startDate.toISOString().slice(0, 10),
    endDate: row.endDate.toISOString().slice(0, 10),
    status: row.status as "ACTIVE" | "FINISHED" | "CANCELED",
    winnerSquadId: row.winnerSquadId,
    winnerSquad: row.winnerSquad,
    winnerCriteriaJson: row.winnerCriteriaJson as z.infer<typeof winnerCriteriaSchema>,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    participants: row.participants.map((p) => ({
      squadId: p.squadId,
      finalScore: p.finalScore,
      squadName: p.squad.name,
      squadEmoji: p.squad.emoji,
    })),
  };
}

const betInclude = {
  winnerSquad: { select: { id: true, name: true, emoji: true } },
  participants: {
    include: { squad: { select: { name: true, emoji: true } } },
  },
} as const;

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function betRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/bets",
    {
      schema: {
        description: "Lista bets (filtro opcional por status). PUBLIC — consumido pela rota /tv.",
        tags: ["bets"],
        querystring: listQuerySchema,
        response: { 200: z.array(betResponseSchema) },
      },
      // Sem auth: usado pela TV pública (`/tv`).
    },
    async (req) => {
      const { status } = req.query;
      const rows = await app.prisma.bet.findMany({
        where: status ? { status } : undefined,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        include: betInclude,
      });
      return rows.map(serializeBet);
    },
  );

  typed.post(
    "/api/bets",
    {
      schema: {
        description:
          "Cria uma bet nova. Se squadIds não for informado, pega todas as squads ativas. " +
          "startDate/endDate default = semana corrente (BRT) pra type=WEEKLY.",
        tags: ["bets"],
        security: [{ bearerAuth: [] }],
        body: createBetBodySchema,
        response: { 201: betResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { roundLabel, type, value, startDate, endDate, winnerCriteriaJson, squadIds } = req.body;
      const createdById = req.user.sub;

      // Default date range baseado no tipo
      const ref = todayInAppTz();
      const start = startDate ? parseDateOnly(startDate) : weekStart(ref);
      const end = endDate ? parseDateOnly(endDate) : weekEnd(ref);

      // Participantes: lista explícita ou todas as squads ativas
      const squads = await app.prisma.squad.findMany({
        where: squadIds ? { id: { in: squadIds }, active: true } : { active: true },
        include: {
          members: {
            where: { leftAt: null },
            select: { assessorId: true },
          },
        },
      });

      if (squads.length === 0) {
        return reply.status(400).send({ error: "Nenhuma squad disponível" } as never);
      }

      const bet = await app.prisma.$transaction(async (tx) => {
        const created = await tx.bet.create({
          data: {
            roundLabel,
            type,
            value,
            startDate: start,
            endDate: end,
            winnerCriteriaJson: winnerCriteriaJson as unknown as object,
            createdById,
          },
        });
        for (const squad of squads) {
          await tx.betParticipant.create({
            data: {
              betId: created.id,
              squadId: squad.id,
              snapshotMembersJson: squad.members.map((m) => m.assessorId) as unknown as object,
            },
          });
        }
        return tx.bet.findUniqueOrThrow({
          where: { id: created.id },
          include: betInclude,
        });
      });

      reply.status(201);
      return serializeBet(bet);
    },
  );

  typed.post(
    "/api/bets/:id/finish",
    {
      schema: {
        description:
          "Finaliza uma bet: computa vencedor via betEngine, grava finalScore em cada participante, " +
          "gera CofreEntry PAYOUT pro vencedor, e retorna a bet atualizada.",
        tags: ["bets"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: betResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await app.prisma.bet.findUnique({ where: { id } });
      if (!existing) return reply.status(404).send({ error: "Bet não encontrada" } as never);
      if (existing.status !== "ACTIVE") {
        return reply.status(400).send({ error: "Bet não está ativa" } as never);
      }

      // 1. Computa vencedor (fora da transação pra manter simples)
      const result = await computeBetWinner(app.prisma, id);

      // 2. Persiste resultados em transação
      await app.prisma.$transaction(async (tx) => {
        for (const s of result.scores) {
          await tx.betParticipant.updateMany({
            where: { betId: id, squadId: s.squadId },
            data: { finalScore: s.score },
          });
        }
        await tx.bet.update({
          where: { id },
          data: {
            status: "FINISHED",
            winnerSquadId: result.winnerSquadId,
            finishedAt: new Date(),
          },
        });
        if (result.winnerSquadId && existing.value > 0) {
          await tx.cofreEntry.create({
            data: {
              betId: id,
              kind: "PAYOUT",
              amount: existing.value,
              description: `Prêmio bet ${existing.roundLabel}`,
              createdById: req.user.sub,
            },
          });
        }
      });

      const fresh = await app.prisma.bet.findUniqueOrThrow({
        where: { id },
        include: betInclude,
      });
      return serializeBet(fresh);
    },
  );

  typed.post(
    "/api/bets/:id/cancel",
    {
      schema: {
        description: "Cancela uma bet ativa (sem pagar cofre)",
        tags: ["bets"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: betResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const { id } = req.params;
      try {
        const updated = await app.prisma.bet.update({
          where: { id },
          data: { status: "CANCELED", finishedAt: new Date() },
          include: betInclude,
        });
        return serializeBet(updated);
      } catch {
        return reply.status(404).send({ error: "Bet não encontrada" } as never);
      }
    },
  );
}
