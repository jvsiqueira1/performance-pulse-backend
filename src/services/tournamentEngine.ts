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
