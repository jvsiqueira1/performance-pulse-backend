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
  kpi: { key: string };
}

export interface AssessorRollup {
  /** Soma de pointsAwarded no período. */
  points: number;
  /**
   * Soma de convertedPercent capped em 150. Reflete esforço cumulativo:
   * registrar mais KPIs aumenta a %, ao invés da média que penalizava
   * quem registrava mais entries de valor baixo.
   * Histórico: até 2026-04-15 era média; mudou pra soma porque a média
   * gerava resultado contra-intuitivo (Felipe reportou).
   */
  weeklyGoalPercent: number;
  /** Dias consecutivos contando pra trás da data de referência (default = hoje). */
  streak: number;
  /** Soma de rawValue por kpi.key — usado pra exibir totais por KPI. */
  kpiTotals: Record<string, number>;
  /** Set de dias (YYYY-MM-DD) com pelo menos uma entry — usado pelo heatmap. */
  activeDays: string[];
}

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

  return {
    points,
    weeklyGoalPercent,
    streak,
    kpiTotals,
    activeDays: Array.from(dayStrs).sort(),
  };
}
