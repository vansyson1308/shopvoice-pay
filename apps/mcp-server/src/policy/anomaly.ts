// Price and volume anomaly checks used by the policy engine. Pure functions:
// no clock, no I/O. Inputs are integer minor units.

export interface PriceObservation {
  readonly unitCostMinor: number;
  /** ISO date (YYYY-MM-DD) or timestamp of the observation. */
  readonly at: string;
}

const DAY_MS = 86_400_000;

/** Mean unit cost over the window ending at `now`, or null when there is no history in it. */
export function averageUnitCost(history: readonly PriceObservation[], now: number, windowDays = 30): number | null {
  const since = now - windowDays * DAY_MS;
  const inWindow = history.filter((h) => {
    const t = Date.parse(h.at);
    return Number.isFinite(t) && t >= since && t <= now;
  });
  if (inWindow.length === 0) return null;
  const sum = inWindow.reduce((acc, h) => acc + h.unitCostMinor, 0);
  return sum / inWindow.length;
}

/** Whole-percent change from `baseline` to `current`, rounded half away from zero. */
export function percentChange(baseline: number, current: number): number {
  if (baseline <= 0) return 0;
  const raw = ((current - baseline) / baseline) * 100;
  return raw >= 0 ? Math.round(raw) : -Math.round(-raw);
}

/** Median of past order quantities, or null with fewer than two past orders (too little to call "usual"). */
export function usualQuantity(pastQuantities: readonly number[]): number | null {
  const valid = pastQuantities.filter((q) => Number.isFinite(q) && q > 0).sort((a, b) => a - b);
  if (valid.length < 2) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 1 ? valid[mid]! : (valid[mid - 1]! + valid[mid]!) / 2;
}

/** Order-insensitive fingerprint of a draft's lines, for duplicate detection. */
export function linesFingerprint(supplierId: string, lines: readonly { readonly sku: string; readonly qty: number }[]): string {
  const merged = new Map<string, number>();
  for (const line of lines) merged.set(line.sku, (merged.get(line.sku) ?? 0) + line.qty);
  const body = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([sku, qty]) => `${sku}x${qty}`).join(',');
  return `${supplierId}|${body}`;
}
