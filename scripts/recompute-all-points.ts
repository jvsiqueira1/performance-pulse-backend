/**
 * Recalcula `pointsAwarded` e `convertedPercent` de TODAS as MetricEntries
 * usando a nova fórmula (tabela oficial de pontos por evento, definida em
 * 16/04/2026).
 *
 * Como rodar:
 *   - Local:  npx tsx scripts/recompute-all-points.ts
 *   - No VPS: Terminal do container Coolify → mesmo comando
 *
 * Idempotente — pode rodar várias vezes. Cada vez aplica a fórmula atual
 * em cima do raw value.
 *
 * Comportamento:
 * - Itera todas as MetricEntries
 * - Pra cada uma: busca o KPI e a goal ativa naquela data
 * - Recalcula com `computeMetricFields` (lógica nova)
 * - Atualiza `pointsAwarded` e `convertedPercent` no banco
 * - PRESERVA bonus de [REUNIAO]/[REUNIAO_AREA] (re-detecta marker em notes)
 *
 * Atenção: pode levar minutos se houver milhares de entries.
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { env } from "../src/env.js";
import { computeMetricFields } from "../src/services/scoring.js";

const MEETING_NOTE_PREFIX = "[REUNIAO]";
const MEETING_BONUS_POINTS = 10;
const MEETING_AREA_PREFIX = "[REUNIAO_AREA]";
const MEETING_AREA_POINTS = 5;

async function main() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  console.log("🔎 Buscando todas as MetricEntries...");
  const entries = await prisma.metricEntry.findMany({
    include: { kpi: { include: { scoringRule: true } } },
    orderBy: { date: "asc" },
  });

  console.log(`📦 ${entries.length} entries encontradas. Recalculando...\n`);

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  // Cache de goals por (kpiId, date) pra não bater no DB toda vez
  const goalCache = new Map<string, { value: number } | null>();
  async function getGoal(kpiId: string, date: Date) {
    const key = `${kpiId}|${date.toISOString().slice(0, 10)}`;
    if (goalCache.has(key)) return goalCache.get(key) ?? null;
    const goal = await prisma.goal.findFirst({
      where: {
        kpiId,
        validFrom: { lte: date },
        OR: [{ validTo: null }, { validTo: { gt: date } }],
      },
      orderBy: { validFrom: "desc" },
    });
    goalCache.set(key, goal);
    return goal;
  }

  for (const e of entries) {
    try {
      const goal = await getGoal(e.kpiId, e.date);
      const computed = computeMetricFields(
        e.kpi,
        goal,
        e.rawValue,
        e.baseValue,
        e.kpi.scoringRule && e.kpi.scoringRule.active
          ? {
              ruleType: e.kpi.scoringRule.ruleType,
              divisor: e.kpi.scoringRule.divisor,
              pointsPerBucket: e.kpi.scoringRule.pointsPerBucket,
              thresholdPct: e.kpi.scoringRule.thresholdPct,
              thresholdPoints: e.kpi.scoringRule.thresholdPoints,
            }
          : null,
      );

      // Re-detecta markers de reunião nas notes (sobrescreve o cálculo padrão)
      const trimmedNotes = e.notes?.trimStart() ?? "";
      const isMeeting =
        trimmedNotes.startsWith(MEETING_NOTE_PREFIX) &&
        !trimmedNotes.startsWith(MEETING_AREA_PREFIX) &&
        trimmedNotes.slice(MEETING_NOTE_PREFIX.length).trim().length > 0;
      const isMeetingArea =
        trimmedNotes.startsWith(MEETING_AREA_PREFIX) &&
        trimmedNotes.slice(MEETING_AREA_PREFIX.length).trim().length > 0;

      let newPoints = computed.pointsAwarded;
      let newPercent: number | null = computed.convertedPercent;
      if (isMeeting) {
        newPoints = MEETING_BONUS_POINTS;
        newPercent = null;
      } else if (isMeetingArea) {
        newPoints = MEETING_AREA_POINTS;
        newPercent = null;
      }

      // Skip se nada mudou
      const samePoints = (e.pointsAwarded ?? 0) === newPoints;
      const samePercent =
        (e.convertedPercent === null && newPercent === null) ||
        (e.convertedPercent !== null &&
          newPercent !== null &&
          Math.abs(e.convertedPercent - newPercent) < 0.01);
      if (samePoints && samePercent) {
        unchanged++;
        continue;
      }

      await prisma.metricEntry.update({
        where: { id: e.id },
        data: {
          pointsAwarded: newPoints,
          convertedPercent: newPercent,
        },
      });
      updated++;
      if (updated % 50 === 0) console.log(`  ✏️  ${updated} atualizadas...`);
    } catch (err) {
      console.error(
        `❌ Entry ${e.id} (kpi=${e.kpi.key} date=${e.date.toISOString().slice(0, 10)}): ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }
  }

  console.log(`\n──────────────────────────────────────`);
  console.log(`✅ Atualizadas:    ${updated}`);
  console.log(`⏭️  Sem mudança:    ${unchanged}`);
  console.log(`❌ Falhas:         ${failed}`);
  console.log(`──────────────────────────────────────`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
