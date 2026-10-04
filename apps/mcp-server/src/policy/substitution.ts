// Decides whether a supplier's proposed substitution can be accepted without
// asking the owner: same product family, same total base units, price change
// within the policy's substitution tolerance. Pure function.
import { percentChange } from './anomaly.js';

export interface OfferLine {
  readonly sku: string;
  readonly name: string;
  readonly qty: number;
  readonly unitCostMinor: number;
  /** Sellable base units per qty (a 30-count egg case is 30). */
  readonly baseUnitsPerQty: number;
  /** Product family, e.g. "eggs-large". Substitutes must share it. */
  readonly family: string;
}

export interface SubstitutionVerdict {
  readonly accept: boolean;
  readonly priceChangePct: number;
  readonly originalMinor: number;
  readonly proposedMinor: number;
  readonly reasons: readonly string[];
}

function value(lines: readonly OfferLine[]): number {
  return lines.reduce((acc, l) => acc + l.qty * l.unitCostMinor, 0);
}

function baseUnits(lines: readonly OfferLine[]): number {
  return lines.reduce((acc, l) => acc + l.qty * l.baseUnitsPerQty, 0);
}

export function evaluateSubstitution(original: OfferLine, proposed: readonly OfferLine[], tolerancePct: number): SubstitutionVerdict {
  const originalMinor = original.qty * original.unitCostMinor;
  const proposedMinor = value(proposed);
  const priceChangePct = percentChange(originalMinor, proposedMinor);
  const reasons: string[] = [];
  if (proposed.length === 0) reasons.push('The supplier offered nothing in its place.');
  const wellFormed = proposed.every((l) => Number.isSafeInteger(l.qty) && l.qty > 0 && Number.isSafeInteger(l.unitCostMinor) && l.unitCostMinor >= 0 && l.baseUnitsPerQty > 0);
  if (!wellFormed) reasons.push('The offer has an invalid quantity or price.');
  if (proposed.some((l) => l.family !== original.family)) reasons.push(`The offer is not the same kind of product as ${original.name}.`);
  if (proposed.length > 0 && baseUnits(proposed) !== baseUnits([original])) {
    reasons.push(`The offer has ${baseUnits(proposed)} units instead of ${baseUnits([original])}.`);
  }
  if (Math.abs(priceChangePct) > tolerancePct) {
    reasons.push(`The price changes by ${priceChangePct}%, outside your ${tolerancePct}% limit.`);
  }
  const accept = reasons.length === 0;
  if (accept) reasons.push(`Same ${baseUnits(proposed)} units, price change ${priceChangePct}%, within your ${tolerancePct}% limit.`);
  return { accept, priceChangePct, originalMinor, proposedMinor, reasons };
}
