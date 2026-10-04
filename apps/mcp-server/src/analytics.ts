// Pure date/period and forecasting helpers (no I/O), unit-tested directly.
import type { StockRow } from './store.js';

const DAY_MS = 86_400_000;
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = typeof WEEKDAYS[number];

export function parseIsoDate(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`invalid_date:${value}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(ms) || formatIsoDate(ms) !== value) throw new Error(`invalid_date:${value}`);
  return ms;
}

export function formatIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return formatIsoDate(parseIsoDate(date) + days * DAY_MS);
}

/** ISO weekday index: 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(date: string): number {
  return (new Date(parseIsoDate(date)).getUTCDay() + 6) % 7;
}

export function weekdayName(date: string): Weekday {
  return WEEKDAYS[weekdayIndex(date)] ?? 'monday';
}

export function daysBetweenInclusive(start: string, end: string): number {
  return Math.round((parseIsoDate(end) - parseIsoDate(start)) / DAY_MS) + 1;
}

export type PeriodName = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'last_7_days' | 'last_30_days' | 'custom';
export type CompareMode = 'auto' | 'same_weekday_last_week' | 'previous_period' | 'none';

export interface DateRange {
  readonly start: string;
  readonly end: string;
  readonly label: string;
  /** True when the range includes today (sales still coming in). */
  readonly partial: boolean;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function resolvePeriod(period: PeriodName, today: string, custom?: { start?: string; end?: string }): DateRange {
  switch (period) {
    case 'today':
      return { start: today, end: today, label: 'today', partial: true };
    case 'yesterday': {
      const d = addDays(today, -1);
      return { start: d, end: d, label: 'yesterday', partial: false };
    }
    case 'this_week': {
      const monday = addDays(today, -weekdayIndex(today));
      return { start: monday, end: today, label: 'this week', partial: true };
    }
    case 'last_week': {
      const monday = addDays(today, -weekdayIndex(today) - 7);
      return { start: monday, end: addDays(monday, 6), label: 'last week', partial: false };
    }
    case 'last_7_days':
      return { start: addDays(today, -7), end: addDays(today, -1), label: 'the last 7 days', partial: false };
    case 'last_30_days':
      return { start: addDays(today, -30), end: addDays(today, -1), label: 'the last 30 days', partial: false };
    case 'custom': {
      const start = custom?.start;
      const end = custom?.end ?? custom?.start;
      if (!start || !end) throw new Error('custom_period_requires_start_date');
      parseIsoDate(start);
      parseIsoDate(end);
      if (start > end) throw new Error('custom_period_start_after_end');
      if (end > today) throw new Error('custom_period_in_future');
      const label = start === end ? `on ${describeDate(start, today)}` : `from ${describeDate(start, today)} to ${describeDate(end, today)}`;
      return { start, end, label, partial: end === today };
    }
  }
}

/** "today", "yesterday", "Wednesday" (2-6 days ago), "last Friday" (7 days ago), else "September 3". */
export function describeDate(date: string, today: string): string {
  if (date === today) return 'today';
  if (date === addDays(today, -1)) return 'yesterday';
  const diff = daysBetweenInclusive(date, today) - 1;
  const name = capitalize(weekdayName(date));
  if (diff > 1 && diff < 7) return name;
  if (diff === 7) return `last ${name}`;
  const d = new Date(parseIsoDate(date));
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `${month} ${d.getUTCDate()}`;
}

export function resolveComparison(
  range: DateRange,
  today: string,
  mode: CompareMode,
  compareWeekday?: Weekday
): DateRange | null {
  if (compareWeekday) {
    const target = WEEKDAYS.indexOf(compareWeekday);
    let back = (weekdayIndex(range.start) - target + 7) % 7;
    if (back === 0) back = 7;
    const d = addDays(range.start, -back);
    return { start: d, end: d, label: describeDate(d, today), partial: false };
  }
  const length = daysBetweenInclusive(range.start, range.end);
  const effective: CompareMode = mode === 'auto' ? (length === 1 ? 'same_weekday_last_week' : 'previous_period') : mode;
  if (effective === 'none') return null;
  if (effective === 'same_weekday_last_week') {
    const start = addDays(range.start, -7);
    const end = addDays(range.end, -7);
    const label = length === 1 ? `last ${capitalize(weekdayName(start))}` : 'the same days last week';
    return { start, end, label, partial: false };
  }
  const start = addDays(range.start, -length);
  const end = addDays(range.end, -length);
  const label = range.label === 'this week' ? 'the same days last week' : range.label === 'last week' ? 'the week before' : 'the previous period';
  return { start, end, label, partial: false };
}

/** On-hand divided by average daily sales; null when nothing sold recently. */
export function daysOfCover(row: Pick<StockRow, 'onHand' | 'avgDaily14d'>): number | null {
  if (row.avgDaily14d <= 0) return null;
  return Math.round((row.onHand / row.avgDaily14d) * 10) / 10;
}

export function isLowStock(row: Pick<StockRow, 'onHand' | 'minQty'>): boolean {
  return row.minQty > 0 && row.onHand <= row.minQty;
}

export function roundUpToPack(qty: number, packSize: number): number {
  const pack = packSize > 0 ? packSize : 1;
  return Math.ceil(qty / pack - 1e-9) * pack;
}

export const COVER_BUFFER_DAYS = 7;

/**
 * Suggested order quantity: cover target (lead time + 7 days) x forecast
 * (14-day average) minus on hand, rounded up to the pack size. Low-stock items
 * with no recent sales fall back to the rule's reorder_qty.
 */
export function suggestedOrderQty(row: StockRow): number {
  const target = (row.leadTimeDays + COVER_BUFFER_DAYS) * row.avgDaily14d;
  const needed = target - row.onHand;
  if (needed > 0) return roundUpToPack(needed, row.packSize);
  if (isLowStock(row) && row.reorderQty > 0) return roundUpToPack(row.reorderQty, row.packSize);
  return 0;
}

/** Items that need ordering now: at/below min, or would run out before the next delivery plus a small buffer. */
export function needsReorder(row: StockRow): boolean {
  if (isLowStock(row)) return true;
  const cover = daysOfCover(row);
  return cover !== null && cover <= row.leadTimeDays + 3;
}
