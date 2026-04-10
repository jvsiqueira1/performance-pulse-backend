/**
 * Badge engine — avalia regras de badges e grava unlocks idempotentes.
 *
 * Disparado após cada POST /api/metrics via setImmediate (fire-and-forget,
 * não bloqueia a resposta). Idempotente via `BadgeUnlock.periodKey` (unique
 * constraint): múltiplas execuções pro mesmo período são no-ops no banco.
 *
 * Regras suportadas (Fase 6):
 *
 * INDIVIDUAL:
 * - {kpiKey, op, value, period}        → soma de rawValue do KPI no período
 * - {kind: "streak", op, value}        → dias consecutivos com entries
 * - {kind: "fullWeek"}                  → entries em todos os 5 dias úteis da semana
 *
 * SQUAD:
 * - {kind: "avgTeamKpi", kpiKey, op, value} → média do KPI dos membros
 * - {kind: "teamHitIndividualBadge", badgeSlug, pct} → X% dos membros unlocked o badge individual
 *
 * STUBBED (não avaliados nesta fase — unlocks nunca disparam):
 * - {kind: "topTeamKpi", kpiKey, period}  → squad com mais <kpi> no período (requer comparar entre squads)
 * - {kind: "consecutiveWins", count}      → requer histórico de bets
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import type { FastifyBaseLogger } from "fastify";
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfDay } from "date-fns";
import { formatDateOnly, weekStart, weekEnd } from "../lib/dates.js";
import { computeAssessorRollup, type MetricEntryForRollup } from "./scoring.js";

type Op = ">" | ">=" | "=" | "<" | "<=";

interface IndividualKpiRule {
  kpiKey: string;
  op: Op;
  value: number;
  period: "DAILY" | "WEEKLY" | "MONTHLY";
}
interface StreakRule {
  kind: "streak";
  op: Op;
  value: number;
}
interface FullWeekRule {
  kind: "fullWeek";
}
interface AvgTeamKpiRule {
  kind: "avgTeamKpi";
  kpiKey: string;
  op: Op;
  value: number;
}
interface TeamHitIndividualBadgeRule {
  kind: "teamHitIndividualBadge";
  badgeSlug: string;
  pct: number;
}

type IndividualRule = IndividualKpiRule | StreakRule | FullWeekRule;
type SquadRule = AvgTeamKpiRule | TeamHitIndividualBadgeRule;

function compareOp(lhs: number, op: Op, rhs: number): boolean {
  switch (op) {
    case ">": return lhs > rhs;
    case ">=": return lhs >= rhs;
    case "=": return lhs === rhs;
    case "<": return lhs < rhs;
    case "<=": return lhs <= rhs;
  }
}

// ─── Period helpers ──────────────────────────────────────────────────────────

function periodRange(period: "DAILY" | "WEEKLY" | "MONTHLY", ref: Date): { from: Date; to: Date; key: string } {
  switch (period) {
    case "DAILY":
      return {
        from: startOfDay(ref),
        to: startOfDay(ref),
        key: formatDateOnly(ref),
      };
    case "WEEKLY":
      return {
        from: weekStart(ref),
        to: weekEnd(ref),
        key: format(ref, "yyyy-'W'II"),
      };
    case "MONTHLY":
      return {
        from: startOfMonth(ref),
        to: endOfMonth(ref),
        key: format(ref, "yyyy-MM"),
      };
  }
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

/**
 * Avalia todos os badges ativos pro assessor dado. Percorre também as squads
 * ativas das quais ele é membro, pra avaliar badges de squad.
 *
 * Idempotente: usa upsert em BadgeUnlock com unique em (badgeId, assessorId|squadId, periodKey).
 */
export async function evaluateBadgesForAssessor(
  prisma: PrismaClient,
  assessorId: string,
  referenceDate: Date = new Date(),
  log?: FastifyBaseLogger,
): Promise<void> {
  const [allBadges, assessor] = await Promise.all([
    prisma.badge.findMany({ where: { active: true } }),
    prisma.assessor.findUnique({
      where: { id: assessorId },
      include: {
        squadMemberships: {
          where: { leftAt: null },
          include: { squad: true },
        },
      },
    }),
  ]);

  if (!assessor) return;

  const individualBadges = allBadges.filter((b) => b.scope === "INDIVIDUAL");
  const squadBadges = allBadges.filter((b) => b.scope === "SQUAD");

  // ── 1. Individual badges ───────────────────────────────────────────────
  for (const badge of individualBadges) {
    try {
      const rule = badge.ruleJson as unknown as IndividualRule;
      const unlockInfo = await evaluateIndividualRule(prisma, assessorId, rule, referenceDate);
      if (!unlockInfo) continue;

      await prisma.badgeUnlock.upsert({
        where: {
          badgeId_assessorId_periodKey: {
            badgeId: badge.id,
            assessorId,
            periodKey: unlockInfo.periodKey,
          },
        },
        update: {},
        create: {
          badgeId: badge.id,
          assessorId,
          periodKey: unlockInfo.periodKey,
        },
      });
    } catch (err) {
      log?.warn({ err, badgeId: badge.id, assessorId }, "badgeEngine: individual rule failed");
    }
  }

  // ── 2. Squad badges — pra cada squad que o assessor é membro ──────────
  for (const membership of assessor.squadMemberships) {
    const squadId = membership.squadId;

    // Busca todos os membros ativos do squad
    const members = await prisma.squadMember.findMany({
      where: { squadId, leftAt: null },
      select: { assessorId: true },
    });
    const memberIds = members.map((m) => m.assessorId);
    if (memberIds.length === 0) continue;

    for (const badge of squadBadges) {
      try {
        const rule = badge.ruleJson as unknown as SquadRule;
        const unlockInfo = await evaluateSquadRule(prisma, memberIds, rule, referenceDate);
        if (!unlockInfo) continue;

        await prisma.badgeUnlock.upsert({
          where: {
            badgeId_squadId_periodKey: {
              badgeId: badge.id,
              squadId,
              periodKey: unlockInfo.periodKey,
            },
          },
          update: {},
          create: {
            badgeId: badge.id,
            squadId,
            periodKey: unlockInfo.periodKey,
          },
        });
      } catch (err) {
        log?.warn({ err, badgeId: badge.id, squadId }, "badgeEngine: squad rule failed");
      }
    }
  }
}

// ─── Individual rule evaluation ──────────────────────────────────────────────

async function evaluateIndividualRule(
  prisma: PrismaClient,
  assessorId: string,
  rule: IndividualRule,
  ref: Date,
): Promise<{ periodKey: string } | null> {
  // Rule: fullWeek → precisa entries em todos os 5 dias úteis da semana
  if ("kind" in rule && rule.kind === "fullWeek") {
    const { from, to, key } = periodRange("WEEKLY", ref);
    const entries = await prisma.metricEntry.findMany({
      where: { assessorId, date: { gte: from, lte: to } },
      select: { date: true },
    });
    const days = new Set(entries.map((e) => e.date.getUTCDay()));
    // dayOfWeek 1..5 = seg..sex
    const hasAllWeekdays = [1, 2, 3, 4, 5].every((d) => days.has(d));
    return hasAllWeekdays ? { periodKey: key } : null;
  }

  // Rule: streak → computa rollup no range da semana pra ter activeDays + calcular streak
  if ("kind" in rule && rule.kind === "streak") {
    const { from, to, key } = periodRange("WEEKLY", ref);
    const entries = await prisma.metricEntry.findMany({
      where: { assessorId, date: { gte: from, lte: to } },
      include: { kpi: { select: { key: true } } },
    });
    const rollup = computeAssessorRollup(entries as MetricEntryForRollup[], ref);
    return compareOp(rollup.streak, rule.op, rule.value) ? { periodKey: key } : null;
  }

  // Rule: threshold em KPI específico
  if (!("kind" in rule)) {
    const { from, to, key } = periodRange(rule.period, ref);
    const entries = await prisma.metricEntry.findMany({
      where: {
        assessorId,
        date: { gte: from, lte: to },
        kpi: { key: rule.kpiKey },
      },
      select: { rawValue: true },
    });
    const total = entries.reduce((acc, e) => acc + e.rawValue, 0);
    return compareOp(total, rule.op, rule.value) ? { periodKey: key } : null;
  }

  return null;
}

// ─── Squad rule evaluation ───────────────────────────────────────────────────

async function evaluateSquadRule(
  prisma: PrismaClient,
  memberIds: string[],
  rule: SquadRule,
  ref: Date,
): Promise<{ periodKey: string } | null> {
  if (rule.kind === "avgTeamKpi") {
    // Usa WEEKLY como período padrão; rule.value é o limiar
    const { from, to, key } = periodRange("WEEKLY", ref);
    const entries = await prisma.metricEntry.findMany({
      where: {
        assessorId: { in: memberIds },
        date: { gte: from, lte: to },
        kpi: { key: rule.kpiKey },
      },
      select: { rawValue: true, assessorId: true },
    });
    // Soma por assessor → média
    const perAssessor: Record<string, number> = {};
    for (const id of memberIds) perAssessor[id] = 0;
    for (const e of entries) perAssessor[e.assessorId] = (perAssessor[e.assessorId] ?? 0) + e.rawValue;
    const avg = Object.values(perAssessor).reduce((a, b) => a + b, 0) / memberIds.length;
    return compareOp(avg, rule.op, rule.value) ? { periodKey: key } : null;
  }

  if (rule.kind === "teamHitIndividualBadge") {
    const { key } = periodRange("WEEKLY", ref);
    const targetBadge = await prisma.badge.findUnique({ where: { slug: rule.badgeSlug } });
    if (!targetBadge) return null;

    const unlocked = await prisma.badgeUnlock.count({
      where: {
        badgeId: targetBadge.id,
        assessorId: { in: memberIds },
        periodKey: key,
      },
    });
    const ratio = unlocked / memberIds.length;
    return ratio >= rule.pct ? { periodKey: key } : null;
  }

  // Kinds ainda não implementados: topTeamKpi, consecutiveWins
  return null;
}
