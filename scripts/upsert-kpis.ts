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

const KPI_DEFS = [
  { key: "leads",                label: "Leads",          unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 10, sortOrder: 1, period: "WEEKLY" as const },
  { key: "cadencia",             label: "Cadência",       unit: "%", inputMode: "QUANTITY_OVER_BASE" as const, defaultTarget: 70, sortOrder: 2, baseSource: "listSize", period: "DAILY" as const },
  { key: "ligacoes",             label: "Ligações",       unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 30, sortOrder: 3, period: "DAILY" as const },
  { key: "reunioes",             label: "Reuniões Ag.",   unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 3,  sortOrder: 4, period: "DAILY" as const },
  { key: "reunioes_realizadas",  label: "Reuniões Real.", unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 2,  sortOrder: 5, period: "DAILY" as const },
  { key: "touchpoint",           label: "Touch Point",    unit: "%", inputMode: "QUANTITY_OVER_BASE" as const, defaultTarget: 70, sortOrder: 6, baseSource: "totalClients", period: "DAILY" as const },
  { key: "ativacao_conta",       label: "Ativação Conta", unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 1,  sortOrder: 7, period: "DAILY" as const },
  { key: "indicacoes",           label: "Indicações",     unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 5,  sortOrder: 8, period: "WEEKLY" as const },
  { key: "boletos",              label: "Boletas",        unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 10, sortOrder: 9, period: "DAILY" as const },
  { key: "conversaoReuniao",     label: "Conv. Reunião",  unit: "%", inputMode: "PERCENT" as const,            defaultTarget: 20, sortOrder: 10, isDerived: true, derivedFormula: "reunioes / ligacoes", period: "WEEKLY" as const },
  { key: "conversaoFechamento",  label: "Conv. Fechamento", unit: "%", inputMode: "PERCENT" as const,         defaultTarget: 30, sortOrder: 11, isDerived: true, derivedFormula: "CLOSED_WON / reunioes", period: "WEEKLY" as const },
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

  for (const def of KPI_DEFS) {
    const before = await prisma.kpi.findUnique({ where: { key: def.key } });
    const kpi = await prisma.kpi.upsert({
      where: { key: def.key },
      create: {
        key: def.key,
        label: def.label,
        unit: def.unit,
        inputMode: def.inputMode,
        baseSource: "baseSource" in def ? def.baseSource : null,
        defaultTarget: def.defaultTarget,
        sortOrder: def.sortOrder,
        isDerived: "isDerived" in def && def.isDerived ? true : false,
        derivedFormula: "derivedFormula" in def ? def.derivedFormula : null,
      },
      update: {
        label: def.label,
        unit: def.unit,
        inputMode: def.inputMode,
        baseSource: "baseSource" in def ? def.baseSource : null,
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
    if ("isDerived" in def && def.isDerived) continue;

    const goalId = `seed-goal-${def.key}`;
    await prisma.goal.upsert({
      where: { id: goalId },
      create: {
        id: goalId,
        kpiId: kpi.id,
        value: def.defaultTarget,
        period: def.period,
        validFrom: new Date("2026-01-01"),
        validTo: null,
        createdById: admin.id,
      },
      update: {
        value: def.defaultTarget,
        period: def.period,
      },
    });
    goalsUpserted++;
  }

  console.log(`\n──────────────────────────────────────`);
  console.log(`✅ KPIs criados:       ${created}`);
  console.log(`🔄 KPIs atualizados:   ${updated}`);
  console.log(`🎯 Goals upserted:     ${goalsUpserted}`);
  console.log(`──────────────────────────────────────`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
