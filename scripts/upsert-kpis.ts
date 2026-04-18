/**
 * Upsert dos KPIs oficiais (definição + goal ativa). Idempotente — pode rodar
 * quantas vezes quiser. Não mexe em entries/pontuações existentes.
 *
 * Como rodar:
 *   - Local:  npx tsx scripts/upsert-kpis.ts
 *   - No VPS: Terminal do container Coolify → mesmo comando
 *
 * Útil quando o seed completo não rodou em prod (ex: deploy novo do schema
 * mas o seed ficou de fora). Esse script garante que os KPIs definidos pelo
 * Felipe (incluindo os novos: reunioes_realizadas, touchpoint, ativacao_conta)
 * existam em qualquer ambiente.
 *
 * Pra cada KPI:
 * 1. UPSERT na tabela kpis (cria ou atualiza label/unit/inputMode/etc.)
 * 2. UPSERT da goal ativa (1 goal por KPI, validFrom: 2026-01-01)
 *
 * Pra evoluir a tabela: edite a const KPI_DEFS abaixo e re-rode o script.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { env } from "../src/env.js";

// Tabela oficial de pontuação (definida em 16/04, configurável via UI a partir de 17/04).
// Esses valores são o BASELINE — pra mudar pesos depois, edite via Admin → Metas & KPIs.
type RuleSpec =
  | { type: "LINEAR"; divisor: number; pointsPerBucket: number }
  | { type: "THRESHOLD_PERCENT"; thresholdPct: number; thresholdPoints: number };

const KPI_DEFS: Array<{
  key: string;
  label: string;
  unit: string;
  inputMode: "ABSOLUTE" | "PERCENT" | "QUANTITY_OVER_BASE";
  defaultTarget: number;
  sortOrder: number;
  baseSource?: string;
  period?: "DAILY" | "WEEKLY" | "MONTHLY";
  isDerived?: boolean;
  derivedFormula?: string;
  rule?: RuleSpec;
}> = [
  { key: "leads",                label: "Leads",          unit: "",  inputMode: "ABSOLUTE",           defaultTarget: 10, sortOrder: 1, period: "WEEKLY", rule: { type: "LINEAR", divisor: 1,  pointsPerBucket: 1 } },
  { key: "cadencia",             label: "Cadência",       unit: "%", inputMode: "QUANTITY_OVER_BASE", defaultTarget: 70, sortOrder: 2, baseSource: "listSize", period: "DAILY", rule: { type: "THRESHOLD_PERCENT", thresholdPct: 70, thresholdPoints: 5 } },
  { key: "ligacoes",             label: "Ligações",       unit: "",  inputMode: "ABSOLUTE",           defaultTarget: 30, sortOrder: 3, period: "DAILY", rule: { type: "LINEAR", divisor: 30, pointsPerBucket: 5 } },
  { key: "reunioes",             label: "Reuniões Ag.",   unit: "",  inputMode: "ABSOLUTE",           defaultTarget: 3,  sortOrder: 4, period: "DAILY", rule: { type: "LINEAR", divisor: 1,  pointsPerBucket: 5 } },
  { key: "reunioes_realizadas",  label: "Reuniões Real.", unit: "",  inputMode: "ABSOLUTE",           defaultTarget: 2,  sortOrder: 5, period: "DAILY", rule: { type: "LINEAR", divisor: 1,  pointsPerBucket: 10 } },
  { key: "touchpoint",           label: "Touch Point",    unit: "%", inputMode: "QUANTITY_OVER_BASE", defaultTarget: 70, sortOrder: 6, baseSource: "totalClients", period: "DAILY", rule: { type: "LINEAR", divisor: 1, pointsPerBucket: 1 } },
  { key: "ativacao_conta",       label: "Ativação Conta", unit: "",  inputMode: "ABSOLUTE",           defaultTarget: 1,  sortOrder: 7, period: "DAILY", rule: { type: "LINEAR", divisor: 1,  pointsPerBucket: 10 } },
  { key: "indicacoes",           label: "Indicações",     unit: "",  inputMode: "ABSOLUTE",           defaultTarget: 5,  sortOrder: 8, period: "WEEKLY", rule: { type: "LINEAR", divisor: 1,  pointsPerBucket: 2.5 } },
  { key: "boletos",              label: "Boletas",        unit: "",  inputMode: "ABSOLUTE",           defaultTarget: 10, sortOrder: 9, period: "DAILY", rule: { type: "LINEAR", divisor: 10, pointsPerBucket: 1 } },
  { key: "conversaoReuniao",     label: "Conv. Reunião",  unit: "%", inputMode: "PERCENT",            defaultTarget: 20, sortOrder: 10, isDerived: true, derivedFormula: "reunioes / ligacoes", period: "WEEKLY" },
  { key: "conversaoFechamento",  label: "Conv. Fechamento", unit: "%", inputMode: "PERCENT",         defaultTarget: 30, sortOrder: 11, isDerived: true, derivedFormula: "CLOSED_WON / reunioes", period: "WEEKLY" },
];

async function main() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  // Precisa de um admin pra createdById das goals
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  if (!admin) {
    console.error("❌ Nenhum admin encontrado. Rode o seed completo primeiro.");
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`📦 Upserting ${KPI_DEFS.length} KPIs...`);

  let created = 0;
  let updated = 0;
  let goalsUpserted = 0;
  let rulesUpserted = 0;

  for (const def of KPI_DEFS) {
    const before = await prisma.kpi.findUnique({ where: { key: def.key } });
    const kpi = await prisma.kpi.upsert({
      where: { key: def.key },
      create: {
        key: def.key,
        label: def.label,
        unit: def.unit,
        inputMode: def.inputMode,
        baseSource: def.baseSource ?? null,
        defaultTarget: def.defaultTarget,
        sortOrder: def.sortOrder,
        isDerived: def.isDerived ?? false,
        derivedFormula: def.derivedFormula ?? null,
      },
      update: {
        label: def.label,
        unit: def.unit,
        inputMode: def.inputMode,
        baseSource: def.baseSource ?? null,
        defaultTarget: def.defaultTarget,
        sortOrder: def.sortOrder,
      },
    });
    if (before) {
      console.log(`  🔄 ${def.key} atualizado`);
      updated++;
    } else {
      console.log(`  ✅ ${def.key} criado`);
      created++;
    }

    // Goal ativa (skip se KPI é derivado)
    if (def.isDerived) continue;

    const goalId = `seed-goal-${def.key}`;
    await prisma.goal.upsert({
      where: { id: goalId },
      create: {
        id: goalId,
        kpiId: kpi.id,
        value: def.defaultTarget,
        period: def.period ?? "DAILY",
        validFrom: new Date("2026-01-01"),
        validTo: null,
        createdById: admin.id,
      },
      update: {
        value: def.defaultTarget,
        period: def.period ?? "DAILY",
      },
    });
    goalsUpserted++;

    // ScoringRule (só upsert se a regra default ainda não foi customizada).
    // Pra evitar sobrescrever ajustes que Felipe fez via UI: se já existir
    // rule pro KPI, deixa em paz. Pra rodar com sobrescrita, deletar rule antes.
    if (def.rule) {
      const existingRule = await prisma.scoringRule.findUnique({
        where: { kpiId: kpi.id },
      });
      if (!existingRule) {
        await prisma.scoringRule.create({
          data: {
            kpiId: kpi.id,
            ruleType: def.rule.type,
            divisor: def.rule.type === "LINEAR" ? def.rule.divisor : null,
            pointsPerBucket: def.rule.type === "LINEAR" ? def.rule.pointsPerBucket : null,
            thresholdPct: def.rule.type === "THRESHOLD_PERCENT" ? def.rule.thresholdPct : null,
            thresholdPoints: def.rule.type === "THRESHOLD_PERCENT" ? def.rule.thresholdPoints : null,
          },
        });
        rulesUpserted++;
        console.log(`     ➕ regra default criada (${def.rule.type})`);
      }
    }
  }

  console.log(`\n──────────────────────────────────────`);
  console.log(`✅ KPIs criados:       ${created}`);
  console.log(`🔄 KPIs atualizados:   ${updated}`);
  console.log(`🎯 Goals upserted:     ${goalsUpserted}`);
  console.log(`📐 Regras criadas:     ${rulesUpserted}`);
  console.log(`──────────────────────────────────────`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
