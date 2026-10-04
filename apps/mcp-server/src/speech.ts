// Voice-first formatting helpers. Every tool answer is spoken aloud, so
// answers must be short (<= MAX_SPOKEN_WORDS), round numbers, always say
// units, and never read long lists.

export const MAX_SPOKEN_WORDS = 35;
export const MAX_LIST_ITEMS = 3;

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Picks the first candidate that fits the word budget. Candidates should be
 * ordered from most to least detailed. If none fit, the last one is cut at
 * the budget and closed with a period.
 */
export function fitSpeech(candidates: readonly string[], maxWords = MAX_SPOKEN_WORDS): string {
  for (const candidate of candidates) {
    if (countWords(candidate) <= maxWords) return candidate.trim();
  }
  const last = candidates[candidates.length - 1] ?? '';
  const words = last.trim().split(/\s+/).slice(0, maxWords);
  return `${words.join(' ').replace(/[,;:]+$/, '')}${/[.?!]$/.test(words[words.length - 1] ?? '') ? '' : '.'}`;
}

const IRREGULAR_PLURALS: Record<string, string> = {
  loaf: 'loaves',
  box: 'boxes',
  bunch: 'bunches',
  piece: 'pieces',
  case: 'cases'
};

export function pluralize(unit: string, qty: number): string {
  if (Math.abs(qty) === 1) return unit;
  const irregular = IRREGULAR_PLURALS[unit];
  if (irregular) return irregular;
  if (/(s|x|z|ch|sh)$/.test(unit)) return `${unit}es`;
  return `${unit}s`;
}

export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** "13 cartons", "1 loaf". Quantities are rounded to whole units for speech. */
export function formatQty(qty: number, unit: string | null | undefined): string {
  const rounded = Math.round(qty);
  const u = (unit ?? '').trim() || 'unit';
  return `${formatNumber(rounded)} ${pluralize(u, rounded)}`;
}

export interface MoneyFormat {
  readonly currency: string;
  readonly vndPerUnit: number;
}

export function vndToDisplay(vnd: number, money: MoneyFormat): number {
  return Math.round((vnd / money.vndPerUnit) * 100) / 100;
}

/** Spoken money in the shop's display currency: "$1,240", "$42", "2.4 million dong". */
export function formatMoney(vnd: number, money: MoneyFormat): string {
  if (money.currency === 'VND') {
    const abs = Math.abs(vnd);
    if (abs >= 1_000_000_000) return `${roundTo(vnd / 1_000_000_000, 1)} billion dong`;
    if (abs >= 1_000_000) return `${roundTo(vnd / 1_000_000, 1)} million dong`;
    if (abs >= 1_000) return `${Math.round(vnd / 1_000)} thousand dong`;
    return `${Math.round(vnd)} dong`;
  }
  const amount = vnd / money.vndPerUnit;
  const symbol = money.currency === 'USD' ? '$' : money.currency === 'EUR' ? '€' : '';
  const suffix = symbol ? '' : ` ${money.currency}`;
  const text = Math.abs(amount) >= 10 ? formatNumber(amount) : amount.toFixed(2);
  return `${symbol}${text}${suffix}`;
}

function roundTo(value: number, digits: number): string {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(digits);
}

/** "a, b and c" */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Speaks at most MAX_LIST_ITEMS entries, then "and N more".
 * Returns the phrase plus how many were omitted.
 */
export function speakList(items: readonly string[], max = MAX_LIST_ITEMS, separator = '; '): string {
  if (items.length <= max) {
    return items.length <= 2 ? joinList(items) : `${items.slice(0, -1).join(separator)}${separator}and ${items[items.length - 1]}`;
  }
  const shown = items.slice(0, max);
  return `${shown.join(separator)}${separator}and ${items.length - max} more`;
}

const SMALL_NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** "Four", "12" — spell small counts at the start of a sentence. */
export function countWord(n: number, capitalize = false): string {
  const word = n >= 0 && n <= 10 ? SMALL_NUMBERS[n] ?? String(n) : formatNumber(n);
  return capitalize ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

export function formatDaysLeft(days: number | null): string {
  if (days === null) return 'no recent sales';
  if (days < 1) return 'under a day left';
  const d = Math.floor(days);
  return `${d} ${d === 1 ? 'day' : 'days'} left`;
}

export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export function describeChange(pct: number | null): string {
  if (pct === null) return 'with nothing to compare';
  if (pct === 0) return 'level';
  return pct > 0 ? `up ${pct}%` : `down ${Math.abs(pct)}%`;
}

/** "up 8% on last Thursday's $384", "level with the week before's $3,046". */
export function compareClause(pct: number | null, label: string, amount: string): string {
  if (pct === null) return `with no sales ${label} to compare`;
  if (pct === 0) return `level with ${label}'s ${amount}`;
  return `${describeChange(pct)} on ${label}'s ${amount}`;
}
