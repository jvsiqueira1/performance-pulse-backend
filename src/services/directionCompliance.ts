/**
 * Compliance de direcionamento (Sprint B - Felipe).
 *
 * Pra cada Direction com `targetKpiKeys`, calcula:
 * - **realized**: soma de rawValue dos KPIs alvo no período da direction
 * - **baseline**: mesma soma no período IMEDIATAMENTE ANTERIOR (mesma duração)
 * - **deltaPct**: (realized - baseline) / baseline * 100 (null se baseline=0)
 *
 * Permite Felipe ver "essa semana o foco era ativação — bateu? em quanto?"
 */

import type { PrismaClient } from "../generated/prisma/client.js";
import { differenceInDays, subDays } from "date-fns";

export interface KpiCompliance {
  kpiKey: string;
  realized: number;
  baseline: number;
  deltaPct: number | null;
}

/**
 * Resolve range efetivo da direction.
 * Pra DAILY: usa a `date` como start E end.
 * Pra WEEKLY/MONTHLY: usa periodStart/periodEnd se existirem; senão fallback
 * pra `date` ± dias do período (segunda+6 dias pra weekly, etc).
 */
export function resolveDirectionRange(d: {
  date: Date;
  period: string;
  periodStart: Date | null;
  periodEnd: Date | null;
}): { start: Date; end: Date } {
  if (d.period === "DAILY") {
    return { start: d.date, end: d.date };
  }
  if (d.periodStart && d.periodEnd) {
    return { start: d.periodStart, end: d.periodEnd };
  }
  // Fallback: deriva do `date` (segunda) + 6 dias = domingo. Pra MONTHLY,
  // assumimos `date` é dia 1 e somamos 30 dias (aproximação suficiente).
  const days = d.period === "WEEKLY" ? 6 : 30;
  const end = new Date(d.date);
  end.setUTCDate(end.getUTCDate() + days);
  return { start: d.date, end };
}

export async function computeDirectionCompliance(
  prisma: PrismaClient,
  direction: {
    id: string;
    date: Date;
    period: string;
    periodStart: Date | null;
    periodEnd: Date | null;
    targetKpiKeys: string[];
  },
): Promise<KpiCompliance[]> {
  if (direction.targetKpiKeys.length === 0) return [];

  const { start, end } = resolveDirectionRange(direction);
  const lengthDays = Math.max(1, differenceInDays(end, start) + 1);
  const baselineEnd = subDays(start, 1);
  const baselineStart = subDays(start, lengthDays);

  // Busca os KPI ids correspondentes às keys
  const kpis = await prisma.kpi.findMany({
    where: { key: { in: direction.targetKpiKeys } },
    select: { id: true, key: true },
  });
  const kpiIdByKey = new Map(kpis.map((k) => [k.key, k.id]));

  const result: KpiCompliance[] = [];

  for (const key of direction.targetKpiKeys) {
    const kpiId = kpiIdByKey.get(key);
    if (!kpiId) {
      result.push({ kpiKey: key, realized: 0, baseline: 0, deltaPct: null });
      continue;
    }

    const [realized, baseline] = await Promise.all([
      prisma.metricEntry.aggregate({
        where: { kpiId, date: { gte: start, lte: end } },
        _sum: { rawValue: true },
      }),
      prisma.metricEntry.aggregate({
        where: { kpiId, date: { gte: baselineStart, lte: baselineEnd } },
        _sum: { rawValue: true },
      }),
    ]);

    const realizedSum = realized._sum.rawValue ?? 0;
    const baselineSum = baseline._sum.rawValue ?? 0;
    const deltaPct = baselineSum > 0
      ? ((realizedSum - baselineSum) / baselineSum) * 100
      : null;

    result.push({
      kpiKey: key,
      realized: realizedSum,
      baseline: baselineSum,
      deltaPct,
    });
  }

  return result;
}
