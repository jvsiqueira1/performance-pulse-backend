/**
 * Bet engine — calcula o vencedor de uma Bet baseado em `winnerCriteriaJson`.
 *
 * Suporta 3 kinds inicialmente (Fase 6):
 * - `{kind: "avgKpi", kpiKey}` — maior média de rawValue do KPI no range da bet
 * - `{kind: "totalPoints"}` — maior soma de pointsAwarded no range
 * - `{kind: "sumKpi", kpiKey}` — maior soma de rawValue do KPI no range
 *
 * Fase 8 expõe UI pra editar o critério. Fases futuras podem adicionar
 * kinds novos sem migration (JSON).
 */

import type { PrismaClient } from "../generated/prisma/client.js";

export type BetWinnerCriteria =
  | { kind: "avgKpi"; kpiKey: string }
  | { kind: "totalPoints" }
  | { kind: "sumKpi"; kpiKey: string };

export interface BetParticipantScore {
  squadId: string;
  score: number;
  /** Lista de assessorIds que foram considerados (snapshot no início da bet). */
  memberIds: string[];
}

export interface BetEngineResult {
  /** Squad vencedora ou null se não houve participantes / empate total em 0. */
  winnerSquadId: string | null;
  scores: BetParticipantScore[];
}

/**
 * Computa os scores de cada participante da bet e retorna o vencedor.
 * Caller é responsável por persistir (update BetParticipant.finalScore + Bet.winnerSquadId).
 */
export async function computeBetWinner(
  prisma: PrismaClient,
  betId: string,
): Promise<BetEngineResult> {
  const bet = await prisma.bet.findUniqueOrThrow({
    where: { id: betId },
    include: { participants: true },
  });

  const criteria = bet.winnerCriteriaJson as unknown as BetWinnerCriteria;
  const scores: BetParticipantScore[] = [];

  for (const participant of bet.participants) {
    // squadId agora é nullable (pra suportar INDIVIDUAL tournament participants).
    // Pra SQUAD_BET, todos participants têm squadId preenchido — defensivo aqui.
    if (!participant.squadId) continue;
    const memberIds = (participant.snapshotMembersJson as unknown as string[] | null) ?? [];
    if (memberIds.length === 0) {
      scores.push({ squadId: participant.squadId, score: 0, memberIds: [] });
      continue;
    }

    const entries = await prisma.metricEntry.findMany({
      where: {
        assessorId: { in: memberIds },
        date: { gte: bet.startDate, lte: bet.endDate },
      },
      include: { kpi: { select: { key: true } } },
    });

    let score = 0;
    switch (criteria.kind) {
      case "avgKpi": {
        const relevant = entries.filter((e) => e.kpi.key === criteria.kpiKey);
        if (relevant.length > 0) {
          const sum = relevant.reduce((acc, e) => acc + e.rawValue, 0);
          score = sum / memberIds.length;
        }
        break;
      }
      case "totalPoints": {
        score = entries.reduce((acc, e) => acc + (e.pointsAwarded ?? 0), 0);
        break;
      }
      case "sumKpi": {
        score = entries
          .filter((e) => e.kpi.key === criteria.kpiKey)
          .reduce((acc, e) => acc + e.rawValue, 0);
        break;
      }
      default: {
        // Kind desconhecido → score 0 (defensivo)
        score = 0;
      }
    }

    scores.push({ squadId: participant.squadId!, score, memberIds });
  }

  // Vencedor = maior score. Se todo mundo tem 0, winnerSquadId = null.
  scores.sort((a, b) => b.score - a.score);
  const winner = scores[0];
  const winnerSquadId = winner && winner.score > 0 ? winner.squadId : null;

  return { winnerSquadId, scores };
}
