/**
 * Validador de pontuação — confere se o que está salvo no banco bate com o
 * que as scoring rules atuais dizem. Imprime passo-a-passo pra Felipe
 * validar "essa cadência DEVERIA dar X pts porque: raw=21, base=30, %=70 ≥ 70 → 10 pts".
 *
 * Uso:
 *   Local:  npx tsx scripts/validate-scoring.ts
 *   VPS:    docker exec ... npx tsx scripts/validate-scoring.ts
 *
 * NÃO modifica nada. Só leitura + prints.
 *
 * Output:
 *   1. Tabela de KPIs: rule + goal + threshold
 *   2. Pra cada KPI: últimas 5 entries com ponto a ponto
 *   3. Divergências saved vs expected (se houver)
 *   4. Resumo final
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { env } from "../src/env.js";
import { computeMetricFields } from "../src/services/scoring.js";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const ENTRIES_PER_KPI = 5;

function fmtRule(rule: {
  ruleType: string;
  divisor: number | null;
  pointsPerBucket: number | null;
  thresholdPct: number | null;
  thresholdPoints: number | null;
} | null): string {
  if (!rule) return "SEM RULE (0 pts sempre)";
  if (rule.ruleType === "LINEAR") {
    return `LINEAR: floor(raw / ${rule.divisor}) × ${rule.pointsPerBucket} pts`;
  }
  return `THRESHOLD_PERCENT: pct ≥ ${rule.thresholdPct}% → ${rule.thresholdPoints} pts`;
}

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║   VALIDADOR DE PONTUAÇÃO — Performance Pulse                   ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  // scoringRule é 1:1 — não aceita `where` no include. Busca tudo, filtra
  // active em memória.
  const kpis = await prisma.kpi.findMany({
    where: { active: true, isDerived: false },
    orderBy: { sortOrder: "asc" },
    include: {
      scoringRule: true,
      goals: {
        where: { validTo: null },
        orderBy: { validFrom: "desc" },
        take: 1,
      },
    },
  });

  // ─── Tabela resumo de configuração ─────────────────────────────────────────
  console.log("━━━ CONFIGURAÇÃO ATUAL ━━━\n");
  console.log(
    "KPI                       │ Mode   │ Meta (período)      │ Regra de pontuação"
  );
  console.log("─".repeat(100));
  for (const kpi of kpis) {
    const rule = kpi.scoringRule && kpi.scoringRule.active ? kpi.scoringRule : null;
    const goal = kpi.goals[0];
    const metaStr = goal
      ? `${goal.value} (${goal.period})`
      : `${kpi.defaultTarget} (default)`;
    console.log(
      `${kpi.label.padEnd(25)} │ ${kpi.inputMode.padEnd(6)} │ ${metaStr.padEnd(19)} │ ${fmtRule(rule)}`
    );
  }

  // ─── Últimas N entries por KPI com recálculo ──────────────────────────────
  console.log("\n\n━━━ VALIDAÇÃO DE ENTRIES RECENTES ━━━\n");

  let totalChecked = 0;
  let totalMismatches = 0;
  const mismatches: string[] = [];

  for (const kpi of kpis) {
    const rule = kpi.scoringRule && kpi.scoringRule.active ? kpi.scoringRule : null;
    const entries = await prisma.metricEntry.findMany({
      where: { kpiId: kpi.id },
      orderBy: { date: "desc" },
      take: ENTRIES_PER_KPI,
      include: { assessor: { select: { name: true } } },
    });

    if (entries.length === 0) continue;

    console.log(`\n┌─ ${kpi.label} (${kpi.inputMode}) ─ regra: ${fmtRule(rule)}`);

    for (const e of entries) {
      const goalAtDate = await prisma.goal.findFirst({
        where: {
          kpiId: kpi.id,
          validFrom: { lte: e.date },
          OR: [{ validTo: null }, { validTo: { gte: e.date } }],
        },
        orderBy: { validFrom: "desc" },
      });

      const { convertedPercent, pointsAwarded } = computeMetricFields(
        {
          key: kpi.key,
          inputMode: kpi.inputMode as "ABSOLUTE" | "PERCENT" | "QUANTITY_OVER_BASE",
          defaultTarget: kpi.defaultTarget,
        },
        goalAtDate ? { value: goalAtDate.value } : null,
        e.rawValue,
        e.baseValue,
        rule
          ? {
              ruleType: rule.ruleType as "LINEAR" | "THRESHOLD_PERCENT",
              divisor: rule.divisor,
              pointsPerBucket: rule.pointsPerBucket,
              thresholdPct: rule.thresholdPct,
              thresholdPoints: rule.thresholdPoints,
            }
          : null
      );

      const savedPts = e.pointsAwarded ?? 0;
      const match = Math.abs(savedPts - pointsAwarded) < 0.01;
      // Sem rule: valor "esperado" é sempre 0 (após 22/04). Se salvo > 0,
      // foi calculado sob regras antigas — sinalizar como LEGACY, não BUG.
      const marker = !rule ? (savedPts > 0 ? "⚠" : "✓") : match ? "✓" : "✗";

      const rawInfo = kpi.inputMode === "QUANTITY_OVER_BASE"
        ? `raw=${e.rawValue}/base=${e.baseValue ?? "NULL"}`
        : `raw=${e.rawValue}`;

      const reason = explainPoints(
        kpi.inputMode as "ABSOLUTE" | "PERCENT" | "QUANTITY_OVER_BASE",
        rule,
        e.rawValue,
        e.baseValue,
        convertedPercent,
        pointsAwarded
      );

      const dateStr = e.date.toISOString().slice(0, 10);
      console.log(
        `│  ${marker} ${dateStr} ${e.assessor.name.padEnd(20)} ${rawInfo.padEnd(25)} → ${convertedPercent.toFixed(0)}% = ${pointsAwarded} pts (salvo: ${savedPts}) | ${reason}`
      );

      totalChecked++;
      // Divergência real só quando HÁ rule e não bate. Sem rule, saved>0 é
      // valor legado (rules antigas) — informativo, não erro.
      if (rule && !match) {
        totalMismatches++;
        mismatches.push(
          `  ${kpi.label} / ${e.assessor.name} / ${dateStr}: salvo=${savedPts}, esperado=${pointsAwarded}`
        );
      }
    }
  }

  // ─── Resumo ────────────────────────────────────────────────────────────────
  console.log("\n\n━━━ RESUMO ━━━\n");
  console.log(`Total conferido: ${totalChecked} entries`);
  console.log(`Pontos corretos: ${totalChecked - totalMismatches}`);
  console.log(`Divergências:    ${totalMismatches}`);
  if (totalMismatches > 0) {
    console.log("\n⚠️  DIVERGÊNCIAS ENCONTRADAS (rode recompute-all-points.ts pra corrigir):");
    for (const m of mismatches) console.log(m);
  } else {
    console.log("\n✅ Tudo batendo com as rules atuais.");
  }

  // Alerta se muitos KPIs sem rule
  const kpisSemRule = kpis.filter((k) => !k.scoringRule || !k.scoringRule.active).length;
  if (kpisSemRule > 0) {
    console.log(`\n⚠️  ${kpisSemRule} KPI(s) SEM scoring rule ativa — ninguém pontua neles.`);
    console.log("   Rode: npx tsx scripts/check-scoring-rules.ts  (diagnóstico)");
    console.log("   Ou:   npx tsx scripts/upsert-kpis.ts          (recria rules default)");
  }

  await prisma.$disconnect();
}

/**
 * Explica EM TEXTO por que a entry ganhou X pts. Felipe usa pra validar
 * se a regra tá do jeito que ele espera.
 */
function explainPoints(
  inputMode: "ABSOLUTE" | "PERCENT" | "QUANTITY_OVER_BASE",
  rule: {
    ruleType: string;
    divisor: number | null;
    pointsPerBucket: number | null;
    thresholdPct: number | null;
    thresholdPoints: number | null;
  } | null,
  rawValue: number,
  baseValue: number | null,
  pct: number,
  pts: number
): string {
  if (!rule) return "sem rule";
  if (rule.ruleType === "LINEAR") {
    const buckets = Math.floor(rawValue / (rule.divisor ?? 1));
    return `floor(${rawValue}/${rule.divisor})=${buckets} × ${rule.pointsPerBucket} = ${pts}`;
  }
  // THRESHOLD_PERCENT
  if (inputMode === "QUANTITY_OVER_BASE") {
    if (!baseValue || baseValue <= 0) return "base NULL → 0%";
    return `${rawValue}/${baseValue}=${pct.toFixed(0)}% ${pct >= (rule.thresholdPct ?? 0) ? "≥" : "<"} ${rule.thresholdPct}%`;
  }
  return `${pct.toFixed(0)}% ${pct >= (rule.thresholdPct ?? 0) ? "≥" : "<"} ${rule.thresholdPct}%`;
}

main().catch((err) => {
  console.error("❌ Erro:", err);
  process.exit(1);
});
