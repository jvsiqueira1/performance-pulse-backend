/**
 * Scoring service.
 *
 * Fase 3: deriveLevel.
 * Fase 4: computeMetricFields + computeAssessorRollup.
 * Fase 7+: recomputeMetrics(goalId), recomputeRankings, etc.
 */

import { formatDateOnly } from "../lib/dates.js";

export type AssessorLevelEnum = "BRONZE" | "SILVER" | "GOLD";

// ─── Derivação de nível ──────────────────────────────────────────────────────

/**
 * Deriva o level a partir dos pontos acumulados.
 * Thresholds editáveis pela UI admin na Fase 8 via SystemConfig.
 */
export function deriveLevel(points: number): AssessorLevelEnum {
  if (points >= 2000) return "GOLD";
  if (points >= 1500) return "SILVER";
  return "BRONZE";
}

// ─── Cálculo de campos derivados de uma MetricEntry ─────────────────────────

export interface KpiConfig {
  inputMode: "ABSOLUTE" | "PERCENT" | "QUANTITY_OVER_BASE";
  defaultTarget: number;
}

export interface GoalConfig {
  value: number;
}

export interface MetricComputation {
  convertedPercent: number;
  pointsAwarded: number;
}

/**
 * Calcula `convertedPercent` (% de cumprimento da meta) e `pointsAwarded`
 * a partir do raw value digitado pelo gestor.
 *
 * Modos:
 * - ABSOLUTE: convertedPercent = (rawValue / target) * 100
 * - PERCENT: convertedPercent = rawValue (já é percentual)
 * - QUANTITY_OVER_BASE: convertedPercent = (rawValue / baseValue) * 100
 *
 * pointsAwarded = round(min(convertedPercent, 150))
 *   - cap em 150% pra não distorcer o ranking quando alguém estoura a meta
 *   - 100% de cumprimento = 100 pts; mais simples de entender
 */
export function computeMetricFields(
  kpi: KpiConfig,
  activeGoal: GoalConfig | null,
  rawValue: number,
  baseValue: number | null,
): MetricComputation {
  const target = activeGoal?.value ?? kpi.defaultTarget;
  let convertedPercent: number;

  switch (kpi.inputMode) {
    case "ABSOLUTE":
      convertedPercent = target > 0 ? (rawValue / target) * 100 : 0;
      break;
    case "PERCENT":
      convertedPercent = rawValue;
      break;
    case "QUANTITY_OVER_BASE":
      convertedPercent = baseValue && baseValue > 0 ? (rawValue / baseValue) * 100 : 0;
      break;
  }

  const pointsAwarded = Math.round(Math.min(Math.max(convertedPercent, 0), 150));
  return { convertedPercent, pointsAwarded };
}

// ─── Rollup do assessor (agregado por período) ───────────────────────────────

export interface MetricEntryForRollup {
  pointsAwarded: number | null;
  convertedPercent: number | null;
  rawValue: number;
  date: Date;
  notes?: string | null;
  kpi: { key: string };
}

export interface AssessorRollup {
  /** Soma de pointsAwarded no período. */
  points: number;
  /**
   * Soma de convertedPercent capped em 150. Reflete esforço cumulativo.
   */
  weeklyGoalPercent: number;
  /** Dias consecutivos contando pra trás da data de referência. */
  streak: number;
  /** Soma de rawValue por kpi.key. */
  kpiTotals: Record<string, number>;
  /** Set de dias (YYYY-MM-DD) com pelo menos uma entry. */
  activeDays: string[];
  /** Pontos deduzidos por inatividade (dias úteis sem entries e sem justificativa). */
  penaltyPoints: number;
  /** Dias em que a penalidade foi aplicada. */
  penaltyDays: number;
}

/** Verifica se um dia da semana é útil (seg=1 .. sex=5). */
function isBusinessDay(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow >= 1 && dow <= 5;
}

const PENALTY_PER_IDLE_DAY = 15;

/**
 * Agrega entries de um assessor em um período pra calcular points/streak/etc.
 * O caller é responsável por fazer a query (whitelist por assessorId+date range).
 */
export function computeAssessorRollup(
  entries: MetricEntryForRollup[],
  referenceDate: Date = new Date(),
): AssessorRollup {
  const points = entries.reduce((sum, e) => sum + (e.pointsAwarded ?? 0), 0);

  // Soma de convertedPercents (não média): quem registra mais KPIs cumulativamente
  // tem % maior. Cap 150 pra não distorcer caso de overshoot extremo.
  const totalPercent = entries.reduce(
    (sum, e) => sum + Math.max(0, e.convertedPercent ?? 0),
    0,
  );
  const weeklyGoalPercent = Math.round(Math.min(150, totalPercent));

  const dayStrs = new Set(entries.map((e) => formatDateOnly(e.date)));

  // Streak: dias consecutivos com entries, contando pra trás da referenceDate
  let streak = 0;
  const cursor = new Date(referenceDate);
  cursor.setUTCHours(0, 0, 0, 0);
  while (dayStrs.has(formatDateOnly(cursor))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  const kpiTotals: Record<string, number> = {};
  for (const e of entries) {
    kpiTotals[e.kpi.key] = (kpiTotals[e.kpi.key] ?? 0) + e.rawValue;
  }

  // Penalidade: dias úteis no período sem nenhuma entry (e sem notes/justificativa)
  // contam como -15 pts cada. Entries com notes (justificativa) isentam o dia.
  const activeDaysList = Array.from(dayStrs).sort();
  const justifiedDays = new Set(
    entries.filter((e) => e.notes && e.notes.trim().length > 0).map((e) => formatDateOnly(e.date)),
  );
  let penaltyDays = 0;
  if (activeDaysList.length > 0 || referenceDate) {
    // Range: primeiro dia ativo (ou referenceDate) até referenceDate
    const rangeStart = activeDaysList.length > 0
      ? new Date(activeDaysList[0])
      : referenceDate;
    const rangeEnd = new Date(referenceDate);
    rangeStart.setUTCHours(0, 0, 0, 0);
    rangeEnd.setUTCHours(0, 0, 0, 0);

    const cursor = new Date(rangeStart);
    while (cursor <= rangeEnd) {
      const dayStr = formatDateOnly(cursor);
      if (isBusinessDay(cursor) && !dayStrs.has(dayStr) && !justifiedDays.has(dayStr)) {
        penaltyDays++;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  const penaltyPoints = penaltyDays * PENALTY_PER_IDLE_DAY;

  return {
    points: Math.max(0, points - penaltyPoints),
    weeklyGoalPercent,
    streak,
    kpiTotals,
    activeDays: activeDaysList,
    penaltyPoints,
    penaltyDays,
  };
}
