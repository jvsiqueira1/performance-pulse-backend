/**
 * Tournament engine — calcula ranking de participantes em um torneio.
 *
 * Diferente do betEngine, torneios:
 * - Podem ter escopo INDIVIDUAL (assessor vs assessor) ou SQUAD (squad vs squad)
 * - Suportam top N (payout progressivo), não só winner-take-all
 * - Critério de vitória: `sumKpi` (soma do KPI no range) — V1 mais simples
 *
 * Caller persiste finalScore + rank nos BetParticipants e cria CofreEntries.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import { eventBus } from "./eventBus.js";

export interface TournamentParticipantScore {
  participantId: string;          // BetParticipant.id
  squadId: string | null;
  assessorId: string | null;
  displayName: string;            // nome do squad OU do assessor
  score: number;
  rank: number;                   // 1-based; tied scores share rank
}

export interface TournamentEngineResult {
  /** Ranking ordenado desc por score; ranks atribuídos (1=top). */
  scores: TournamentParticipantScore[];
  /** Top N ids (participantIds) que devem receber payout. */
  winners: string[];
}

/**
 * Computa o ranking de um torneio e retorna os top N winners.
 *
 * Escopo INDIVIDUAL: cada participant tem assessorId → soma rawValue do KPI
 * pra aquele assessor.
 *
 * Escopo SQUAD: cada participant tem squadId → soma rawValue do KPI agregado
 * pros membros do squad (snapshotMembersJson).
 */
export async function computeTournamentRanking(
  prisma: PrismaClient,
  betId: string,
): Promise<TournamentEngineResult> {
  const bet = await prisma.bet.findUniqueOrThrow({
    where: { id: betId },
    include: {
      participants: {
        include: {
          squad: { select: { name: true, emoji: true } },
          assessor: { select: { name: true } },
        },
      },
    },
  });

  if (bet.kind !== "TOURNAMENT") {
    throw new Error(`Bet ${betId} não é um torneio (kind=${bet.kind})`);
  }
  if (!bet.goalKpiKey) {
    throw new Error(`Torneio ${betId} sem goalKpiKey definido`);
  }

  const scores: TournamentParticipantScore[] = [];

  for (const p of bet.participants) {
    let score = 0;
    let displayName = "—";

    if (p.assessorId) {
      // INDIVIDUAL: soma rawValue do KPI pro assessor no range
      const entries = await prisma.metricEntry.findMany({
        where: {
          assessorId: p.assessorId,
          date: { gte: bet.startDate, lte: bet.endDate },
          kpi: { key: bet.goalKpiKey },
        },
      });
      score = entries.reduce((acc, e) => acc + e.rawValue, 0);
      displayName = p.assessor?.name ?? "—";
    } else if (p.squadId) {
      // SQUAD: soma rawValue do KPI pros membros (snapshot)
      const memberIds = (p.snapshotMembersJson as unknown as string[] | null) ?? [];
      if (memberIds.length > 0) {
        const entries = await prisma.metricEntry.findMany({
          where: {
            assessorId: { in: memberIds },
            date: { gte: bet.startDate, lte: bet.endDate },
            kpi: { key: bet.goalKpiKey },
          },
        });
        score = entries.reduce((acc, e) => acc + e.rawValue, 0);
      }
      displayName = p.squad?.name ?? "—";
    }

    scores.push({
      participantId: p.id,
      squadId: p.squadId,
      assessorId: p.assessorId,
      displayName,
      score,
      rank: 0, // atribuído abaixo
    });
  }

  // Ordena desc e atribui rank (ties compartilham rank).
  scores.sort((a, b) => b.score - a.score);
  let currentRank = 0;
  let lastScore = Number.POSITIVE_INFINITY;
  scores.forEach((s, idx) => {
    if (s.score < lastScore) {
      currentRank = idx + 1;
      lastScore = s.score;
    }
    s.rank = currentRank;
  });

  // Winners: até maxWinners posições, só quem score > 0.
  const maxWinners = bet.maxWinners ?? 1;
  const winners = scores
    .filter((s) => s.score > 0 && s.rank <= maxWinners)
    .map((s) => s.participantId);

  return { scores, winners };
}

/**
 * Retorna mapa rank → valor do payout progressivo.
 * progressivePayoutJson: {"1": 300, "2": 150, "3": 100}
 * Se null, fallback: rank 1 ganha bet.value, demais 0.
 */
export function resolvePayoutForRank(
  progressivePayoutJson: unknown,
  fallbackValue: number,
  rank: number,
): number {
  if (!progressivePayoutJson || typeof progressivePayoutJson !== "object") {
    return rank === 1 ? fallbackValue : 0;
  }
  const record = progressivePayoutJson as Record<string, number>;
  const val = record[String(rank)];
  return typeof val === "number" && val > 0 ? val : 0;
}

/**
 * Finaliza um torneio: computa ranking, persiste ranks/scores, cria PAYOUTs.
 * Retorna resumo pro caller logar ou broadcastar.
 *
 * Usado por:
 * - POST /api/tournaments/:id/finish (admin manual)
 * - Job cron auto-finish (sem admin identificado — usa createdById do torneio)
 */
export async function finishTournament(
  prisma: PrismaClient,
  betId: string,
  /** User que disparou (admin manual) OU null pra cron (usa createdById do bet). */
  actorUserId: string | null,
): Promise<{ winners: string[]; payoutsCreated: number }> {
  const bet = await prisma.bet.findUnique({
    where: { id: betId },
    select: { id: true, kind: true, status: true, progressivePayoutJson: true, value: true, createdById: true },
  });
  if (!bet) throw new Error(`Torneio ${betId} não encontrado`);
  if (bet.kind !== "TOURNAMENT") throw new Error("Bet não é torneio");
  if (bet.status !== "ACTIVE") throw new Error(`Torneio já ${bet.status}`);

  const { scores, winners } = await computeTournamentRanking(prisma, betId);

  await prisma.$transaction([
    ...scores.map((s) =>
      prisma.betParticipant.update({
        where: { id: s.participantId },
        data: { finalScore: s.score, rank: s.rank },
      }),
    ),
    prisma.bet.update({
      where: { id: bet.id },
      data: {
        status: "FINISHED",
        finishedAt: new Date(),
        winnerSquadId: (() => {
          const topWinnerId = winners[0];
          if (!topWinnerId) return null;
          const top = scores.find((s) => s.participantId === topWinnerId);
          return top?.squadId ?? null;
        })(),
      },
    }),
  ]);

  // Cofre PAYOUTs + coleta de payload pro evento
  const payoutJson = bet.progressivePayoutJson as Record<string, number> | null;
  const createdById = actorUserId ?? bet.createdById;
  let payoutsCreated = 0;
  const winnerPayloads: Array<{
    rank: number;
    displayName: string;
    photoUrl: string | null;
    initials: string | null;
    payout: number;
    score: number;
  }> = [];

  // Busca avatares dos winners pra popular evento SSE (TV mostra foto)
  const winnerParticipantIds = winners;
  const participants = winnerParticipantIds.length
    ? await prisma.betParticipant.findMany({
        where: { id: { in: winnerParticipantIds } },
        include: {
          squad: { select: { name: true, emoji: true } },
          assessor: { select: { name: true, initials: true, photoUrl: true } },
        },
      })
    : [];
  const pMap = new Map(participants.map((p) => [p.id, p]));

  for (const winnerId of winners) {
    const s = scores.find((x) => x.participantId === winnerId);
    if (!s) continue;
    const amount = resolvePayoutForRank(payoutJson, bet.value, s.rank);
    if (amount > 0) {
      await prisma.cofreEntry.create({
        data: {
          betId: bet.id,
          kind: "PAYOUT",
          amount,
          description: `Torneio · ${s.rank}º lugar · ${s.displayName}`,
          createdById,
        },
      });
      payoutsCreated++;

      const p = pMap.get(winnerId);
      winnerPayloads.push({
        rank: s.rank,
        displayName: s.displayName,
        photoUrl: p?.assessor?.photoUrl ?? null,
        initials: p?.assessor?.initials ?? p?.squad?.emoji ?? null,
        payout: amount,
        score: s.score,
      });
    }
  }

  // Fetch roundLabel pro payload do evento (já carregamos no início parcialmente)
  const betMeta = await prisma.bet.findUnique({
    where: { id: betId },
    select: { roundLabel: true },
  });

  // Emite evento SSE — TV/dashboard ouvem e disparam celebração fullscreen
  eventBus.emitTournamentFinished({
    tournamentId: betId,
    roundLabel: betMeta?.roundLabel ?? "Torneio",
    winners: winnerPayloads.sort((a, b) => a.rank - b.rank),
  });

  return { winners, payoutsCreated };
}
