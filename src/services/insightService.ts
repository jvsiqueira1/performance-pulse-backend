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

// ─── Hash ────────────────────────────────────────────────────────────────────

function computeInputHash(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16);
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

interface PromptData {
  assessorName: string;
  period: string;
  kpis: Array<{ label: string; value: number; target: number; percent: number }>;
  teamAvg: Array<{ label: string; avgValue: number; avgPercent: number }>;
  streak: number;
  points: number;
  badges: string[];
}

function buildPrompt(data: PromptData): string {
  const kpiLines = data.kpis
    .map((k) => `- ${k.label}: ${k.value} (meta: ${k.target}, ${k.percent.toFixed(0)}%)`)
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

  return `Você é um coach/gestor de vendas de alto nível num escritório de investimentos. Analise os dados abaixo e gere uma análise ESTRATÉGICA e PRÁTICA em português brasileiro. Use markdown. Máximo 250 palavras.

CONTEXTO: Este é um escritório de assessoria de investimentos. Os assessores prospectam clientes, agendam reuniões, fazem alocações (boletas) e mantêm relacionamento com a base. O objetivo é tornar o processo de vendas PREVISÍVEL através de métricas.

## Assessor: ${data.assessorName}
Período: ${data.period}
Pontos acumulados: ${data.points} | Streak: ${data.streak} dias consecutivos
Conquistas: ${badgeStr}

### Métricas individuais:
${kpiLines}

### Comparativo com a média do time:
${teamLines}

### Dados de funil:
- Taxa de conversão ligações→reuniões: ${convRate}%
- Acima da média do time em: ${acimaDaMedia.length > 0 ? acimaDaMedia.join(", ") : "nenhum KPI"}
- Abaixo da média do time em: ${abaixoDaMedia.length > 0 ? abaixoDaMedia.join(", ") : "nenhum KPI"}

### Instruções pro modelo:
1. Comece com um VEREDICTO direto em 1 frase: este assessor está performando bem, na média, ou preocupante?
2. Analise o FUNIL: se faz muitas ligações mas poucas reuniões, o pitch precisa melhorar. Se marca reuniões mas não converte, o closing precisa de atenção.
3. Compare com o time: onde se destaca vs onde está ficando pra trás?
4. Dê 2-3 AÇÕES ESPECÍFICAS e PRÁTICAS que o gestor pode cobrar esta semana (não genéricas como "melhore a cadência" — diga "aumente de X pra Y focando em Z")
5. Se algum KPI está ZERO ou abaixo de 30% da meta, trate como URGÊNCIA
6. Se o assessor está acima da média em tudo, reconheça e sugira como manter/escalar
7. Tom: líder de vendas experiente que fala direto, sem floreio, com dados na mão. Não use emojis.`;
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

  // Agrega por KPI
  const assessorKpis: PromptData["kpis"] = [];
  const teamAvg: PromptData["teamAvg"] = [];

  for (const kpi of kpis) {
    const target = kpi.goals[0]?.value ?? kpi.defaultTarget;
    const assessorEntries = entries.filter((e) => e.kpiId === kpi.id);
    const value = assessorEntries.reduce((acc, e) => acc + e.rawValue, 0);
    const percent = target > 0 ? (value / target) * 100 : 0;
    assessorKpis.push({ label: kpi.label, value, target, percent });

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

  // Streak + points (from rollup)
  const rollupEntries = entries.map((e) => ({
    pointsAwarded: e.pointsAwarded,
    convertedPercent: e.convertedPercent,
    rawValue: e.rawValue,
    date: e.date,
    kpi: e.kpi,
  }));
  const { computeAssessorRollup } = await import("./scoring.js");
  const rollup = computeAssessorRollup(rollupEntries, to);

  const promptData: PromptData = {
    assessorName: assessor.name,
    period: periodKey,
    kpis: assessorKpis,
    teamAvg,
    streak: rollup.streak,
    points: rollup.points,
    badges,
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

  const teamData = {
    period: periodKey,
    totalEntries: overview.totalMetricEntries,
    kpis: overview.byKpi.map((k) => ({
      label: k.label,
      actual: k.actual,
      target: k.target,
      percent: k.percent,
    })),
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

  // Prompt de time
  const kpiLines = teamData.kpis
    .map((k) => `- ${k.label}: ${k.actual} de ${k.target} (${k.percent.toFixed(0)}%)`)
    .join("\n");
  const topLines = teamData.topPerformers
    .map((p) => `- ${p.name}: ${p.points} pts, ${p.pct}% meta`)
    .join("\n");
  const botLines = teamData.bottomPerformers
    .map((p) => `- ${p.name}: ${p.points} pts, ${p.pct}% meta`)
    .join("\n");

  // Validação: sem registros → não gasta token
  if (teamData.totalEntries === 0) {
    throw new Error("Sem métricas registradas no período. Registre dados antes de gerar a análise do time.");
  }

  // KPIs críticos (abaixo de 30%)
  const criticos = teamData.kpis.filter((k) => k.percent < 30).map((k) => k.label);
  const fortes = teamData.kpis.filter((k) => k.percent >= 70).map((k) => k.label);

  const prompt = `Você é o diretor comercial de um escritório de assessoria de investimentos. Analise os dados do TIME e gere um relatório ESTRATÉGICO em português brasileiro. Use markdown. Máximo 300 palavras.

CONTEXTO: Escritório de investimentos com ${overview.topPerformers.length + overview.bottomPerformers.length}+ assessores. Cada um prospecta clientes (leads, ligações), agenda reuniões, faz alocações (boletas) e mantém a base (touchpoints, indicações). O objetivo é tornar vendas PREVISÍVEL: X leads → Y reuniões → Z conversões.

## Relatório do Time — ${periodKey}
Total de registros de atividade: ${teamData.totalEntries}

### KPIs agregados do escritório:
${kpiLines}

### Top 3 performers:
${topLines}

### 3 piores desempenhos:
${botLines}

### Análise preliminar:
- KPIs fortes (≥70% da meta): ${fortes.length > 0 ? fortes.join(", ") : "nenhum"}
- KPIs críticos (<30% da meta): ${criticos.length > 0 ? criticos.join(", ") : "nenhum"}

### O que espero na sua análise:
1. VEREDICTO em 1 frase: o time está no ritmo, atrás, ou acima do esperado?
2. ANÁLISE DE FUNIL: ligações → reuniões → conversões. Onde o funil está quebrando?
3. DISPARIDADE: qual a diferença entre o top 1 e o pior? O que o top faz que o pior não faz?
4. 3 AÇÕES CONCRETAS pro gestor cobrar AMANHÃ (não genéricas — com números e nomes)
5. Se tem KPI ZERO ou <30%, trate como emergência e proponha plano de ação
6. PREVISÃO: com base no ritmo atual, o time vai bater a meta semanal/mensal?
7. Tom: diretor comercial pragmático. Sem emojis. Sem floreio. Dados na mão.`;

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
