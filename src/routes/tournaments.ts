import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eventBus } from "../services/eventBus.js";
import {
  computeTournamentRanking,
  resolvePayoutForRank,
} from "../services/tournamentEngine.js";
import { parseDateOnly, todayInAppTz } from "../lib/dates.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const tournamentScopeSchema = z.enum(["INDIVIDUAL", "SQUAD"]);
const tournamentStatusSchema = z.enum(["ACTIVE", "FINISHED", "CANCELED"]);

const progressivePayoutSchema = z
  .record(z.string().regex(/^\d+$/), z.number().nonnegative())
  .refine((v) => Object.keys(v).length > 0, "Payout vazio");

const participantResponseSchema = z.object({
  id: z.string(),
  squadId: z.string().nullable(),
  assessorId: z.string().nullable(),
  displayName: z.string(),
  finalScore: z.number().nullable(),
  rank: z.number().nullable(),
  photoUrl: z.string().nullable(),
  initials: z.string().nullable(),
});

const tournamentResponseSchema = z.object({
  id: z.string(),
  roundLabel: z.string(),
  scope: tournamentScopeSchema,
  goalKpiKey: z.string(),
  goalTargetValue: z.number().nullable(),
  startDate: z.string(),
  endDate: z.string(),
  status: tournamentStatusSchema,
  maxWinners: z.number(),
  progressivePayoutJson: z.record(z.string(), z.number()).nullable(),
  totalPrizePool: z.number(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  participants: z.array(participantResponseSchema),
});

const createTournamentBodySchema = z.object({
  roundLabel: z.string().min(1).max(80),
  scope: tournamentScopeSchema,
  goalKpiKey: z.string().min(1),
  goalTargetValue: z.number().positive().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  maxWinners: z.number().int().min(1).max(10).default(1),
  progressivePayoutJson: progressivePayoutSchema,
  /** Override: se omitido pega todos ativos (assessores pra INDIVIDUAL, squads pra SQUAD). */
  participantIds: z.array(z.string()).optional(),
});

const listQuerySchema = z.object({
  status: tournamentStatusSchema.optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function totalPrizePool(payout: Record<string, number> | null | undefined): number {
  if (!payout) return 0;
  return Object.values(payout).reduce((acc, v) => acc + (typeof v === "number" ? v : 0), 0);
}

function serialize(bet: {
  id: string;
  roundLabel: string;
  tournamentScope: string | null;
  goalKpiKey: string | null;
  goalTargetValue: number | null;
  startDate: Date;
  endDate: Date;
  status: string;
  maxWinners: number | null;
  progressivePayoutJson: unknown;
  createdAt: Date;
  finishedAt: Date | null;
  participants: Array<{
    id: string;
    squadId: string | null;
    assessorId: string | null;
    finalScore: number | null;
    rank: number | null;
    squad: { name: string; emoji: string } | null;
    assessor: { name: string; initials: string; photoUrl: string | null } | null;
  }>;
}) {
  const payout = (bet.progressivePayoutJson as Record<string, number> | null) ?? null;
  return {
    id: bet.id,
    roundLabel: bet.roundLabel,
    scope: (bet.tournamentScope ?? "SQUAD") as "INDIVIDUAL" | "SQUAD",
    goalKpiKey: bet.goalKpiKey ?? "",
    goalTargetValue: bet.goalTargetValue,
    startDate: bet.startDate.toISOString().slice(0, 10),
    endDate: bet.endDate.toISOString().slice(0, 10),
    status: bet.status as "ACTIVE" | "FINISHED" | "CANCELED",
    maxWinners: bet.maxWinners ?? 1,
    progressivePayoutJson: payout,
    totalPrizePool: totalPrizePool(payout),
    createdAt: bet.createdAt.toISOString(),
    finishedAt: bet.finishedAt?.toISOString() ?? null,
    participants: bet.participants.map((p) => ({
      id: p.id,
      squadId: p.squadId,
      assessorId: p.assessorId,
      displayName: p.assessor?.name ?? p.squad?.name ?? "—",
      finalScore: p.finalScore,
      rank: p.rank,
      photoUrl: p.assessor?.photoUrl ?? null,
      initials: p.assessor?.initials ?? null,
    })),
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function tournamentRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // ─── LIST ─────────────────────────────────────────────────────────────────
  typed.get(
    "/api/tournaments",
    {
      schema: {
        description: "Lista torneios (filtro opcional por status). PUBLIC — consumido pela rota /tv e por admin.",
        tags: ["tournaments"],
        querystring: listQuerySchema,
        response: { 200: z.array(tournamentResponseSchema) },
      },
      // Sem auth: dashboard público (/tv) também lista torneios ativos.
    },
    async (req) => {
      const rows = await app.prisma.bet.findMany({
        where: {
          kind: "TOURNAMENT",
          ...(req.query.status ? { status: req.query.status } : {}),
        },
        orderBy: [{ status: "asc" }, { startDate: "desc" }],
        include: {
          participants: {
            include: {
              squad: { select: { name: true, emoji: true } },
              assessor: { select: { name: true, initials: true, photoUrl: true } },
            },
            orderBy: [{ rank: "asc" }, { finalScore: "desc" }],
          },
        },
      });
      return rows.map(serialize);
    },
  );

  // ─── CREATE ───────────────────────────────────────────────────────────────
  typed.post(
    "/api/tournaments",
    {
      schema: {
        description: "Cria torneio. Auto-enrolla participantes ativos (INDIVIDUAL: assessores, SQUAD: squads).",
        tags: ["tournaments"],
        security: [{ bearerAuth: [] }],
        body: createTournamentBodySchema,
        response: { 201: tournamentResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const body = req.body;
      const startDate = parseDateOnly(body.startDate);
      const endDate = parseDateOnly(body.endDate);

      if (endDate < startDate) {
        return reply.status(400).send({ error: "endDate deve ser >= startDate" } as never);
      }

      // Valida KPI existe
      const kpi = await app.prisma.kpi.findUnique({ where: { key: body.goalKpiKey } });
      if (!kpi) {
        return reply.status(400).send({ error: `KPI '${body.goalKpiKey}' não encontrado` } as never);
      }

      // Valida payout tem entradas até maxWinners
      const payoutKeys = Object.keys(body.progressivePayoutJson).map(Number).sort((a, b) => a - b);
      if (payoutKeys[0] !== 1) {
        return reply.status(400).send({ error: "Payout deve começar no rank 1" } as never);
      }

      // Auto-enroll participantes ativos
      type ParticipantRow = { squadId?: string; assessorId?: string; snapshotMembersJson?: string[] };
      let participantRows: ParticipantRow[] = [];
      if (body.scope === "INDIVIDUAL") {
        const assessors = body.participantIds
          ? await app.prisma.assessor.findMany({ where: { id: { in: body.participantIds }, active: true } })
          : await app.prisma.assessor.findMany({ where: { active: true } });
        participantRows = assessors.map((a) => ({ assessorId: a.id }));
      } else {
        // SQUAD — membros ativos têm `leftAt: null`
        const squadWhere = body.participantIds
          ? { id: { in: body.participantIds }, active: true }
          : { active: true };
        const squads = await app.prisma.squad.findMany({
          where: squadWhere,
          include: { members: { where: { leftAt: null }, select: { assessorId: true } } },
        });
        participantRows = squads.map((s) => ({
          squadId: s.id,
          snapshotMembersJson: s.members.map((m) => m.assessorId),
        }));
      }

      if (participantRows.length === 0) {
        return reply.status(400).send({ error: "Nenhum participante ativo pra enrollar" } as never);
      }

      const bet = await app.prisma.bet.create({
        data: {
          roundLabel: body.roundLabel,
          type: "CUSTOM",
          kind: "TOURNAMENT",
          tournamentScope: body.scope,
          value: totalPrizePool(body.progressivePayoutJson),
          startDate,
          endDate,
          goalKpiKey: body.goalKpiKey,
          goalTargetValue: body.goalTargetValue ?? null,
          maxWinners: body.maxWinners,
          progressivePayoutJson: body.progressivePayoutJson,
          winnerCriteriaJson: { kind: "sumKpi", kpiKey: body.goalKpiKey },
          createdById: req.user.sub,
          participants: {
            create: participantRows.map((p) => ({
              squadId: p.squadId,
              assessorId: p.assessorId,
              snapshotMembersJson: p.snapshotMembersJson,
            })),
          },
        },
        include: {
          participants: {
            include: {
              squad: { select: { name: true, emoji: true } },
              assessor: { select: { name: true, initials: true, photoUrl: true } },
            },
          },
        },
      });

      // Broadcast: frontend pode atualizar listagem em tempo real (SSE)
      eventBus.emitRankingUpdate();

      reply.status(201);
      return serialize(bet);
    },
  );

  // ─── FINISH ───────────────────────────────────────────────────────────────
  typed.post(
    "/api/tournaments/:id/finish",
    {
      schema: {
        description:
          "Finaliza torneio: computa top N, atualiza ranks e finalScores, cria N CofreEntry PAYOUTs.",
        tags: ["tournaments"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: tournamentResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const bet = await app.prisma.bet.findUnique({
        where: { id: req.params.id },
        select: { id: true, kind: true, status: true, progressivePayoutJson: true, value: true },
      });
      if (!bet) return reply.status(404).send({ error: "Torneio não encontrado" } as never);
      if (bet.kind !== "TOURNAMENT") {
        return reply.status(400).send({ error: "Bet não é torneio" } as never);
      }
      if (bet.status !== "ACTIVE") {
        return reply.status(400).send({ error: `Torneio já ${bet.status}` } as never);
      }

      const { scores, winners } = await computeTournamentRanking(app.prisma, bet.id);

      // Atualiza ranks e finalScores
      await app.prisma.$transaction([
        ...scores.map((s) =>
          app.prisma.betParticipant.update({
            where: { id: s.participantId },
            data: { finalScore: s.score, rank: s.rank },
          }),
        ),
        app.prisma.bet.update({
          where: { id: bet.id },
          data: {
            status: "FINISHED",
            finishedAt: new Date(),
            // Compat: winnerSquadId preenchido se top 1 é SQUAD (null se INDIVIDUAL).
            winnerSquadId: (() => {
              const topWinnerId = winners[0];
              if (!topWinnerId) return null;
              const top = scores.find((s) => s.participantId === topWinnerId);
              return top?.squadId ?? null;
            })(),
          },
        }),
      ]);

      // Cofre PAYOUTs progressivos
      const payoutJson = bet.progressivePayoutJson as Record<string, number> | null;
      for (const winnerId of winners) {
        const s = scores.find((x) => x.participantId === winnerId);
        if (!s) continue;
        const amount = resolvePayoutForRank(payoutJson, bet.value, s.rank);
        if (amount > 0) {
          await app.prisma.cofreEntry.create({
            data: {
              betId: bet.id,
              kind: "PAYOUT",
              amount,
              description: `Torneio · ${s.rank}º lugar · ${s.displayName}`,
              createdById: req.user.sub,
            },
          });
        }
      }

      // Broadcast
      eventBus.emitRankingUpdate();

      // Retorna torneio atualizado
      const refreshed = await app.prisma.bet.findUniqueOrThrow({
        where: { id: bet.id },
        include: {
          participants: {
            include: {
              squad: { select: { name: true, emoji: true } },
              assessor: { select: { name: true, initials: true, photoUrl: true } },
            },
            orderBy: [{ rank: "asc" }, { finalScore: "desc" }],
          },
        },
      });
      return serialize(refreshed);
    },
  );

  // ─── CANCEL ───────────────────────────────────────────────────────────────
  typed.post(
    "/api/tournaments/:id/cancel",
    {
      schema: {
        description: "Cancela torneio ACTIVE (sem criar payouts).",
        tags: ["tournaments"],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string() }),
        response: { 200: tournamentResponseSchema },
      },
      onRequest: [app.authenticate],
    },
    async (req, reply) => {
      const bet = await app.prisma.bet.findUnique({
        where: { id: req.params.id },
        select: { id: true, kind: true, status: true },
      });
      if (!bet) return reply.status(404).send({ error: "Torneio não encontrado" } as never);
      if (bet.kind !== "TOURNAMENT") {
        return reply.status(400).send({ error: "Bet não é torneio" } as never);
      }
      if (bet.status !== "ACTIVE") {
        return reply.status(400).send({ error: `Torneio já ${bet.status}` } as never);
      }

      await app.prisma.bet.update({
        where: { id: bet.id },
        data: { status: "CANCELED", finishedAt: new Date() },
      });
      eventBus.emitRankingUpdate();

      const refreshed = await app.prisma.bet.findUniqueOrThrow({
        where: { id: bet.id },
        include: {
          participants: {
            include: {
              squad: { select: { name: true, emoji: true } },
              assessor: { select: { name: true, initials: true, photoUrl: true } },
            },
          },
        },
      });
      return serialize(refreshed);
    },
  );
}
