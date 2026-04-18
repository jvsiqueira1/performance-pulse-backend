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
  key: string;
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
 * Tabela oficial de pontuação por evento (definida pelo time em 16/04/2026):
 *
 * - cadência ≥70% da lista = 5 pontos (threshold único, não proporcional)
 * - 1 reunião agendada = 5 pontos
 * - 1 reunião realizada = 10 pontos
 * - 1 reunião c/ áreas = 5 pontos (já tratado via marker [REUNIAO_AREA] em metrics.ts)
 * - 10 boletas = 1 ponto (a cada 10 unidades)
 * - 1 lead gerado = 1 ponto
 * - 30 prospecções = 5 pontos (a cada 30 ligações)
 * - 1 TP = 1 ponto
 * - 1 indicação = 2,5 pontos
 * - Ativação de conta = 10 pontos
 *
 * Pra qualquer KPI não listado, usa fallback proporcional à meta (cap 150).
 */
const POINTS_RULES: Record<
  string,
  (rawValue: number, baseValue: number | null) => number
> = {
  cadencia: (raw, base) => {
    const pct = base && base > 0 ? (raw / base) * 100 : 0;
    return pct >= 70 ? 5 : 0;
  },
  reunioes: (raw) => raw * 5,
  reunioes_realizadas: (raw) => raw * 10,
  boletos: (raw) => Math.floor(raw / 10) * 1,
  leads: (raw) => raw * 1,
  ligacoes: (raw) => Math.floor(raw / 30) * 5,
  touchpoint: (raw) => raw * 1,
  indicacoes: (raw) => raw * 2.5,
  ativacao_conta: (raw) => raw * 10,
};

/**
 * Calcula `convertedPercent` (% real de cumprimento da meta) e
 * `pointsAwarded` (gamificação por evento, conforme tabela oficial).
 *
 * Antes de 16/04/2026 ambos eram derivados da mesma fórmula proporcional
 * (pointsAwarded = round(min(150, convertedPercent))). A reunião decidiu
 * separar: pontos viram tabela por evento; % continua sendo cumprimento real.
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

  // Pontos: usa tabela oficial. Fallback (KPI desconhecido): proporcional cap 150.
  const rule = POINTS_RULES[kpi.key];
  const pointsAwarded = rule
    ? Math.max(0, rule(rawValue, baseValue))
    : Math.round(Math.min(Math.max(convertedPercent, 0), 150));

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
  /** Soma de pointsAwarded no período (gamificação, tabela por evento). */
  points: number;
  /**
   * % real de cumprimento da meta no período: média dos convertedPercent
   * por KPI registrado, cap 100. Reflete "quanto da meta foi batido", não
   * a soma de pontos. Antes de 16/04/2026 era soma cap 150 (confundia com pts).
   *
   * Mantém o nome `weeklyGoalPercent` por compatibilidade com a UI/tipos do
   * frontend (vários componentes consomem esse campo).
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

  // % real de cumprimento da meta: média dos convertedPercent por KPI ÚNICO
  // (não soma de todas entries). Capa cada KPI individualmente em 100% pra não
  // permitir um KPI estourado compensar outros. Resultado: 0-100.
  // Ex: ligações 70%, reuniões 100%, leads 50% → (70+100+50)/3 = 73%.
  const percentByKpi = new Map<string, { total: number; count: number }>();
  for (const e of entries) {
    if (e.convertedPercent === null) continue;
    const k = e.kpi.key;
    const current = percentByKpi.get(k) ?? { total: 0, count: 0 };
    current.total += Math.min(100, Math.max(0, e.convertedPercent));
    current.count += 1;
    percentByKpi.set(k, current);
  }
  const kpiAverages: number[] = [];
  for (const { total, count } of percentByKpi.values()) {
    kpiAverages.push(count > 0 ? total / count : 0);
  }
  const weeklyGoalPercent =
    kpiAverages.length > 0
      ? Math.round(kpiAverages.reduce((a, b) => a + b, 0) / kpiAverages.length)
      : 0;

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
