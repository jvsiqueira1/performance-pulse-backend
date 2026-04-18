/**
 * Insight service — gera análises de IA pra assessores via OpenRouter.
 *
 * Fluxo:
 * 1. Busca métricas do assessor no período
 * 2. Busca médias do time pra comparação
 * 3. Monta prompt em português, tom "coach exigente mas justo"
 * 4. Calcula inputHash determinístico dos dados
 * 5. Checa cache (AiInsight com mesmo hash) → se hit, retorna cached
 * 6. Chama OpenRouter → grava AiInsight → retorna
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { FastifyInstance } from "fastify";
import { format } from "date-fns";
import { formatDateOnly, weekStart, weekEnd, monthStart, monthEnd } from "../lib/dates.js";

export type InsightPeriod = "DAY" | "WEEK" | "MONTH";

export interface GenerateInsightParams {
  assessorId: string;
  periodKind: InsightPeriod;
  periodKey: string; // "2026-04-09" (day), "2026-W15" (week), "2026-04" (month)
  force?: boolean; // ignora cache
}

export interface InsightResult {
  id: string;
  textMarkdown: string;
  summary: string;
  tags: string[];
  model: string;
  cached: boolean;
  createdAt: string;
}

// ─── Period range resolver ───────────────────────────────────────────────────

function periodRange(kind: InsightPeriod, key: string): { from: Date; to: Date } {
  if (kind === "DAY") {
    const d = new Date(`${key}T00:00:00.000Z`);
    return { from: d, to: d };
  }
  if (kind === "WEEK") {
    // key = "2026-W15" — parse via date-fns
    const [yearStr, weekStr] = key.split("-W");
    const year = Number(yearStr);
    const week = Number(weekStr);
    // First day of ISO week: Jan 4 is always in week 1. Approximate.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7;
    const monday = new Date(jan4.getTime() + ((1 - dayOfWeek) + (week - 1) * 7) * 86400000);
    return { from: weekStart(monday), to: weekEnd(monday) };
  }
  // MONTH: key = "2026-04"
  const d = new Date(`${key}-01T00:00:00.000Z`);
  return { from: monthStart(d), to: monthEnd(d) };
}

/**
 * Calcula a key do período ANTERIOR pra comparação ("vs semana anterior").
 * - DAY 2026-04-17 → 2026-04-16
 * - WEEK 2026-W15 → 2026-W14 (com rollover de ano se W1 → ano-1 W52/53)
 * - MONTH 2026-04 → 2026-03 (com rollover de ano)
 */
function previousPeriodKey(kind: InsightPeriod, key: string): string {
  if (kind === "DAY") {
    const d = new Date(`${key}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (kind === "WEEK") {
    const [yearStr, weekStr] = key.split("-W");
    let year = Number(yearStr);
    let week = Number(weekStr);
    week -= 1;
    if (week < 1) {
      year -= 1;
      week = 52; // simplificação — não cobre 53 semanas
    }
    return `${year}-W${week.toString().padStart(2, "0")}`;
  }
  // MONTH
  const [yearStr, monthStr] = key.split("-");
  let year = Number(yearStr);
  let month = Number(monthStr);
  month -= 1;
  if (month < 1) {
    year -= 1;
    month = 12;
  }
  return `${year}-${month.toString().padStart(2, "0")}`;
}

/**
 * Projeta um valor linearmente: realizado_até_hoje / dias_decorridos × dias_totais.
 * Se o período já terminou, retorna o realizado direto.
 */
function projectLinear(
  realized: number,
  rangeStart: Date,
  rangeEnd: Date,
  asOf: Date,
): { projected: number; elapsedDays: number; totalDays: number; remaining: number } {
  const MS = 86400000;
  const totalDays = Math.max(1, Math.round((rangeEnd.getTime() - rangeStart.getTime()) / MS) + 1);
  const elapsedDays = Math.max(
    1,
    Math.min(totalDays, Math.round((asOf.getTime() - rangeStart.getTime()) / MS) + 1),
  );
  const remaining = Math.max(0, Math.round((rangeEnd.getTime() - asOf.getTime()) / MS));
  const projected = remaining > 0 ? Math.round((realized / elapsedDays) * totalDays) : realized;
  return { projected, elapsedDays, totalDays, remaining };
}

// ─── Hash ────────────────────────────────────────────────────────────────────

function computeInputHash(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

interface PromptData {
  assessorName: string;
  period: string;
  kpis: Array<{
    label: string;
    value: number;
    target: number;
    percent: number;
    previousValue?: number;
    deltaPct?: number | null;
    projected?: number;
    projectedPct?: number;
  }>;
  teamAvg: Array<{ label: string; avgValue: number; avgPercent: number }>;
  streak: number;
  points: number;
  penaltyDays: number;
  penaltyPoints: number;
  observations: Array<{ date: string; note: string }>;
  badges: string[];
  remainingDays: number;
}

function buildPrompt(data: PromptData): string {
  const kpiLines = data.kpis
    .map((k) => {
      const deltaStr =
        k.deltaPct == null
          ? ""
          : k.deltaPct > 0
            ? ` (↑${k.deltaPct}% vs anterior)`
            : k.deltaPct < 0
              ? ` (↓${Math.abs(k.deltaPct)}% vs anterior)`
              : ` (igual ao anterior)`;
      const projStr =
        k.projected != null && data.remainingDays > 0
          ? ` [proj fim: ~${k.projected} = ${k.projectedPct}%]`
          : "";
      return `- ${k.label}: ${k.value} (meta: ${k.target}, ${k.percent.toFixed(0)}%)${deltaStr}${projStr}`;
    })
    .join("\n");

  const teamLines = data.teamAvg
    .map((k) => `- ${k.label}: média time ${k.avgValue.toFixed(1)} (${k.avgPercent.toFixed(0)}%)`)
    .join("\n");

  const badgeStr = data.badges.length > 0 ? data.badges.join(", ") : "nenhuma";

  // Calcular conversão ligações→reuniões (funil)
  const ligacoes = data.kpis.find((k) => k.label.toLowerCase().includes("ligaç"))?.value ?? 0;
  const reunioes = data.kpis.find((k) => k.label.toLowerCase().includes("reuni"))?.value ?? 0;
  const convRate = ligacoes > 0 ? ((reunioes / ligacoes) * 100).toFixed(1) : "N/A";

  // Identificar KPIs acima e abaixo da média do time
  const acimaDaMedia = data.kpis
    .filter((k, i) => data.teamAvg[i] && k.value > data.teamAvg[i].avgValue)
    .map((k) => k.label);
  const abaixoDaMedia = data.kpis
    .filter((k, i) => data.teamAvg[i] && k.value < data.teamAvg[i].avgValue)
    .map((k) => k.label);

  // Penalidade
  const penaltyStr =
    data.penaltyDays > 0
      ? `\n⚠️ ALERTA: ${data.penaltyDays} dia(s) sem registro nem justificativa = -${data.penaltyPoints} pts de penalidade.`
      : "";

  // Observações relevantes (reuniões via [REUNIAO]/[REUNIAO_AREA] e justificativas)
  const obsLines =
    data.observations.length > 0
      ? data.observations
          .slice(0, 8)
          .map((o) => `- ${o.date}: ${o.note}`)
          .join("\n")
      : "(nenhuma observação registrada)";

  return `Você é um coach/gestor de vendas de alto nível num escritório de investimentos. Analise os dados abaixo e gere uma análise ESTRATÉGICA e PRÁTICA em português brasileiro. Use markdown. Máximo 280 palavras.

CONTEXTO: Este é um escritório de assessoria de investimentos. Os assessores prospectam clientes, agendam reuniões, fazem alocações (boletas) e mantêm relacionamento com a base. O objetivo é tornar o processo de vendas PREVISÍVEL através de métricas.

## Assessor: ${data.assessorName}
Período: ${data.period} | Dias restantes no período: ${data.remainingDays}
Pontos acumulados: ${data.points} | Streak: ${data.streak} dias consecutivos
Conquistas: ${badgeStr}${penaltyStr}

### Métricas individuais (com delta vs período anterior + projeção):
${kpiLines}

### Comparativo com a média do time:
${teamLines}

### Dados de funil:
- Taxa de conversão ligações→reuniões: ${convRate}%
- Acima da média do time em: ${acimaDaMedia.length > 0 ? acimaDaMedia.join(", ") : "nenhum KPI"}
- Abaixo da média do time em: ${abaixoDaMedia.length > 0 ? abaixoDaMedia.join(", ") : "nenhum KPI"}

### Observações registradas no período:
${obsLines}

### Instruções pro modelo:
1. VEREDICTO direto em 1 frase: este assessor está performando bem, na média, ou preocupante?
2. EVOLUÇÃO vs período anterior: melhorou, manteve ou piorou? Em quê especificamente?
3. PROJEÇÃO: no ritmo atual, vai bater a meta? Se não, o que precisa fazer nos dias restantes?
4. Analise o FUNIL: se faz muitas ligações mas poucas reuniões, o pitch precisa melhorar. Se marca reuniões mas não converte, o closing precisa de atenção.
5. Compare com o time: onde se destaca vs onde está ficando pra trás?
6. Se há PENALIDADE por inatividade, cobre disciplina diretamente.
7. Dê 2-3 AÇÕES ESPECÍFICAS e PRÁTICAS pra esta semana (não genéricas — diga "aumente de X pra Y focando em Z")
8. Se algum KPI está ZERO ou abaixo de 30% da meta, trate como URGÊNCIA
9. Se está acima da média em tudo, reconheça e sugira como manter/escalar
10. Tom: líder de vendas experiente que fala direto, sem floreio, com dados na mão. Não use emojis.`;
}

// ─── Main function ───────────────────────────────────────────────────────────

export async function generateInsight(
  app: FastifyInstance,
  prisma: PrismaClient,
  params: GenerateInsightParams,
): Promise<InsightResult> {
  const { assessorId, periodKind, periodKey, force } = params;

  const assessor = await prisma.assessor.findUniqueOrThrow({
    where: { id: assessorId },
  });

  const { from, to } = periodRange(periodKind, periodKey);

  // Busca métricas do assessor
  const entries = await prisma.metricEntry.findMany({
    where: { assessorId, date: { gte: from, lte: to } },
    include: { kpi: { select: { key: true, label: true, unit: true } } },
  });

  // Busca goals ativas pra targets
  const kpis = await prisma.kpi.findMany({
    where: { active: true, isDerived: false },
    include: {
      goals: { where: { validTo: null }, orderBy: { validFrom: "desc" }, take: 1 },
    },
  });

  // Busca métricas do time todo pra comparação
  const teamEntries = await prisma.metricEntry.findMany({
    where: { date: { gte: from, lte: to } },
    include: { kpi: { select: { key: true } } },
  });
  const activeAssessorCount = await prisma.assessor.count({ where: { active: true } });

  // Validação: sem métricas → não gasta token da IA
  if (entries.length === 0) {
    throw new Error(
      `Sem métricas registradas pra ${assessor.name} no período ${periodKey}. Registre dados antes de gerar o insight.`,
    );
  }

  // Período anterior pra comparação
  const prevKey = previousPeriodKey(periodKind, periodKey);
  const prevRange = periodRange(periodKind, prevKey);
  const prevEntries = await prisma.metricEntry.findMany({
    where: { assessorId, date: { gte: prevRange.from, lte: prevRange.to } },
  });

  // Projeção (regra de 3) — só faz sentido se ainda há dia restante no período
  const today = new Date();

  // Agrega por KPI (com delta vs período anterior + projeção)
  const assessorKpis: PromptData["kpis"] = [];
  const teamAvg: PromptData["teamAvg"] = [];

  for (const kpi of kpis) {
    const target = kpi.goals[0]?.value ?? kpi.defaultTarget;
    const assessorEntries = entries.filter((e) => e.kpiId === kpi.id);
    const value = assessorEntries.reduce((acc, e) => acc + e.rawValue, 0);
    const percent = target > 0 ? (value / target) * 100 : 0;

    const prevValue = prevEntries
      .filter((e) => e.kpiId === kpi.id)
      .reduce((acc, e) => acc + e.rawValue, 0);
    const deltaPct =
      prevValue > 0 ? Math.round(((value - prevValue) / prevValue) * 100) : null;

    const proj = projectLinear(value, from, to, today);
    const projectedPct = target > 0 ? Math.round((proj.projected / target) * 100) : 0;

    assessorKpis.push({
      label: kpi.label,
      value,
      target,
      percent,
      previousValue: prevValue,
      deltaPct,
      projected: proj.projected,
      projectedPct,
    });

    const teamTotal = teamEntries
      .filter((e) => e.kpi.key === kpi.key)
      .reduce((acc, e) => acc + e.rawValue, 0);
    const avgValue = activeAssessorCount > 0 ? teamTotal / activeAssessorCount : 0;
    const avgPercent = target > 0 ? (avgValue / target) * 100 : 0;
    teamAvg.push({ label: kpi.label, avgValue, avgPercent });
  }

  // Badges
  const unlocks = await prisma.badgeUnlock.findMany({
    where: { assessorId },
    include: { badge: { select: { name: true } } },
  });
  const badges = unlocks.map((u) => u.badge.name);

  // Observações do período (notas + markers de reunião)
  const observations = entries
    .filter((e) => e.notes && e.notes.trim().length > 0)
    .map((e) => ({ date: formatDateOnly(e.date), note: e.notes! }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Streak + points + penalidade (from rollup) — agora com tipo correto incluindo notes
  const rollupEntries = entries.map((e) => ({
    pointsAwarded: e.pointsAwarded,
    convertedPercent: e.convertedPercent,
    rawValue: e.rawValue,
    date: e.date,
    notes: e.notes,
    kpi: e.kpi,
  }));
  const { computeAssessorRollup } = await import("./scoring.js");
  const rollup = computeAssessorRollup(rollupEntries, to);

  // Dias restantes no período
  const remainingMs = to.getTime() - today.getTime();
  const remainingDays = Math.max(0, Math.ceil(remainingMs / 86400000));

  const promptData: PromptData = {
    assessorName: assessor.name,
    period: periodKey,
    kpis: assessorKpis,
    teamAvg,
    streak: rollup.streak,
    points: rollup.points,
    penaltyDays: rollup.penaltyDays,
    penaltyPoints: rollup.penaltyPoints,
    observations,
    badges,
    remainingDays,
  };

  // Hash determinístico dos dados
  const inputHash = computeInputHash(promptData);

  // Cache check
  if (!force) {
    const cached = await prisma.aiInsight.findFirst({
      where: { assessorId, periodKind, periodKey, inputHash },
    });
    if (cached) {
      return {
        id: cached.id,
        textMarkdown: cached.textMarkdown,
        summary: cached.summary,
        tags: cached.tags,
        model: cached.model,
        cached: true,
        createdAt: cached.createdAt.toISOString(),
      };
    }
  }

  // Gerar via OpenRouter
  if (!app.openrouter.isConfigured) {
    throw new Error("OPENROUTER_API_KEY não configurada. Configure no .env pra habilitar insights IA.");
  }

  const prompt = buildPrompt(promptData);
  const model = app.openrouter.isConfigured ? (undefined as string | undefined) : undefined; // usa default

  const text = await app.openrouter.chat({
    messages: [
      { role: "user", content: prompt },
    ],
    maxTokens: 500,
    temperature: 0.7,
    model,
  });

  // Extrair summary (primeira linha) e tags
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const summary = lines[0]?.replace(/^#+\s*/, "").trim().slice(0, 200) ?? "";
  const tags: string[] = [];
  for (const kpi of assessorKpis) {
    if (kpi.percent >= 100) tags.push(`acima-meta-${kpi.label.toLowerCase()}`);
    if (kpi.percent < 50) tags.push(`critico-${kpi.label.toLowerCase()}`);
  }

  // Persist
  const saved = await prisma.aiInsight.create({
    data: {
      assessorId,
      periodKind,
      periodKey,
      model: app.openrouter.isConfigured ? "default" : "none",
      inputHash,
      textMarkdown: text,
      summary,
      tags,
    },
  });

  return {
    id: saved.id,
    textMarkdown: text,
    summary,
    tags,
    model: saved.model,
    cached: false,
    createdAt: saved.createdAt.toISOString(),
  };
}

// ─── Team insight ────────────────────────────────────────────────────────────

export interface GenerateTeamInsightParams {
  periodKind: InsightPeriod;
  periodKey: string;
  force?: boolean;
}

export async function generateTeamInsight(
  app: FastifyInstance,
  prisma: PrismaClient,
  params: GenerateTeamInsightParams,
): Promise<InsightResult> {
  const { periodKind, periodKey, force } = params;
  const { from, to } = periodRange(periodKind, periodKey);

  // Busca dados do time via buildOverview
  const { buildOverview } = await import("./reports.js");
  const overview = await buildOverview(prisma, { from, to });

  // Busca período anterior pra comparação delta
  const prevKey = previousPeriodKey(periodKind, periodKey);
  const prevRange = periodRange(periodKind, prevKey);
  const prevOverview = await buildOverview(prisma, { from: prevRange.from, to: prevRange.to });

  // Observações relevantes do período (notas com [REUNIAO]/[REUNIAO_AREA] ou texto livre)
  const periodObservations = await prisma.metricEntry.findMany({
    where: {
      date: { gte: from, lte: to },
      notes: { not: null },
    },
    include: { assessor: { select: { name: true } } },
    orderBy: { date: "desc" },
    take: 30, // limita pra não inflar prompt
  });

  // Penalidades agregadas: assessores ativos com gap days no período
  const allAssessors = await prisma.assessor.findMany({
    where: { active: true, OR: [{ vacationUntil: null }, { vacationUntil: { lt: to } }] },
    include: {
      metricEntries: {
        where: { date: { gte: from, lte: to } },
        include: { kpi: { select: { key: true } } },
      },
    },
  });
  const { computeAssessorRollup } = await import("./scoring.js");
  const penaltiesByAssessor = allAssessors
    .map((a) => {
      const rollup = computeAssessorRollup(a.metricEntries, to);
      return { name: a.name, penaltyDays: rollup.penaltyDays, penaltyPoints: rollup.penaltyPoints };
    })
    .filter((p) => p.penaltyDays > 0);

  // Projeção do time (regra de 3 simples por KPI)
  const today = new Date();
  const projections = overview.byKpi.map((k) => {
    const proj = projectLinear(k.actual, from, to, today);
    const projPct = k.target > 0 ? Math.round((proj.projected / k.target) * 100) : 0;
    return { label: k.label, ...proj, projectedPct: projPct };
  });

  const teamData = {
    period: periodKey,
    totalEntries: overview.totalMetricEntries,
    kpis: overview.byKpi.map((k) => ({
      label: k.label,
      actual: k.actual,
      target: k.target,
      percent: k.percent,
    })),
    kpisAnterior: prevOverview.byKpi.map((k) => ({
      label: k.label,
      actual: k.actual,
      percent: k.percent,
    })),
    projecoes: projections,
    topPerformers: overview.topPerformers.map((p) => ({
      name: p.name,
      points: p.points,
      pct: p.weeklyGoalPercent,
    })),
    bottomPerformers: overview.bottomPerformers.map((p) => ({
      name: p.name,
      points: p.points,
      pct: p.weeklyGoalPercent,
    })),
    penalidades: penaltiesByAssessor,
    observacoes: periodObservations.map((o) => ({
      assessor: o.assessor.name,
      date: formatDateOnly(o.date),
      note: o.notes ?? "",
    })),
  };

  const inputHash = computeInputHash(teamData);

  // Cache check (assessorId = null → team-level)
  if (!force) {
    const cached = await prisma.aiInsight.findFirst({
      where: { assessorId: null, squadId: null, periodKind, periodKey, inputHash },
    });
    if (cached) {
      return {
        id: cached.id,
        textMarkdown: cached.textMarkdown,
        summary: cached.summary,
        tags: cached.tags,
        model: cached.model,
        cached: true,
        createdAt: cached.createdAt.toISOString(),
      };
    }
  }

  if (!app.openrouter.isConfigured) {
    throw new Error("OPENROUTER_API_KEY não configurada.");
  }

  // Validação: sem registros → não gasta token
  if (teamData.totalEntries === 0) {
    throw new Error("Sem métricas registradas no período. Registre dados antes de gerar a análise do time.");
  }

  // KPI lines com delta vs período anterior
  const kpiLines = teamData.kpis
    .map((k) => {
      const prev = teamData.kpisAnterior.find((p) => p.label === k.label);
      const delta = prev && prev.actual > 0 ? Math.round(((k.actual - prev.actual) / prev.actual) * 100) : null;
      const deltaStr =
        delta === null ? "" : delta > 0 ? ` (↑${delta}% vs anterior)` : delta < 0 ? ` (↓${Math.abs(delta)}% vs anterior)` : ` (igual ao anterior)`;
      return `- ${k.label}: ${k.actual} de ${k.target} (${k.percent.toFixed(0)}%)${deltaStr}`;
    })
    .join("\n");

  // Projeções
  const projecaoLines = teamData.projecoes
    .filter((p) => p.remaining > 0) // só mostra se ainda tem dia restante
    .map(
      (p) =>
        `- ${p.label}: no ritmo de hoje, vai chegar a ~${p.projected} (${p.projectedPct}% da meta) até o fim do período`,
    )
    .join("\n");

  const topLines = teamData.topPerformers
    .map((p) => `- ${p.name}: ${p.points} pts, ${p.pct}% meta`)
    .join("\n");
  const botLines = teamData.bottomPerformers
    .map((p) => `- ${p.name}: ${p.points} pts, ${p.pct}% meta`)
    .join("\n");

  // Penalidades
  const penaltyLines =
    teamData.penalidades.length > 0
      ? teamData.penalidades
          .map((p) => `- ${p.name}: ${p.penaltyDays} dia(s) sem registro = -${p.penaltyPoints} pts`)
          .join("\n")
      : "(nenhuma — todo mundo registrou ou justificou)";

  // Observações com markers (reuniões registradas via observação)
  const meetingObs = teamData.observacoes.filter((o) =>
    o.note.startsWith("[REUNIAO]") || o.note.startsWith("[REUNIAO_AREA]"),
  );
  const meetingLines =
    meetingObs.length > 0
      ? meetingObs
          .slice(0, 10)
          .map((o) => `- ${o.assessor} em ${o.date}: ${o.note.replace(/^\[\w+\]\s*/, "")}`)
          .join("\n")
      : "(nenhuma reunião registrada via observação no período)";

  // KPIs críticos (abaixo de 30%)
  const criticos = teamData.kpis.filter((k) => k.percent < 30).map((k) => k.label);
  const fortes = teamData.kpis.filter((k) => k.percent >= 70).map((k) => k.label);

  const prompt = `Você é o diretor comercial de um escritório de assessoria de investimentos. Analise os dados do TIME e gere um relatório ESTRATÉGICO em português brasileiro. Use markdown. Máximo 350 palavras.

CONTEXTO: Escritório de investimentos com ${overview.topPerformers.length + overview.bottomPerformers.length}+ assessores. Cada um prospecta clientes (leads, ligações), agenda reuniões, faz alocações (boletas) e mantém a base (touchpoints, indicações). O objetivo é tornar vendas PREVISÍVEL: X leads → Y reuniões → Z conversões.

## Relatório do Time — ${periodKey}
Total de registros de atividade: ${teamData.totalEntries}

### KPIs agregados do escritório (com comparação vs período anterior):
${kpiLines}

### Projeção pra fim do período (regra de 3 sobre o ritmo atual):
${projecaoLines || "(período já terminou, sem projeção)"}

### Top 3 performers:
${topLines}

### 3 piores desempenhos:
${botLines}

### Penalidades por inatividade não justificada (-15 pts/dia):
${penaltyLines}

### Reuniões registradas via observação ([REUNIAO] = +10 pts, [REUNIAO_AREA] = +5 pts):
${meetingLines}

### Análise preliminar:
- KPIs fortes (≥70% da meta): ${fortes.length > 0 ? fortes.join(", ") : "nenhum"}
- KPIs críticos (<30% da meta): ${criticos.length > 0 ? criticos.join(", ") : "nenhum"}

### O que espero na sua análise:
1. VEREDICTO em 1 frase: o time está no ritmo, atrás, ou acima do esperado?
2. EVOLUÇÃO vs período anterior: melhorou ou piorou? Em quê especificamente?
3. ANÁLISE DE FUNIL: ligações → reuniões → conversões. Onde o funil está quebrando?
4. DISPARIDADE: qual a diferença entre o top 1 e o pior? O que o top faz que o pior não faz?
5. PROJEÇÃO: com base no ritmo atual, o time vai bater a meta? Se não, o que falta?
6. PENALIDADES: se há gente com -15pts, mencione direto e cobre disciplina.
7. 3 AÇÕES CONCRETAS pro gestor cobrar AMANHÃ (não genéricas — com números e nomes)
8. Se tem KPI ZERO ou <30%, trate como emergência e proponha plano de ação
9. Tom: diretor comercial pragmático. Sem emojis. Sem floreio. Dados na mão.`;

  const text = await app.openrouter.chat({
    messages: [{ role: "user", content: prompt }],
    maxTokens: 600,
    temperature: 0.7,
  });

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const summary = lines[0]?.replace(/^#+\s*/, "").trim().slice(0, 200) ?? "";
  const tags: string[] = [];
  for (const k of teamData.kpis) {
    if (k.percent >= 100) tags.push(`acima-meta-${k.label.toLowerCase()}`);
    if (k.percent < 30) tags.push(`critico-${k.label.toLowerCase()}`);
  }

  const saved = await prisma.aiInsight.create({
    data: {
      assessorId: null,
      squadId: null,
      periodKind,
      periodKey,
      model: "default",
      inputHash,
      textMarkdown: text,
      summary,
      tags,
    },
  });

  return {
    id: saved.id,
    textMarkdown: text,
    summary,
    tags,
    model: saved.model,
    cached: false,
    createdAt: saved.createdAt.toISOString(),
  };
}
