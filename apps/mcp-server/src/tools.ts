// ShopVoice MCP tools. Voice-first contract (spec §6): every tool returns
// `speech` (<= 35 words, rounded numbers, units, max 3 list items) for
// content[0].text and `data` matching its declared outputSchema for
// structuredContent.
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ShopProfile, ShopRepository, StockRow, InvoiceRow, NewDraft, DraftLine } from './store.js';
import {
  COVER_BUFFER_DAYS, WEEKDAYS, daysOfCover, describeDate, isLowStock, needsReorder, resolveComparison,
  resolvePeriod, roundUpToPack, suggestedOrderQty
} from './analytics.js';
import type { CompareMode, PeriodName, Weekday } from './analytics.js';
import {
  compareClause, countWord, describeChange, fitSpeech, formatDaysLeft, formatMoney, formatQty, joinList, percentChange,
  speakList, vndToDisplay, MAX_LIST_ITEMS
} from './speech.js';
import type { MoneyFormat } from './speech.js';

export interface ToolContext {
  readonly repo: ShopRepository;
  readonly profile: ShopProfile;
  readonly today: string;
  readonly money: MoneyFormat;
  readonly confirmTtlSeconds: number;
}

export interface ToolOutcome<T> {
  readonly speech: string;
  readonly data: T;
}

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition<I extends z.ZodRawShape, O extends z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  readonly annotations: ToolAnnotations;
  readonly redact?: (args: z.infer<z.ZodObject<I>>) => Record<string, unknown>;
  readonly run: (ctx: ToolContext, args: z.infer<z.ZodObject<I>>) => Promise<ToolOutcome<z.infer<z.ZodObject<O>>>>;
}

function defineTool<I extends z.ZodRawShape, O extends z.ZodRawShape>(def: ToolDefinition<I, O>): ToolDefinition<I, O> {
  return def;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// ---------- shared schemas ----------

const periodEnum = z.enum(['today', 'yesterday', 'this_week', 'last_week', 'last_7_days', 'last_30_days', 'custom']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const periodOut = z.object({ start: z.string(), end: z.string(), label: z.string(), partial: z.boolean() });
const productRef = z.object({ sku: z.string(), name: z.string() });

// ---------- product resolution ----------

type Resolution =
  | { status: 'found'; row: StockRow }
  | { status: 'ambiguous'; candidates: StockRow[] }
  | { status: 'not_found'; suggestions: StockRow[] };

const TIE_MARGIN = 0.05;
const STRONG_MATCH = 0.6;

/**
 * Fuzzy product resolution on top of the shared pg_trgm search. In reorder
 * mode an ambiguous name ("milk") resolves to the single candidate that
 * actually needs reordering, so "reorder milk" picks the low item.
 */
export async function resolveProduct(repo: ShopRepository, stock: readonly StockRow[], query: string, mode: 'lookup' | 'reorder'): Promise<Resolution> {
  const bySku = new Map(stock.map((r) => [r.sku, r]));
  const matches = (await repo.searchProducts(query, 8)).filter((m) => bySku.has(m.sku));
  const first = matches[0];
  if (!first) return { status: 'not_found' as const, suggestions: [] };
  const firstRow = bySku.get(first.sku);
  if (!firstRow) return { status: 'not_found' as const, suggestions: [] };
  if (first.score >= 2) return { status: 'found' as const, row: firstRow };

  const exact = matches.find((m) => m.name.toLowerCase() === query.trim().toLowerCase());
  if (exact) return { status: 'found' as const, row: bySku.get(exact.sku) ?? firstRow };

  const rows = (ms: typeof matches) => ms.map((m) => bySku.get(m.sku)).filter((r): r is StockRow => r !== undefined);
  if (first.score < STRONG_MATCH) return { status: 'not_found' as const, suggestions: rows(matches.slice(0, 2)) };

  const tied = rows(matches.filter((m) => m.score >= first.score - TIE_MARGIN));
  if (tied.length === 1) return { status: 'found' as const, row: firstRow };
  if (mode === 'reorder') {
    const needing = tied.filter(needsReorder);
    if (needing.length === 1 && needing[0]) return { status: 'found' as const, row: needing[0] };
  }
  tied.sort((a, b) => b.avgDaily14d - a.avgDaily14d);
  return { status: 'ambiguous', candidates: tied };
}

function clarifyingQuestion(query: string, resolution: Resolution): string {
  if (resolution.status === 'ambiguous') {
    const names = resolution.candidates.map((c) => c.name);
    const shown = names.slice(0, MAX_LIST_ITEMS);
    const options = names.length > shown.length ? `${shown.join(', ')}, or something else` : joinList(shown).replace(/ and ([^,]*)$/, ' or $1');
    return fitSpeech([
      `For "${query}", which one: ${options}?`,
      `Which "${query}" do you mean? I found ${names.length} matches; check your phone for the list.`
    ]);
  }
  if (resolution.status === 'not_found' && resolution.suggestions.length > 0) {
    return `I couldn't find "${query}". Did you mean ${joinList(resolution.suggestions.map((s) => s.name)).replace(/ and ([^,]*)$/, ' or $1')}?`;
  }
  return fitSpeech([`I couldn't find "${query}" in your products. Try the name on the label or the barcode.`, `I couldn't find "${query}".`]);
}

function stockItemOut(row: StockRow) {
  return {
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    on_hand: row.onHand,
    min_qty: row.minQty,
    avg_daily_sales: Math.round(row.avgDaily14d * 10) / 10,
    days_of_cover: daysOfCover(row),
    below_min: isLowStock(row),
    supplier_code: row.supplierCode
  };
}

const stockItemSchema = z.object({
  sku: z.string(),
  name: z.string(),
  unit: z.string().nullable(),
  on_hand: z.number(),
  min_qty: z.number(),
  avg_daily_sales: z.number(),
  days_of_cover: z.number().nullable(),
  below_min: z.boolean(),
  supplier_code: z.string().nullable()
});

function byUrgency(a: StockRow, b: StockRow): number {
  const ca = daysOfCover(a) ?? Number.POSITIVE_INFINITY;
  const cb = daysOfCover(b) ?? Number.POSITIVE_INFINITY;
  if (ca !== cb) return ca - cb;
  return a.onHand / Math.max(a.minQty, 1) - b.onHand / Math.max(b.minQty, 1);
}

// ---------- tools ----------

export const getLowStock = defineTool({
  name: 'get_low_stock',
  title: 'What is running low',
  description: 'Lists products at or below their minimum stock level, most urgent first (fewest days of cover = on hand / average daily sales over 14 days). Use for "what\'s running low?" or "what do I need to order?".',
  input: {
    limit: z.number().int().min(1).max(50).default(10).describe('Max items in structured output (speech always mentions at most 3).')
  },
  output: {
    total_low: z.number().int(),
    items: z.array(stockItemSchema)
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    const low = (await ctx.repo.listStock()).filter(isLowStock).sort(byUrgency);
    const items = low.slice(0, args.limit).map(stockItemOut);
    if (low.length === 0) {
      return { speech: 'Good news: nothing is below its minimum stock right now.', data: { total_low: 0, items } };
    }
    const detailed = low.map((r) => `${r.name}, ${formatQty(r.onHand, r.unit)}, ${formatDaysLeft(daysOfCover(r))}`);
    const medium = low.map((r) => `${r.name}, ${formatDaysLeft(daysOfCover(r))}`);
    const names = low.map((r) => r.name);
    const lead = low.length === 1 ? 'One item is running low' : `${countWord(low.length, true)} items are running low`;
    const speech = fitSpeech([
      `${lead}: ${speakList(detailed)}. Want me to draft a reorder?`,
      `${lead}: ${speakList(medium)}. Want a reorder draft?`,
      `${lead}: ${speakList(names, MAX_LIST_ITEMS, ', ')}. Want a reorder draft?`,
      `${lead}. The most urgent is ${names[0]}.`
    ]);
    return { speech, data: { total_low: low.length, items } };
  }
});

export const getStockLevel = defineTool({
  name: 'get_stock_level',
  title: 'Stock level for one product',
  description: 'How many units of one product are on hand, with days of cover. Accepts a product name (fuzzy matched, spoken or typed) or a barcode. If several products match, returns the candidates instead of a stock level.',
  input: {
    product: z.string().trim().min(2).max(80).describe('Product name as spoken, e.g. "fresh milk", or a barcode.')
  },
  output: {
    status: z.enum(['found', 'ambiguous', 'not_found']),
    query: z.string(),
    product: stockItemSchema.nullable(),
    candidates: z.array(productRef)
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    const stock = await ctx.repo.listStock();
    const res = await resolveProduct(ctx.repo, stock, args.product, 'lookup');
    if (res.status !== 'found') {
      const candidates = (res.status === 'ambiguous' ? res.candidates : res.suggestions).map((c) => ({ sku: c.sku, name: c.name }));
      return { speech: clarifyingQuestion(args.product, res), data: { status: res.status as 'ambiguous' | 'not_found', query: args.product, product: null, candidates } };
    }
    const row = res.row;
    const cover = daysOfCover(row);
    const base = `You have ${formatQty(row.onHand, row.unit)} of ${row.name}, ${formatDaysLeft(cover)}.`;
    const speech = fitSpeech([
      isLowStock(row) ? `${base} That's below your minimum of ${formatQty(row.minQty, row.unit)}.` : base,
      base
    ]);
    return { speech, data: { status: 'found' as const, query: args.product, product: stockItemOut(row), candidates: [] } };
  }
});

const moneyOut = { currency: z.string() };

export const getSalesSummary = defineTool({
  name: 'get_sales_summary',
  title: 'Sales summary',
  description: 'Revenue and units sold for a period (today, yesterday, this week, last week, last 7/30 days, or a custom date range), compared by default with the same weekday last week (single days) or the previous period. Use compare_weekday for "compared to last Friday".',
  input: {
    period: periodEnum.default('today'),
    start_date: isoDate.optional().describe('Required when period is "custom".'),
    end_date: isoDate.optional().describe('Custom period end (defaults to start_date).'),
    compare_to: z.enum(['auto', 'same_weekday_last_week', 'previous_period', 'none']).default('auto'),
    compare_weekday: z.enum(WEEKDAYS).optional().describe('Compare with the most recent such weekday before the period, e.g. "friday" for "vs last Friday".')
  },
  output: {
    period: periodOut,
    ...moneyOut,
    revenue_vnd: z.number(),
    revenue: z.number(),
    units: z.number(),
    comparison: z.object({
      period: periodOut,
      revenue_vnd: z.number(),
      revenue: z.number(),
      units: z.number(),
      change_pct: z.number().nullable(),
      percent_of_comparison: z.number().nullable()
    }).nullable()
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    const range = resolvePeriod(args.period as PeriodName, ctx.today, {
      ...(args.start_date ? { start: args.start_date } : {}),
      ...(args.end_date ? { end: args.end_date } : {})
    });
    const totals = await ctx.repo.salesTotals(range.start, range.end);
    const cmpRange = resolveComparison(range, ctx.today, args.compare_to as CompareMode, args.compare_weekday as Weekday | undefined);
    const cmp = cmpRange ? await ctx.repo.salesTotals(cmpRange.start, cmpRange.end) : null;

    const revenue = formatMoney(totals.revenueVnd, ctx.money);
    const items = formatQty(totals.units, 'item');
    const label = range.label.charAt(0).toUpperCase() + range.label.slice(1);
    const pct = cmp ? percentChange(totals.revenueVnd, cmp.revenueVnd) : null;
    const pctOf = cmp && cmp.revenueVnd > 0 ? Math.round((totals.revenueVnd / cmp.revenueVnd) * 100) : null;

    let speech: string;
    if (totals.units === 0) {
      speech = `No sales recorded ${range.label}.`;
    } else if (range.partial && cmp && cmpRange) {
      const prefix = range.label === 'today' ? 'So far today' : `So far ${range.label}`;
      const cmpMoney = formatMoney(cmp.revenueVnd, ctx.money);
      speech = fitSpeech([
        cmpRange.start === cmpRange.end && pctOf !== null
          ? `${prefix}: ${revenue} from ${items}. That's ${pctOf}% of ${cmpRange.label}'s full day, ${cmpMoney}.`
          : `${prefix}: ${revenue} from ${items}. ${cmpRange.label.charAt(0).toUpperCase() + cmpRange.label.slice(1)} brought ${cmpMoney}.`,
        `${prefix}: ${revenue} from ${items}.`
      ]);
    } else if (cmp && cmpRange) {
      speech = fitSpeech([
        `${label}: ${revenue} from ${items}, ${compareClause(pct, cmpRange.label, formatMoney(cmp.revenueVnd, ctx.money))}.`,
        `${label}: ${revenue}, ${describeChange(pct)} on ${cmpRange.label}.`
      ]);
    } else {
      speech = `${range.partial ? `So far ${range.label}` : label}: ${revenue} from ${items}.`;
    }

    return {
      speech,
      data: {
        period: range,
        currency: ctx.money.currency,
        revenue_vnd: totals.revenueVnd,
        revenue: vndToDisplay(totals.revenueVnd, ctx.money),
        units: totals.units,
        comparison: cmp && cmpRange ? {
          period: cmpRange,
          revenue_vnd: cmp.revenueVnd,
          revenue: vndToDisplay(cmp.revenueVnd, ctx.money),
          units: cmp.units,
          change_pct: pct,
          percent_of_comparison: pctOf
        } : null
      }
    };
  }
});

export const getTopMovers = defineTool({
  name: 'get_top_movers',
  title: 'Best and slowest sellers',
  description: 'Top or bottom N products by units or revenue in a period. Use direction "bottom" for slow movers (includes products with no sales).',
  input: {
    period: periodEnum.default('last_7_days'),
    start_date: isoDate.optional(),
    end_date: isoDate.optional(),
    metric: z.enum(['units', 'revenue']).default('units'),
    direction: z.enum(['top', 'bottom']).default('top'),
    limit: z.number().int().min(1).max(10).default(3)
  },
  output: {
    period: periodOut,
    metric: z.enum(['units', 'revenue']),
    direction: z.enum(['top', 'bottom']),
    ...moneyOut,
    items: z.array(z.object({
      rank: z.number().int(),
      sku: z.string(),
      name: z.string(),
      unit: z.string().nullable(),
      units: z.number(),
      revenue_vnd: z.number(),
      revenue: z.number()
    }))
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    const range = resolvePeriod(args.period as PeriodName, ctx.today, {
      ...(args.start_date ? { start: args.start_date } : {}),
      ...(args.end_date ? { end: args.end_date } : {})
    });
    const [sales, stock] = [await ctx.repo.salesBySku(range.start, range.end), await ctx.repo.listStock()];
    const bySku = new Map(sales.map((s) => [s.sku, s]));
    const all = stock.map((r) => bySku.get(r.sku) ?? { sku: r.sku, name: r.name, unit: r.unit, units: 0, revenueVnd: 0 });
    const key = (s: { units: number; revenueVnd: number }) => (args.metric === 'units' ? s.units : s.revenueVnd);
    all.sort((a, b) => (args.direction === 'top' ? key(b) - key(a) : key(a) - key(b)) || a.name.localeCompare(b.name));
    const picked = all.slice(0, args.limit);
    const items = picked.map((s, i) => ({
      rank: i + 1, sku: s.sku, name: s.name, unit: s.unit, units: s.units,
      revenue_vnd: s.revenueVnd, revenue: vndToDisplay(s.revenueVnd, ctx.money)
    }));
    const describe = (s: typeof picked[number]) => `${s.name}, ${args.metric === 'units' ? formatQty(s.units, s.unit) : formatMoney(s.revenueVnd, ctx.money)}`;
    const when = range.label === 'today' ? 'so far today' : range.label.startsWith('the ') ? `over ${range.label}` : range.label;
    const heading = `${args.direction === 'top' ? 'Top sellers' : 'Slowest sellers'} ${when} by ${args.metric}`;
    const speech = picked.length === 0
      ? `No products to rank ${range.label}.`
      : fitSpeech([
        `${heading}: ${speakList(picked.map(describe))}.`,
        `${heading}: ${speakList(picked.map((s) => s.name), MAX_LIST_ITEMS, ', ')}.`
      ]);
    return { speech, data: { period: range, metric: args.metric, direction: args.direction, currency: ctx.money.currency, items } };
  }
});

// ---------- invoices ----------

type InvoiceState = 'arrived' | 'mapped' | 'synced';

function invoiceState(inv: InvoiceRow): InvoiceState {
  if (inv.synced) return 'synced';
  if (inv.lineCount > 0 && inv.resolvedCount >= inv.lineCount) return 'mapped';
  return 'arrived';
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'invoice', 'invoices', 'from', 'delivery', 'order', 'bill', 'supplier', 'did', 'has', 'arrive', 'arrived', 'come', 'in']);
const SYNONYMS: Record<string, string> = { drinks: 'beverages', drink: 'beverages', soda: 'beverages', sodas: 'beverages', bakery: 'bakery', snack: 'snacks', dairy: 'dairy', eggs: 'eggs' };

export function invoiceMatches(inv: InvoiceRow, query: string): boolean {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  if (words.length === 0) return true;
  const haystack = [inv.supplierName ?? '', inv.supplierCode ?? '', inv.invoiceNumber, ...inv.productNames]
    .join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.every((w) => {
    const target = SYNONYMS[w] ?? w;
    const stem = target.length > 4 ? target.replace(/s$/, '') : target;
    return haystack.some((h) => h.startsWith(stem));
  });
}

function describeInvoiceState(inv: InvoiceRow, state: InvoiceState): string {
  if (state === 'synced') return 'synced to KiotViet';
  if (state === 'mapped') return 'matched to your products but not synced to KiotViet yet';
  const pending = inv.lineCount - inv.resolvedCount;
  return `received, with ${pending} ${pending === 1 ? 'line' : 'lines'} still to match`;
}

function invoiceWhen(inv: InvoiceRow, today: string): string {
  const d = describeDate(inv.invoiceDate, today);
  return d === 'today' || d === 'yesterday' ? d : `on ${d}`;
}

export const getInvoiceStatus = defineTool({
  name: 'get_invoice_status',
  title: 'Supplier invoice status',
  description: 'Latest supplier invoices and whether each has arrived, been matched to products (mapped), or been synced to the shop\'s point-of-sale system (KiotViet). Filter by supplier name or a product on the invoice, e.g. "Sunrise Beverages" or "drinks".',
  input: {
    supplier: z.string().trim().max(80).optional().describe('Supplier name, category or product word to filter by.'),
    limit: z.number().int().min(1).max(10).default(3)
  },
  output: {
    query: z.string().nullable(),
    matched: z.boolean(),
    ...moneyOut,
    invoices: z.array(z.object({
      invoice_number: z.string(),
      supplier_code: z.string().nullable(),
      supplier_name: z.string().nullable(),
      invoice_date: z.string(),
      total_vnd: z.number(),
      total: z.number(),
      line_count: z.number().int(),
      unmatched_lines: z.number().int(),
      status: z.enum(['arrived', 'mapped', 'synced'])
    }))
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    const recent = await ctx.repo.listRecentInvoices(20);
    const query = args.supplier?.trim() || null;
    const filtered = query ? recent.filter((inv) => invoiceMatches(inv, query)) : recent;
    const picked = filtered.slice(0, args.limit);
    const invoices = picked.map((inv) => ({
      invoice_number: inv.invoiceNumber,
      supplier_code: inv.supplierCode,
      supplier_name: inv.supplierName,
      invoice_date: inv.invoiceDate,
      total_vnd: inv.totalVnd,
      total: vndToDisplay(inv.totalVnd, ctx.money),
      line_count: inv.lineCount,
      unmatched_lines: Math.max(0, inv.lineCount - inv.resolvedCount),
      status: invoiceState(inv)
    }));
    const who = (inv: InvoiceRow) => inv.supplierName ?? inv.supplierCode ?? 'an unknown supplier';

    let speech: string;
    const top = picked[0];
    if (query && top) {
      const state = invoiceState(top);
      speech = fitSpeech([
        `Yes. The ${who(top)} invoice ${top.invoiceNumber} arrived ${invoiceWhen(top, ctx.today)}, ${formatMoney(top.totalVnd, ctx.money)}. It's ${describeInvoiceState(top, state)}.`,
        `Yes, the ${who(top)} invoice arrived ${invoiceWhen(top, ctx.today)}. It's ${state === 'synced' ? 'synced' : state === 'mapped' ? 'matched, not synced yet' : 'waiting to be matched'}.`
      ]);
    } else if (query) {
      const latest = recent[0];
      speech = latest
        ? fitSpeech([`I don't see a recent invoice for "${query}". The latest one is from ${who(latest)}, ${invoiceWhen(latest, ctx.today)}.`, `I don't see a recent invoice for "${query}".`])
        : `I don't see any supplier invoices yet.`;
    } else if (picked.length === 0) {
      speech = `I don't see any supplier invoices yet.`;
    } else {
      const short = (inv: InvoiceRow) => {
        const s = invoiceState(inv);
        return `${who(inv)} ${invoiceWhen(inv, ctx.today)}, ${s === 'synced' ? 'synced' : s === 'mapped' ? 'matched, not synced' : 'needs matching'}`;
      };
      speech = fitSpeech([
        `Latest invoices: ${speakList(picked.map(short))}.`,
        `Latest invoices: ${speakList(picked.map((inv) => `${who(inv)} ${invoiceWhen(inv, ctx.today)}`))}.`
      ]);
    }
    return { speech, data: { query, matched: query ? picked.length > 0 : true, currency: ctx.money.currency, invoices } };
  }
});

// ---------- reorder ----------

interface SupplierPlan {
  supplierCode: string;
  supplierName: string;
  leadTimeDays: number;
  lines: { row: StockRow; qty: number }[];
  totalVnd: number;
}

async function planBySupplier(ctx: ToolContext, lines: { row: StockRow; qty: number }[]): Promise<SupplierPlan[]> {
  const suppliers = new Map((await ctx.repo.listSuppliers()).map((s) => [s.code, s]));
  const plans = new Map<string, SupplierPlan>();
  for (const line of lines) {
    if (line.qty <= 0) continue;
    const code = line.row.supplierCode ?? 'UNASSIGNED';
    const supplier = suppliers.get(code);
    const plan = plans.get(code) ?? {
      supplierCode: code,
      supplierName: supplier?.name ?? 'an unassigned supplier',
      leadTimeDays: supplier?.leadTimeDays ?? line.row.leadTimeDays,
      lines: [],
      totalVnd: 0
    };
    plan.lines.push(line);
    plan.totalVnd += line.qty * line.row.unitCostVnd;
    plans.set(code, plan);
  }
  return [...plans.values()].sort((a, b) => b.totalVnd - a.totalVnd);
}

function supplierMatches(plan: SupplierPlan, query: string): boolean {
  const q = query.toLowerCase().trim();
  return plan.supplierCode.toLowerCase() === q || plan.supplierName.toLowerCase().includes(q)
    || q.split(/\s+/).filter((w) => w.length > 2).some((w) => plan.supplierName.toLowerCase().includes(w));
}

const reorderLineSchema = z.object({
  sku: z.string(),
  name: z.string(),
  unit: z.string().nullable(),
  on_hand: z.number(),
  avg_daily_sales: z.number(),
  days_of_cover: z.number().nullable(),
  suggested_qty: z.number(),
  pack_size: z.number(),
  line_cost_vnd: z.number()
});

function planOut(ctx: ToolContext, plan: SupplierPlan) {
  return {
    supplier_code: plan.supplierCode,
    supplier_name: plan.supplierName,
    lead_time_days: plan.leadTimeDays,
    lines: plan.lines.map(({ row, qty }) => ({
      sku: row.sku,
      name: row.name,
      unit: row.unit,
      on_hand: row.onHand,
      avg_daily_sales: Math.round(row.avgDaily14d * 10) / 10,
      days_of_cover: daysOfCover(row),
      suggested_qty: qty,
      pack_size: row.packSize,
      line_cost_vnd: qty * row.unitCostVnd
    })),
    total_vnd: plan.totalVnd,
    total: vndToDisplay(plan.totalVnd, ctx.money)
  };
}

function summarizePlans(plans: SupplierPlan[]): string[] {
  return plans.map((p) => `${joinList(p.lines.map((l) => l.row.name))} from ${p.supplierName}`);
}

export const suggestReorder = defineTool({
  name: 'suggest_reorder',
  title: 'Suggest a reorder',
  description: `Per supplier, what to reorder now: items at/below minimum or about to run out before the next delivery. Suggested quantity = (supplier lead time + ${COVER_BUFFER_DAYS} days) x average daily sales - on hand, rounded up to the pack size. Read-only: it does not create an order.`,
  input: {
    supplier: z.string().trim().max(80).optional().describe('Only suggest for this supplier (name or code).')
  },
  output: {
    item_count: z.number().int(),
    ...moneyOut,
    total_vnd: z.number(),
    total: z.number(),
    suppliers: z.array(z.object({
      supplier_code: z.string(),
      supplier_name: z.string(),
      lead_time_days: z.number(),
      lines: z.array(reorderLineSchema),
      total_vnd: z.number(),
      total: z.number()
    }))
  },
  annotations: READ_ONLY,
  async run(ctx, args) {
    const stock = await ctx.repo.listStock();
    let plans = await planBySupplier(ctx, stock.filter(needsReorder).sort(byUrgency).map((row) => ({ row, qty: suggestedOrderQty(row) })));
    if (args.supplier) plans = plans.filter((p) => supplierMatches(p, args.supplier ?? ''));
    const itemCount = plans.reduce((n, p) => n + p.lines.length, 0);
    const totalVnd = plans.reduce((n, p) => n + p.totalVnd, 0);
    const total = formatMoney(totalVnd, ctx.money);
    const speech = itemCount === 0
      ? `Nothing needs reordering${args.supplier ? ` from ${args.supplier}` : ''} right now.`
      : fitSpeech([
        `I'd reorder ${countWord(itemCount)} ${itemCount === 1 ? 'item' : 'items'}, about ${total}: ${speakList(summarizePlans(plans), 2)}. Shall I draft it?`,
        `I'd reorder ${countWord(itemCount)} ${itemCount === 1 ? 'item' : 'items'} from ${countWord(plans.length)} ${plans.length === 1 ? 'supplier' : 'suppliers'}, about ${total}. Shall I draft the orders?`
      ]);
    return {
      speech,
      data: {
        item_count: itemCount,
        currency: ctx.money.currency,
        total_vnd: totalVnd,
        total: vndToDisplay(totalVnd, ctx.money),
        suppliers: plans.map((p) => planOut(ctx, p))
      }
    };
  }
});

export function hashConfirmationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateConfirmationToken(): string {
  return `rc_${randomBytes(12).toString('base64url')}`;
}

const draftOutSchema = z.object({
  draft_id: z.string(),
  supplier_code: z.string(),
  supplier_name: z.string(),
  lines: z.array(z.object({ sku: z.string(), name: z.string(), unit: z.string().nullable(), qty: z.number() })),
  total_vnd: z.number(),
  total: z.number()
});

export const createReorderDraft = defineTool({
  name: 'create_reorder_draft',
  title: 'Draft a reorder (step 1 of 2)',
  description: 'Creates purchase-order drafts in the shop\'s own records, one per supplier, from product names such as "milk" or "eggs" with optional quantities, or from all current reorder suggestions when items is omitted. Nothing is ordered and no payment is made: the drafts stay pending until confirm_reorder is called with the returned confirmation_token, which expires after 5 minutes.',
  input: {
    items: z.array(z.object({
      product: z.string().trim().min(2).max(80),
      qty: z.number().positive().max(10000).optional().describe('Units to order; defaults to the suggested quantity.')
    })).max(20).optional(),
    supplier: z.string().trim().max(80).optional().describe('When items is omitted, only draft suggestions for this supplier.')
  },
  output: {
    status: z.enum(['draft_created', 'needs_clarification', 'nothing_to_order']),
    confirmation_token: z.string().nullable(),
    expires_at: z.string().nullable(),
    expires_in_seconds: z.number().int(),
    ...moneyOut,
    total_vnd: z.number(),
    total: z.number(),
    drafts: z.array(draftOutSchema),
    clarifications: z.array(z.object({ query: z.string(), status: z.enum(['ambiguous', 'not_found']), candidates: z.array(productRef) }))
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  async run(ctx, args) {
    const stock = await ctx.repo.listStock();
    const empty = { confirmation_token: null, expires_at: null, expires_in_seconds: 0, currency: ctx.money.currency, total_vnd: 0, total: 0, drafts: [] };
    let lines: { row: StockRow; qty: number }[] = [];

    if (args.items && args.items.length > 0) {
      const clarifications: { query: string; status: 'ambiguous' | 'not_found'; candidates: { sku: string; name: string }[] }[] = [];
      let firstQuestion = '';
      for (const item of args.items) {
        const res = await resolveProduct(ctx.repo, stock, item.product, 'reorder');
        if (res.status === 'found') {
          const row = res.row;
          const qty = item.qty !== undefined
            ? roundUpToPack(item.qty, 1)
            : (suggestedOrderQty(row) || roundUpToPack(row.reorderQty || row.packSize, row.packSize));
          lines.push({ row, qty });
        } else {
          if (!firstQuestion) firstQuestion = clarifyingQuestion(item.product, res);
          const candidates = (res.status === 'ambiguous' ? res.candidates : res.suggestions).map((c) => ({ sku: c.sku, name: c.name }));
          clarifications.push({ query: item.product, status: res.status, candidates });
        }
      }
      if (clarifications.length > 0) {
        return { speech: `${firstQuestion} No draft made yet.`.replace(/\? No draft/, '? No draft'), data: { status: 'needs_clarification' as const, ...empty, clarifications } };
      }
    } else {
      lines = stock.filter(needsReorder).sort(byUrgency).map((row) => ({ row, qty: suggestedOrderQty(row) }));
    }

    let plans = await planBySupplier(ctx, lines);
    if (!args.items && args.supplier) plans = plans.filter((p) => supplierMatches(p, args.supplier ?? ''));
    if (plans.length === 0) {
      return { speech: 'There is nothing to reorder right now, so I did not create a draft.', data: { status: 'nothing_to_order' as const, ...empty, clarifications: [] } };
    }

    const token = generateConfirmationToken();
    const newDrafts: NewDraft[] = plans.map((p) => ({
      supplierCode: p.supplierCode,
      totalVnd: p.totalVnd,
      lines: p.lines.map(({ row, qty }): DraftLine => ({ sku: row.sku, name: row.name, unit: row.unit, qty, unitCostVnd: row.unitCostVnd }))
    }));
    const { ids, expiresAt } = await ctx.repo.createDrafts(newDrafts, hashConfirmationToken(token), ctx.confirmTtlSeconds);
    const totalVnd = plans.reduce((n, p) => n + p.totalVnd, 0);
    const minutes = Math.round(ctx.confirmTtlSeconds / 60);
    const lineText = (p: SupplierPlan) => joinList(p.lines.map((l) => `${formatQty(l.qty, l.row.unit)} of ${l.row.name}`));
    const onlyPlan = plans[0];
    const speech = plans.length === 1 && onlyPlan
      ? fitSpeech([
        `Draft ready: ${lineText(onlyPlan)} from ${onlyPlan.supplierName}, about ${formatMoney(totalVnd, ctx.money)}. Say "confirm" within ${minutes} minutes to place it.`,
        `Draft ready for ${onlyPlan.supplierName}: ${onlyPlan.lines.length} items, about ${formatMoney(totalVnd, ctx.money)}. Say "confirm" within ${minutes} minutes to place it.`
      ])
      : fitSpeech([
        `Drafted ${countWord(plans.length)} orders, about ${formatMoney(totalVnd, ctx.money)}: ${speakList(summarizePlans(plans), 2)}. Say "confirm" within ${minutes} minutes to place them.`,
        `Drafted ${countWord(plans.length)} orders for ${lines.length} items, about ${formatMoney(totalVnd, ctx.money)}. Say "confirm" within ${minutes} minutes to place them.`
      ]);

    return {
      speech,
      data: {
        status: 'draft_created' as const,
        confirmation_token: token,
        expires_at: expiresAt,
        expires_in_seconds: ctx.confirmTtlSeconds,
        currency: ctx.money.currency,
        total_vnd: totalVnd,
        total: vndToDisplay(totalVnd, ctx.money),
        drafts: plans.map((p, i) => ({
          draft_id: ids[i] ?? '',
          supplier_code: p.supplierCode,
          supplier_name: p.supplierName,
          lines: p.lines.map(({ row, qty }) => ({ sku: row.sku, name: row.name, unit: row.unit, qty })),
          total_vnd: p.totalVnd,
          total: vndToDisplay(p.totalVnd, ctx.money)
        })),
        clarifications: []
      }
    };
  }
});

export const confirmReorder = defineTool({
  name: 'confirm_reorder',
  title: 'Confirm a reorder (step 2 of 2)',
  description: 'Marks the purchase-order drafts from one create_reorder_draft call as confirmed orders in the shop\'s own records, using that call\'s confirmation_token (valid 5 minutes). It changes their status only: it does not contact suppliers or send any payment. Confirming the same drafts again has no further effect.',
  input: {
    confirmation_token: z.string().trim().min(8).max(64)
  },
  output: {
    status: z.enum(['confirmed', 'already_confirmed', 'expired', 'not_found']),
    confirmed_count: z.number().int(),
    ...moneyOut,
    total_vnd: z.number(),
    total: z.number(),
    drafts: z.array(z.object({ draft_id: z.string(), supplier_code: z.string(), supplier_name: z.string(), status: z.string(), total: z.number() }))
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  redact: () => ({ confirmation_token: '[redacted]' }),
  async run(ctx, args) {
    const drafts = await ctx.repo.findDraftsByTokenHash(hashConfirmationToken(args.confirmation_token));
    const suppliers = new Map((await ctx.repo.listSuppliers()).map((s) => [s.code, s.name]));
    const totalVnd = drafts.reduce((n, d) => n + d.totalVnd, 0);
    const base = { currency: ctx.money.currency, total_vnd: totalVnd, total: vndToDisplay(totalVnd, ctx.money) };
    const out = (status: string) => drafts.map((d) => ({
      draft_id: d.id, supplier_code: d.supplierCode, supplier_name: suppliers.get(d.supplierCode) ?? d.supplierCode,
      status: d.status === 'draft' ? status : d.status, total: vndToDisplay(d.totalVnd, ctx.money)
    }));

    if (drafts.length === 0) {
      return { speech: "I couldn't find that draft. Want me to create a new reorder?", data: { status: 'not_found' as const, confirmed_count: 0, ...base, drafts: [] } };
    }
    const pending = drafts.filter((d) => d.status === 'draft');
    if (pending.length === 0) {
      return { speech: 'Those orders were already confirmed. Nothing else to do.', data: { status: 'already_confirmed' as const, confirmed_count: 0, ...base, drafts: out('confirmed') } };
    }
    if (pending.some((d) => d.expired)) {
      return { speech: 'That draft expired after 5 minutes, so nothing was ordered. Want me to make a fresh one?', data: { status: 'expired' as const, confirmed_count: 0, ...base, drafts: out('expired') } };
    }
    const count = await ctx.repo.confirmDrafts(pending.map((d) => d.id));
    const names = [...new Set(pending.map((d) => suppliers.get(d.supplierCode) ?? d.supplierCode))];
    const itemCount = pending.reduce((n, d) => n + d.lines.length, 0);
    const speech = fitSpeech([
      `Done. ${count === 1 ? 'Your order' : `${countWord(count, true)} orders`} to ${joinList(names)} ${count === 1 ? 'is' : 'are'} confirmed: ${itemCount} ${itemCount === 1 ? 'item' : 'items'}, about ${formatMoney(totalVnd, ctx.money)}.`,
      `Done. ${countWord(count, true)} ${count === 1 ? 'order' : 'orders'} confirmed, about ${formatMoney(totalVnd, ctx.money)}.`
    ]);
    return { speech, data: { status: 'confirmed' as const, confirmed_count: count, ...base, drafts: out('confirmed') } };
  }
});

export const getDailyBriefing = defineTool({
  name: 'get_daily_briefing',
  title: 'Morning briefing',
  description: "Three-sentence start-of-day summary: yesterday's sales vs the same weekday last week, how many products are below minimum stock, and supplier invoices not yet synced to the point-of-sale system.",
  input: {},
  output: {
    ...moneyOut,
    yesterday_revenue: z.number(),
    yesterday_change_pct: z.number().nullable(),
    low_stock_count: z.number().int(),
    most_urgent: z.string().nullable(),
    invoices_pending_sync: z.number().int()
  },
  annotations: READ_ONLY,
  async run(ctx) {
    const y = resolvePeriod('yesterday', ctx.today);
    const cmp = resolveComparison(y, ctx.today, 'same_weekday_last_week');
    const [sales, prev, stock, invoices] = [
      await ctx.repo.salesTotals(y.start, y.end),
      cmp ? await ctx.repo.salesTotals(cmp.start, cmp.end) : null,
      await ctx.repo.listStock(),
      await ctx.repo.listRecentInvoices(20)
    ];
    const low = stock.filter(isLowStock).sort(byUrgency);
    const pendingSync = invoices.filter((inv) => !inv.synced).length;
    const pct = prev ? percentChange(sales.revenueVnd, prev.revenueVnd) : null;
    const s1 = `Yesterday you sold ${formatMoney(sales.revenueVnd, ctx.money)}, ${describeChange(pct)} on ${cmp?.label ?? 'last week'}.`;
    const s2 = low.length === 0 ? 'Nothing is running low.' : `${low.length === 1 ? 'One item is' : `${countWord(low.length, true)} items are`} running low, most urgently ${low[0]?.name}.`;
    const s3 = pendingSync === 0 ? 'All supplier invoices are synced.' : `${countWord(pendingSync, true)} supplier ${pendingSync === 1 ? 'invoice is' : 'invoices are'} not synced yet.`;
    return {
      speech: fitSpeech([`${s1} ${s2} ${s3}`, `${s1} ${s2}`]),
      data: {
        currency: ctx.money.currency,
        yesterday_revenue: vndToDisplay(sales.revenueVnd, ctx.money),
        yesterday_change_pct: pct,
        low_stock_count: low.length,
        most_urgent: low[0]?.name ?? null,
        invoices_pending_sync: pendingSync
      }
    };
  }
});

export const ALL_TOOLS = [
  getLowStock, getStockLevel, getSalesSummary, getTopMovers, getInvoiceStatus,
  suggestReorder, createReorderDraft, confirmReorder, getDailyBriefing
] as const;
