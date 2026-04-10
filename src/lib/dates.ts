import {
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  addDays,
  addMonths,
} from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

/**
 * Helpers de data conscientes do fuso de São Paulo.
 *
 * Por que isso importa: Felipe digita métricas durante o dia BRT. Se o backend
 * rodar em UTC e ele digitar às 21:30 BRT (00:30 UTC do dia seguinte), a data
 * registrada precisa ser "hoje" do ponto de vista BRT, não do UTC.
 *
 * Estratégia: tratamos `MetricEntry.date` como "data civil" (sem hora). Sempre
 * armazenamos o YYYY-MM-DD do fuso BRT, materializado como Date às 00:00 UTC
 * do mesmo dia (Postgres @db.Date trunca a hora).
 */

export const APP_TZ = "America/Sao_Paulo";

/** Hoje no fuso BRT, retornado como Date 00:00 UTC do mesmo dia civil. */
export function todayInAppTz(): Date {
  const todayStr = formatInTimeZone(new Date(), APP_TZ, "yyyy-MM-dd");
  return new Date(`${todayStr}T00:00:00.000Z`);
}

/** Parsing seguro de "YYYY-MM-DD" (interpreta como meia-noite UTC do mesmo dia). */
export function parseDateOnly(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Data inválida (esperado YYYY-MM-DD): ${s}`);
  }
  return new Date(`${s}T00:00:00.000Z`);
}

/** Formata Date como "YYYY-MM-DD" usando os componentes UTC. */
export function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Início da semana (segunda-feira 00:00 UTC) baseada no dia recebido. */
export function weekStart(d: Date = todayInAppTz()): Date {
  const monday = startOfWeek(d, { weekStartsOn: 1 });
  return new Date(`${formatDateOnly(monday)}T00:00:00.000Z`);
}

/** Fim da semana (domingo 00:00 UTC) baseada no dia recebido. */
export function weekEnd(d: Date = todayInAppTz()): Date {
  const sunday = endOfWeek(d, { weekStartsOn: 1 });
  return new Date(`${formatDateOnly(sunday)}T00:00:00.000Z`);
}

/** Início do mês (dia 1 00:00 UTC) baseada no dia recebido. */
export function monthStart(d: Date = todayInAppTz()): Date {
  const first = startOfMonth(d);
  return new Date(`${formatDateOnly(first)}T00:00:00.000Z`);
}

/** Fim do mês (último dia 00:00 UTC) baseada no dia recebido. */
export function monthEnd(d: Date = todayInAppTz()): Date {
  const last = endOfMonth(d);
  return new Date(`${formatDateOnly(last)}T00:00:00.000Z`);
}

// ─── Time series bucketing ───────────────────────────────────────────────────

export type Granularity = "day" | "week" | "month";

export interface DateBucket {
  /** Início do bucket (00:00 UTC do primeiro dia do bucket, inclusivo). */
  start: Date;
  /** Fim do bucket (00:00 UTC do último dia do bucket, INCLUSIVO). */
  end: Date;
  /** Label pro eixo do gráfico: "2026-04-08" (day), "2026-W15" (week), "2026-04" (month). */
  label: string;
  /** Label curto pra display em pt-BR: "08/04", "Sem 15", "Abr". */
  displayLabel: string;
}

/**
 * Quebra o range [from, to] em buckets segundo a granularity.
 * - day: um bucket por dia civil
 * - week: buckets segunda-domingo (weekStartsOn:1). Primeiro/último podem ser parciais.
 * - month: buckets startOfMonth→endOfMonth. Primeiro/último podem ser parciais.
 */
export function buildDateBuckets(from: Date, to: Date, granularity: Granularity): DateBucket[] {
  if (to < from) return [];
  const buckets: DateBucket[] = [];

  if (granularity === "day") {
    let cursor = from;
    while (cursor <= to) {
      buckets.push({
        start: cursor,
        end: cursor,
        label: formatDateOnly(cursor),
        displayLabel: formatInTimeZone(cursor, "UTC", "dd/MM"),
      });
      cursor = addDays(cursor, 1);
    }
    return buckets;
  }

  if (granularity === "week") {
    let cursor = weekStart(from);
    while (cursor <= to) {
      const start = cursor < from ? from : cursor;
      const weekEndDate = weekEnd(cursor);
      const end = weekEndDate > to ? to : weekEndDate;
      buckets.push({
        start,
        end,
        label: formatInTimeZone(cursor, "UTC", "yyyy-'W'II"),
        displayLabel: `Sem ${formatInTimeZone(cursor, "UTC", "II")}`,
      });
      cursor = addDays(weekEndDate, 1);
    }
    return buckets;
  }

  // month
  let cursor = monthStart(from);
  while (cursor <= to) {
    const start = cursor < from ? from : cursor;
    const mEnd = monthEnd(cursor);
    const end = mEnd > to ? to : mEnd;
    buckets.push({
      start,
      end,
      label: formatInTimeZone(cursor, "UTC", "yyyy-MM"),
      displayLabel: formatInTimeZone(cursor, "UTC", "MMM/yy"),
    });
    cursor = addMonths(cursor, 1);
  }
  return buckets;
}
