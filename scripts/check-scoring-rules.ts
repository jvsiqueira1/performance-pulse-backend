/**
 * Diagnóstico de ScoringRules — lista TODAS (ativas e inativas) pra descobrir
 * por que validate-scoring.ts reporta "SEM RULE" em todos KPIs.
 *
 * Só leitura, não modifica nada.
 *
 * Hipóteses:
 *   A) Rules existem mas active=false → ativar via SQL ou UI
 *   B) Rules nunca foram criadas → rodar `upsert-kpis.ts`
 *   C) Rules foram deletadas → rodar `upsert-kpis.ts`
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { env } from "../src/env.js";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("\n━━━ DIAGNÓSTICO DE SCORING RULES ━━━\n");

  const kpis = await prisma.kpi.findMany({
    where: { active: true, isDerived: false },
    orderBy: { sortOrder: "asc" },
    include: {
      scoringRule: true, // TODAS, inclusive inativas
    },
  });

  console.log(`KPIs ativos: ${kpis.length}\n`);
  console.log("KPI                       │ Rules (total) │ Rule ativa?          │ Detalhes");
  console.log("─".repeat(115));

  for (const kpi of kpis) {
    const rules = kpi.scoringRule;
    const active = rules.find((r) => r.active);
    const inactive = rules.filter((r) => !r.active);

    const activeStr = active
      ? `✓ ACTIVE (id ${active.id.slice(0, 8)})`
      : "✗ NENHUMA ATIVA";

    const detail = active
      ? active.ruleType === "LINEAR"
        ? `LINEAR: /${active.divisor} × ${active.pointsPerBucket} pts`
        : `THRESHOLD: ≥${active.thresholdPct}% → ${active.thresholdPoints} pts`
      : inactive.length > 0
        ? `${inactive.length} rule(s) INATIVA(s) no banco`
        : "sem rules no banco";

    console.log(
      `${kpi.label.padEnd(25)} │ ${String(rules.length).padEnd(13)} │ ${activeStr.padEnd(20)} │ ${detail}`
    );

    // Se há inativas, mostra detalhes
    if (!active && inactive.length > 0) {
      for (const r of inactive) {
        const d =
          r.ruleType === "LINEAR"
            ? `LINEAR: /${r.divisor} × ${r.pointsPerBucket}`
            : `THRESHOLD: ≥${r.thresholdPct}% → ${r.thresholdPoints}`;
        console.log(`${" ".repeat(25)} │ ${" ".repeat(13)} │ ${" ".repeat(20)} │   └ inativa: ${d}`);
      }
    }
  }

  // ─── Contagem total ─────────────────────────────────────────────────────
  const totalRules = await prisma.scoringRule.count();
  const activeRules = await prisma.scoringRule.count({ where: { active: true } });
  console.log(`\nTotal no banco: ${totalRules} rules (${activeRules} ativas, ${totalRules - activeRules} inativas)`);

  // ─── Sugestão de ação ───────────────────────────────────────────────────
  console.log("\n━━━ PRÓXIMOS PASSOS ━━━\n");
  if (activeRules === 0 && totalRules > 0) {
    console.log("⚠️  Todas as rules estão INATIVAS. Pode ter sido desativadas via UI admin.");
    console.log("   → Opção: ativar uma por uma no Admin → Metas & KPIs");
    console.log("   → Ou rodar: npx tsx scripts/upsert-kpis.ts (recria rules default do seed)");
  } else if (totalRules === 0) {
    console.log("⚠️  NENHUMA rule existe no banco. Provavelmente upsert-kpis nunca rodou aqui.");
    console.log("   → Rodar: npx tsx scripts/upsert-kpis.ts");
  } else if (activeRules < kpis.length) {
    console.log(`⚠️  ${kpis.length - activeRules} KPI(s) sem rule ativa.`);
    console.log("   → Revisar no Admin → Metas & KPIs qual KPI precisa de rule");
  } else {
    console.log("✅ Todas as rules estão OK.");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("❌ Erro:", err);
  process.exit(1);
});
