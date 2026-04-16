/**
 * Reports service — agregações históricas reusadas por routes/reports.ts.
 *
 * Fase 7: primeiro momento em que o sistema supera o Excel antigo do Felipe.
 * Tudo aqui é puro — recebe Prisma, retorna estruturas JSON-ready.
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import { buildDateBuckets, formatDateOnly, type Granularity, type DateBucket } from "../lib/dates.js";
import {
  computeAssessorRollup,
  type MetricEntryForRollup,
  type AssessorRollup,
} from "./scoring.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KpiSeriesBucket {
  label: string;
  displayLabel: string;
  start: string; // YYYY-MM-DD
  end: string;
  value: number;
  target: number;
  percentOfTarget: number;
}

export interface KpiSeriesResponse {
  kpi: { id: string; key: string; label: string; unit: string };
  granularity: Granularity;
  from: string;
  to: string;
  buckets: KpiSeriesBucket[];
  total: number;
  totalTarget: number;
  overallPercent: number;
}

export interface OverviewByKpiEntry {
  kpiId: string;
  key: string;
  label: string;
  unit: string;
  actual: number;
  target: number;
  percent: number;
  /** Série diária dentro do range pro PerformanceChart. */
  series: Array<{ date: string; value: number }>;
}

export interface OverviewPerformerEntry {
  assessorId: string;
  name: string;
  initials: string;
  points: number;
  weeklyGoalPercent: number;
}

export interface OverviewReportResponse {
  from: string;
  to: string;
  totalMetricEntries: number;
  byKpi: OverviewByKpiEntry[];
  topPerformers: OverviewPerformerEntry[];
  bottomPerformers: OverviewPerformerEntry[];
  allPerformers: OverviewPerformerEntry[];
}

export interface AssessorKpiHistory {
  key: string;
  label: string;
  unit: string;
  total: number;
  target: number;
  percentOfTarget: number;
  history: Array<{ date: string; value: number }>;
}

export interface AssessorNote {
  date: string;
  notes: string;
  kpiLabel: string;
}

export interface AssessorReportResponse {
  assessor: {
    id: string;
    name: string;
    initials: string;
    photoUrl: string | null;
    level: "BRONZE" | "SILVER" | "GOLD";
  };
  from: string;
  to: string;
  kpis: AssessorKpiHistory[];
  rollup: AssessorRollup;
  badgeUnlocks: Array<{
    id: string;
    badgeId: string;
    slug: string;
    name: string;
    icon: string;
    scope: "INDIVIDUAL" | "SQUAD";
    periodKey: string;
    unlockedAt: string;
  }>;
  /** Observações/justificativas registradas no período. */
  observations: AssessorNote[];
}

export interface FunnelReportResponse {
  from: string;
  to: string;
  ligacoes: number;
  reunioesAgendadas: number;
  reunioesRealizadas: number;
  fechamentos: number;
  perdidas: number;
  conversaoReuniao: number; // pct ligações→reuniões agendadas
  conversaoRealizacao: number; // pct agendadas→realizadas
  conversaoFechamento: number; // pct realizadas→fechadas
  ticketMedio: number;
  ticketTotal: number;
}

export interface ActivityFeedItem {
  id: string;
  type: "metric" | "badge_unlock";
  timestamp: string; // ISO
  assessorId: string;
  assessorName: string;
  description: string;
  icon: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function activeGoalValue(
  goals: Array<{ value: number; validFrom: Date; validTo: Date | null }>,
  ref: Date,
  fallback: number,
): number {
  // Encontra a goal ativa em ref: validFrom <= ref && (validTo null OR validTo > ref)
  const active = goals.find(
    (g) => g.validFrom <= ref && (g.validTo === null || g.validTo > ref),
  );
  return active?.value ?? fallback;
}

function bucketTarget(
  granularity: Granularity,
  dailyTarget: number,
  bucket: DateBucket,
): number {
  // Escala o target por dias no bucket. Para day: target diário.
  // Para week: target*7. Para month: target*numDays(bucket).
  const msPerDay = 86400000;
  const days = Math.round((bucket.end.getTime() - bucket.start.getTime()) / msPerDay) + 1;
  return dailyTarget * days;
}

// ─── aggregateKpiSeries ──────────────────────────────────────────────────────

export async function aggregateKpiSeries(
  prisma: PrismaClient,
  params: {
    kpiId: string;
    from: Date;
    to: Date;
    granularity: Granularity;
    assessorId?: string;
  },
): Promise<KpiSeriesResponse> {
  const kpi = await prisma.kpi.findUniqueOrThrow({
    where: { id: params.kpiId },
    include: {
      goals: {
        orderBy: { validFrom: "desc" },
      },
    },
  });

  // Team size scaling: se não tem assessorId filter, multiplica target pelo
  // número de assessores ativos (target agregado do time). Se tem, é target
  // individual.
  const teamSize = params.assessorId
    ? 1
    : await prisma.assessor.count({ where: { active: true } });

  const entries = await prisma.metricEntry.findMany({
    where: {
      kpiId: kpi.id,
      date: { gte: params.from, lte: params.to },
      ...(params.assessorId ? { assessorId: params.assessorId } : {}),
    },
    select: { date: true, rawValue: true },
  });

  const buckets = buildDateBuckets(params.from, params.to, params.granularity);
  const bucketResults: KpiSeriesBucket[] = buckets.map((b) => {
    const inBucket = entries.filter((e) => e.date >= b.start && e.date <= b.end);
    const value = inBucket.reduce((acc, e) => acc + e.rawValue, 0);
    const dailyTarget = activeGoalValue(kpi.goals, b.end, kpi.defaultTarget);
    const target = bucketTarget(params.granularity, dailyTarget, b) * teamSize;
    const percentOfTarget = target > 0 ? (value / target) * 100 : 0;
    return {
      label: b.label,
      displayLabel: b.displayLabel,
      start: formatDateOnly(b.start),
      end: formatDateOnly(b.end),
      value,
      target,
      percentOfTarget,
    };
  });

  const total = bucketResults.reduce((acc, b) => acc + b.value, 0);
  const totalTarget = bucketResults.reduce((acc, b) => acc + b.target, 0);

  return {
    kpi: { id: kpi.id, key: kpi.key, label: kpi.label, unit: kpi.unit },
    granularity: params.granularity,
    from: formatDateOnly(params.from),
    to: formatDateOnly(params.to),
    buckets: bucketResults,
    total,
    totalTarget,
    overallPercent: totalTarget > 0 ? (total / totalTarget) * 100 : 0,
  };
}

// ─── buildOverview ───────────────────────────────────────────────────────────

export async function buildOverview(
  prisma: PrismaClient,
  params: { from: Date; to: Date },
): Promise<OverviewReportResponse> {
  const [allKpis, allAssessors] = await Promise.all([
    prisma.kpi.findMany({
      where: { active: true, isDerived: false },
      include: {
        goals: { orderBy: { validFrom: "desc" } },
      },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.assessor.findMany({
      where: { active: true },
      include: {
        metricEntries: {
          where: { date: { gte: params.from, lte: params.to } },
          include: { kpi: { select: { key: true } } },
        },
      },
    }),
  ]);

  // Agregação por kpi
  const dayBuckets = buildDateBuckets(params.from, params.to, "day");
  const byKpi: OverviewByKpiEntry[] = allKpis.map((kpi) => {
    const allEntries = allAssessors.flatMap((a) =>
      a.metricEntries.filter((e) => e.kpiId === kpi.id),
    );
    const actual = allEntries.reduce((acc, e) => acc + e.rawValue, 0);
    const dailyTarget = activeGoalValue(kpi.goals, params.to, kpi.defaultTarget);
    const teamSize = allAssessors.length || 1;
    const days = dayBuckets.length;
    const target = dailyTarget * days * teamSize;

    // Série diária: sum rawValue por dia
    const series = dayBuckets.map((b) => {
      const dayValue = allEntries
        .filter((e) => formatDateOnly(e.date) === formatDateOnly(b.start))
        .reduce((acc, e) => acc + e.rawValue, 0);
      return { date: formatDateOnly(b.start), value: dayValue };
    });

    return {
      kpiId: kpi.id,
      key: kpi.key,
      label: kpi.label,
      unit: kpi.unit,
      actual,
      target,
      percent: target > 0 ? (actual / target) * 100 : 0,
      series,
    };
  });

  // Performers — ranking por rollup.points
  const performers = allAssessors.map((a) => {
    const entries = a.metricEntries as MetricEntryForRollup[];
    const rollup = computeAssessorRollup(entries, params.to);
    return {
      assessorId: a.id,
      name: a.name,
      initials: a.initials,
      points: rollup.points,
      weeklyGoalPercent: rollup.weeklyGoalPercent,
    };
  });
  const sortedDesc = [...performers].sort((a, b) => b.points - a.points);
  const sortedAsc = [...performers].sort((a, b) => a.points - b.points);

  const totalMetricEntries = allAssessors.reduce((acc, a) => acc + a.metricEntries.length, 0);

  return {
    from: formatDateOnly(params.from),
    to: formatDateOnly(params.to),
    totalMetricEntries,
    byKpi,
    topPerformers: sortedDesc.slice(0, 3),
    bottomPerformers: sortedAsc.slice(0, 3),
    allPerformers: sortedDesc,
  };
}

// ─── buildAssessorReport ─────────────────────────────────────────────────────

export async function buildAssessorReport(
  prisma: PrismaClient,
  assessorId: string,
  params: { from: Date; to: Date },
): Promise<AssessorReportResponse | null> {
  const assessor = await prisma.assessor.findUnique({
    where: { id: assessorId },
  });
  if (!assessor) return null;

  const [allKpis, entries, unlocks] = await Promise.all([
    prisma.kpi.findMany({
      where: { active: true, isDerived: false },
      include: { goals: { orderBy: { validFrom: "desc" } } },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.metricEntry.findMany({
      where: {
        assessorId,
        date: { gte: params.from, lte: params.to },
      },
      include: { kpi: { select: { key: true, label: true } } },
      orderBy: { date: "asc" },
    }),
    prisma.badgeUnlock.findMany({
      where: { assessorId },
      include: {
        badge: { select: { slug: true, name: true, icon: true, scope: true } },
      },
      orderBy: { unlockedAt: "desc" },
    }),
  ]);

  const dayBuckets = buildDateBuckets(params.from, params.to, "day");
  const kpisHistory: AssessorKpiHistory[] = allKpis.map((kpi) => {
    const kpiEntries = entries.filter((e) => e.kpiId === kpi.id);
    const total = kpiEntries.reduce((acc, e) => acc + e.rawValue, 0);
    const dailyTarget = activeGoalValue(kpi.goals, params.to, kpi.defaultTarget);
    const days = dayBuckets.length;
    const target = dailyTarget * days;
    const percentOfTarget = target > 0 ? (total / target) * 100 : 0;

    const history = dayBuckets.map((b) => {
      const dayValue = kpiEntries
        .filter((e) => formatDateOnly(e.date) === formatDateOnly(b.start))
        .reduce((acc, e) => acc + e.rawValue, 0);
      return { date: formatDateOnly(b.start), value: dayValue };
    });

    return {
      key: kpi.key,
      label: kpi.label,
      unit: kpi.unit,
      total,
      target,
      percentOfTarget,
      history,
    };
  });

  const rollup = computeAssessorRollup(entries as MetricEntryForRollup[], params.to);

  return {
    assessor: {
      id: assessor.id,
      name: assessor.name,
      initials: assessor.initials,
      photoUrl: assessor.photoUrl,
      level: assessor.level as "BRONZE" | "SILVER" | "GOLD",
    },
    from: formatDateOnly(params.from),
    to: formatDateOnly(params.to),
    kpis: kpisHistory,
    rollup,
    badgeUnlocks: unlocks.map((u) => ({
      id: u.id,
      badgeId: u.badgeId,
      slug: u.badge.slug,
      name: u.badge.name,
      icon: u.badge.icon,
      scope: u.badge.scope as "INDIVIDUAL" | "SQUAD",
      periodKey: u.periodKey,
      unlockedAt: u.unlockedAt.toISOString(),
    })),
    observations: entries
      .filter((e) => e.notes && e.notes.trim().length > 0)
      .map((e) => ({
        date: formatDateOnly(e.date),
        notes: e.notes!,
        kpiLabel: (e.kpi as { key: string; label: string }).label,
      })),
  };
}

// ─── buildFunnelReport ───────────────────────────────────────────────────────

export async function buildFunnelReport(
  prisma: PrismaClient,
  params: { from: Date; to: Date; assessorId?: string },
): Promise<FunnelReportResponse> {
  const assessorFilter = params.assessorId ? { assessorId: params.assessorId } : {};

  const [ligacoesEntries, reunioesEntries, meetings] = await Promise.all([
    prisma.metricEntry.findMany({
      where: {
        date: { gte: params.from, lte: params.to },
        kpi: { key: "ligacoes" },
        ...assessorFilter,
      },
      select: { rawValue: true },
    }),
    prisma.metricEntry.findMany({
      where: {
        date: { gte: params.from, lte: params.to },
        kpi: { key: "reunioes" },
        ...assessorFilter,
      },
      select: { rawValue: true },
    }),
    prisma.meetingOutcome.findMany({
      where: {
        scheduledDate: { gte: params.from, lte: params.to },
        ...assessorFilter,
      },
      select: { outcome: true, ticketValue: true },
    }),
  ]);

  const ligacoes = ligacoesEntries.reduce((acc, e) => acc + e.rawValue, 0);
  const reunioesAgendadas = reunioesEntries.reduce((acc, e) => acc + e.rawValue, 0);

  const realizadasStatuses = new Set(["DONE", "CLOSED_WON", "CLOSED_LOST"]);
  const reunioesRealizadas = meetings.filter((m) => realizadasStatuses.has(m.outcome)).length;
  const fechamentos = meetings.filter((m) => m.outcome === "CLOSED_WON").length;
  const perdidas = meetings.filter((m) => m.outcome === "CLOSED_LOST").length;

  const ticketValues = meetings
    .filter((m) => m.outcome === "CLOSED_WON" && m.ticketValue !== null)
    .map((m) => m.ticketValue as number);
  const ticketTotal = ticketValues.reduce((a, b) => a + b, 0);
  const ticketMedio = ticketValues.length > 0 ? ticketTotal / ticketValues.length : 0;

  return {
    from: formatDateOnly(params.from),
    to: formatDateOnly(params.to),
    ligacoes,
    reunioesAgendadas,
    reunioesRealizadas,
    fechamentos,
    perdidas,
    conversaoReuniao: ligacoes > 0 ? (reunioesAgendadas / ligacoes) * 100 : 0,
    conversaoRealizacao: reunioesAgendadas > 0 ? (reunioesRealizadas / reunioesAgendadas) * 100 : 0,
    conversaoFechamento: reunioesRealizadas > 0 ? (fechamentos / reunioesRealizadas) * 100 : 0,
    ticketMedio,
    ticketTotal,
  };
}

// ─── buildActivityFeed ───────────────────────────────────────────────────────

export async function buildActivityFeed(
  prisma: PrismaClient,
  params: { limit: number; assessorId?: string },
): Promise<ActivityFeedItem[]> {
  const assessorFilter = params.assessorId ? { assessorId: params.assessorId } : {};
  const bigTake = params.limit * 2;

  const [metrics, unlocks] = await Promise.all([
    prisma.metricEntry.findMany({
      where: assessorFilter,
      include: {
        kpi: { select: { key: true, label: true, unit: true } },
        assessor: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: bigTake,
    }),
    prisma.badgeUnlock.findMany({
      where: params.assessorId ? { assessorId: params.assessorId } : { assessorId: { not: null } },
      include: {
        badge: { select: { name: true, icon: true } },
        assessor: { select: { name: true } },
      },
      orderBy: { unlockedAt: "desc" },
      take: bigTake,
    }),
  ]);

  const items: ActivityFeedItem[] = [
    ...metrics.map<ActivityFeedItem>((m) => {
      const hasNote = m.notes && m.notes.trim().length > 0;
      const desc = hasNote
        ? `📝 ${m.notes!.trim()}`
        : `registrou ${m.rawValue}${m.kpi.unit} ${m.kpi.label.toLowerCase()}`;
      return {
        id: `metric-${m.id}`,
        type: hasNote ? ("observation" as "metric") : ("metric" as const),
        timestamp: m.createdAt.toISOString(),
        assessorId: m.assessorId,
        assessorName: m.assessor.name,
        description: desc,
        icon: hasNote ? "MessageSquare" : "CheckCircle2",
      };
    }),
    ...unlocks.map<ActivityFeedItem>((u) => ({
      id: `unlock-${u.id}`,
      type: "badge_unlock" as const,
      timestamp: u.unlockedAt.toISOString(),
      assessorId: u.assessorId ?? "",
      assessorName: u.assessor?.name ?? "Time",
      description: `desbloqueou ${u.badge.name} ${u.badge.icon}`,
      icon: "Award",
    })),
  ];

  items.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return items.slice(0, params.limit);
}
