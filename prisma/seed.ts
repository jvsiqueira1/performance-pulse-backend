import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("🌱 Seeding...");

  // ─── Admin ────────────────────────────────────────────────────────────────
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "felipe@empresa.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "troque123";
  const adminName = process.env.SEED_ADMIN_NAME ?? "Felipe";

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: adminName,
      passwordHash: await bcrypt.hash(adminPassword, 10),
      role: "ADMIN",
    },
  });
  console.log(`  ✅ User admin: ${admin.email}`);

  // ─── KPIs ─────────────────────────────────────────────────────────────────
  const kpiDefs = [
    { key: "leads",             label: "Leads",             unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 10, sortOrder: 1 },
    { key: "cadencia",          label: "Cadência",          unit: "%", inputMode: "QUANTITY_OVER_BASE" as const, defaultTarget: 70, sortOrder: 2, baseSource: "listSize" },
    { key: "ligacoes",          label: "Ligações",          unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 30, sortOrder: 3 },
    { key: "reunioes",          label: "Reuniões Ag.",      unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 3,  sortOrder: 4 },
    { key: "indicacoes",        label: "Indicações",        unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 5,  sortOrder: 5 },
    { key: "boletos",           label: "Boletas",           unit: "",  inputMode: "ABSOLUTE" as const,           defaultTarget: 10, sortOrder: 6 },
    { key: "conversaoReuniao",  label: "Conv. Reunião",     unit: "%", inputMode: "PERCENT" as const,            defaultTarget: 20, sortOrder: 7, isDerived: true, derivedFormula: "reunioes / ligacoes" },
    { key: "conversaoFechamento", label: "Conv. Fechamento", unit: "%", inputMode: "PERCENT" as const,          defaultTarget: 30, sortOrder: 8, isDerived: true, derivedFormula: "CLOSED_WON / reunioes" },
  ];

  const kpis: Record<string, string> = {};
  for (const def of kpiDefs) {
    const kpi = await prisma.kpi.upsert({
      where: { key: def.key },
      update: {},
      create: def,
    });
    kpis[kpi.key] = kpi.id;
  }
  console.log(`  ✅ ${Object.keys(kpis).length} KPIs`);

  // ─── Goals (metas ativas) ─────────────────────────────────────────────────
  for (const def of kpiDefs) {
    if (def.isDerived) continue;
    await prisma.goal.upsert({
      where: { id: `seed-goal-${def.key}` },
      update: {},
      create: {
        id: `seed-goal-${def.key}`,
        kpiId: kpis[def.key],
        value: def.defaultTarget,
        period: def.key === "leads" || def.key === "indicacoes" ? "WEEKLY" : "DAILY",
        validFrom: new Date("2026-01-01"),
        validTo: null,
        createdById: admin.id,
      },
    });
  }
  console.log("  ✅ Goals seed");

  // ─── Assessores ───────────────────────────────────────────────────────────
  const assessorDefs = [
    { name: "Lucas Mendes",   initials: "LM" },
    { name: "Ana Beatriz",    initials: "AB" },
    { name: "Rafael Costa",   initials: "RC" },
    { name: "Mariana Silva",  initials: "MS" },
    { name: "Pedro Alves",    initials: "PA" },
    { name: "Juliana Rocha",  initials: "JR" },
  ];

  const assessorIds: string[] = [];
  for (const def of assessorDefs) {
    const a = await prisma.assessor.upsert({
      where: { id: `seed-${def.initials.toLowerCase()}` },
      update: {},
      create: {
        id: `seed-${def.initials.toLowerCase()}`,
        name: def.name,
        initials: def.initials,
      },
    });
    assessorIds.push(a.id);
  }
  console.log(`  ✅ ${assessorIds.length} assessores`);

  // ─── Activities (cronograma semanal) ──────────────────────────────────────
  const activityDefs = [
    // Segunda
    { name: "Geração Lista Prospecção",  dayOfWeek: 1, startTime: "09:00", endTime: "09:45", kpiKeys: ["leads"] },
    { name: "Cadência de Novos",         dayOfWeek: 1, startTime: "14:00", endTime: "14:45", kpiKeys: ["cadencia"] },
    // Terça
    { name: "Prospecção Ativa Bloco 1",  dayOfWeek: 2, startTime: "09:00", endTime: "09:45", kpiKeys: ["ligacoes", "reunioes"] },
    { name: "Prospecção Ativa Bloco 2",  dayOfWeek: 2, startTime: "14:00", endTime: "14:45", kpiKeys: ["ligacoes", "reunioes"] },
    // Quarta — Indique Day (BIWEEKLY) — quartas pares (anchor 2026-04-08)
    { name: "Indique Day",               dayOfWeek: 3, startTime: "09:00", endTime: "09:45", kpiKeys: ["indicacoes"],          cadenceType: "BIWEEKLY" as const, biweeklyAnchorDate: new Date("2026-04-08") },
    // Quarta — Prospecção Agendamento (BIWEEKLY) — quartas ímpares (anchor 2026-04-15, 7d off)
    { name: "Prospecção Agendamento",    dayOfWeek: 3, startTime: "09:00", endTime: "09:45", kpiKeys: ["ligacoes", "reunioes"], cadenceType: "BIWEEKLY" as const, biweeklyAnchorDate: new Date("2026-04-15") },
    // Quinta
    { name: "Cadência c/ Produto",       dayOfWeek: 4, startTime: "09:00", endTime: "09:45", kpiKeys: ["cadencia"] },
    { name: "Boleta Day",                dayOfWeek: 4, startTime: "14:00", endTime: "14:45", kpiKeys: ["boletos"] },
    // Sexta
    { name: "Touchpoint & Pós-venda",    dayOfWeek: 5, startTime: "09:00", endTime: "09:45", kpiKeys: ["indicacoes"] },
  ];

  let actIdx = 0;
  for (const def of activityDefs) {
    actIdx++;
    const act = await prisma.activity.upsert({
      where: { id: `seed-act-${actIdx}` },
      // Force-update cadenceType + anchor pra que re-rodar o seed corrija rows
      // existentes (Fase 5: Prospecção Agendamento mudou de WEEKLY → BIWEEKLY).
      update: {
        cadenceType: def.cadenceType ?? "WEEKLY",
        biweeklyAnchorDate: def.biweeklyAnchorDate ?? null,
      },
      create: {
        id: `seed-act-${actIdx}`,
        name: def.name,
        dayOfWeek: def.dayOfWeek,
        startTime: def.startTime,
        endTime: def.endTime,
        cadenceType: def.cadenceType ?? "WEEKLY",
        biweeklyAnchorDate: def.biweeklyAnchorDate ?? null,
        sortOrder: actIdx,
      },
    });

    for (const kpiKey of def.kpiKeys) {
      const kpiId = kpis[kpiKey];
      if (!kpiId) continue;
      await prisma.activityKpi.upsert({
        where: {
          activityId_kpiId: { activityId: act.id, kpiId },
        },
        update: {},
        create: { activityId: act.id, kpiId },
      });
    }
  }
  console.log(`  ✅ ${actIdx} activities`);

  // ─── Squads ───────────────────────────────────────────────────────────────
  const squad1 = await prisma.squad.upsert({
    where: { id: "seed-squad-alfa" },
    update: {},
    create: {
      id: "seed-squad-alfa",
      name: "Alfa Traders",
      emoji: "🐺",
      color: "hsl(142, 70%, 45%)",
      leaderId: assessorIds[0],
    },
  });
  const squad2 = await prisma.squad.upsert({
    where: { id: "seed-squad-beta" },
    update: {},
    create: {
      id: "seed-squad-beta",
      name: "Beta Capital",
      emoji: "🦅",
      color: "hsl(217, 91%, 60%)",
      leaderId: assessorIds[3],
    },
  });

  // Membros — idempotência via deleteMany+create (Postgres trata NULL como
  // distinct em unique com leftAt, então upsert não funciona corretamente).
  await prisma.squadMember.deleteMany({ where: { squadId: squad1.id } });
  await prisma.squadMember.deleteMany({ where: { squadId: squad2.id } });
  for (let i = 0; i < 3; i++) {
    await prisma.squadMember.create({
      data: { squadId: squad1.id, assessorId: assessorIds[i] },
    });
  }
  for (let i = 3; i < 6; i++) {
    await prisma.squadMember.create({
      data: { squadId: squad2.id, assessorId: assessorIds[i] },
    });
  }
  console.log("  ✅ 2 squads + membros");

  // ─── Badges ───────────────────────────────────────────────────────────────
  const badgeDefs = [
    // Individuais
    { slug: "hunter-elite",  name: "Hunter Elite",   description: "Cadência >= 100%",           icon: "🎯", scope: "INDIVIDUAL" as const, ruleJson: { kpiKey: "cadencia", op: ">=", value: 100, period: "WEEKLY" } },
    { slug: "closer-pro",    name: "Closer Pro",     description: "Reuniões >= 5 na semana",    icon: "🤝", scope: "INDIVIDUAL" as const, ruleJson: { kpiKey: "reunioes", op: ">=", value: 5, period: "WEEKLY" } },
    { slug: "prime-hein",    name: "Prime Hein",     description: "Indicações >= 10 no mês",    icon: "🌐", scope: "INDIVIDUAL" as const, ruleJson: { kpiKey: "indicacoes", op: ">=", value: 10, period: "MONTHLY" } },
    { slug: "maquina",       name: "Máquina",        description: "Streak >= 10 dias",          icon: "⚡", scope: "INDIVIDUAL" as const, ruleJson: { kind: "streak", op: ">=", value: 10 } },
    { slug: "monstro-sagrado", name: "Monstro Sagrado", description: "Semana completa",         icon: "👑", scope: "INDIVIDUAL" as const, ruleJson: { kind: "fullWeek" } },
    // Squad
    { slug: "squad-cadencia-master", name: "Cadência Master",   description: "Squad com cadência média >= 90%",           icon: "🔥", scope: "SQUAD" as const, ruleJson: { kind: "avgTeamKpi", kpiKey: "cadencia", op: ">=", value: 90 } },
    { slug: "squad-hunter",          name: "Hunter Squad",      description: "Squad com mais leads na semana",            icon: "🏹", scope: "SQUAD" as const, ruleJson: { kind: "topTeamKpi", kpiKey: "leads", period: "WEEKLY" } },
    { slug: "squad-closer",          name: "Closer Squad",      description: "Squad com mais reuniões na semana",         icon: "💼", scope: "SQUAD" as const, ruleJson: { kind: "topTeamKpi", kpiKey: "reunioes", period: "WEEKLY" } },
    { slug: "squad-invicto",         name: "Squad Invicto",     description: "Venceu 3 bets consecutivas",               icon: "🏆", scope: "SQUAD" as const, ruleJson: { kind: "consecutiveWins", count: 3 } },
    // Squad baseado em conquistas individuais
    { slug: "time-closer-pro",       name: "Time Closer Pro",   description: "70% do time bateu Closer Pro",             icon: "🤝🔥", scope: "SQUAD" as const, ruleJson: { kind: "teamHitIndividualBadge", badgeSlug: "closer-pro", pct: 0.7 } },
  ];

  for (const def of badgeDefs) {
    await prisma.badge.upsert({
      where: { slug: def.slug },
      update: {},
      create: def,
    });
  }
  console.log(`  ✅ ${badgeDefs.length} badges`);

  console.log("🌱 Seed concluído!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
