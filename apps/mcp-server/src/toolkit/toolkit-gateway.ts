// The policy layer in front of the PayPal Agent Toolkit. The model never calls
// a toolkit method or sees what one needs: MCP tools call this gateway with
// ShopVoice ids, and the gateway
//  * looks PayPal ids up in the ledger itself (capture ids never reach a tool);
//  * builds every argument from server data, inside fixed bounds;
//  * derives each POST's PayPal-Request-Id from the ledger row, so a retry
//    replays the same key;
//  * writes what it did to the ledger (shipment_tracked event) or to
//    sales_invoices, and validates whatever PayPal returns before use.
// Toolkit calls never move money. Refunds and payments stay in PaymentsService.
import { randomBytes } from 'node:crypto';
import type { PaymentRecord, SalesInvoiceLine, SalesInvoiceRecord } from '../ledger/types.js';
import type { ServiceContext } from '../payments/service.js';
import { toPayPalValue, fromPayPalValue } from '../payments/money.js';
import type { ToolkitRunner } from './agent-toolkit.js';
import { ToolkitError } from './agent-toolkit.js';

const DAY_MS = 86_400_000;
/** PayPal transaction search covers at most 31 days per request. */
export const MAX_CROSS_CHECK_DAYS = 31;
const TRACKER_STATUSES = new Set(['SHIPPED', 'ON_HOLD', 'DELIVERED', 'CANCELLED', 'LOCAL_PICKUP']);
const SAFE_REF = /^[A-Za-z0-9-]{1,40}$/;
const PAYPAL_INVOICE_ID = /^INV2(-[A-Z0-9]{4}){4}$|^INV2-[A-Z0-9]{16}$/;

export interface ToolkitGatewayConfig {
  /** Largest catering invoice the agent may prepare (minor units). */
  readonly cateringMaxMinor: number;
  readonly cateringMaxPerDay: number;
  /**
   * Who may receive an invoice. Sandbox only: PayPal's sandbox accounts use
   * example.com addresses, and nothing here may email a real customer.
   */
  readonly recipientDomains: readonly string[];
  readonly timeZone: string;
}

export const DEFAULT_RECIPIENT_DOMAINS = ['example.com', 'example.net', 'example.org'] as const;

export function loadToolkitGatewayConfig(env: Record<string, string | undefined>): ToolkitGatewayConfig {
  const usd = Number(env.CATERING_INVOICE_MAX_USD ?? '1000');
  const perDay = Number.parseInt(env.CATERING_INVOICES_PER_DAY ?? '10', 10);
  const extra = (env.CATERING_RECIPIENT_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase()).filter((d) => /^[a-z0-9.-]+\.(example|test|invalid)$|^example\.(com|net|org)$/.test(d));
  return {
    cateringMaxMinor: Number.isFinite(usd) && usd > 0 ? Math.min(Math.round(usd * 100), 1_000_000) : 100_000,
    cateringMaxPerDay: Number.isSafeInteger(perDay) && perDay > 0 ? Math.min(perDay, 100) : 10,
    recipientDomains: [...DEFAULT_RECIPIENT_DOMAINS, ...extra],
    timeZone: env.SHOP_TIMEZONE || 'America/New_York'
  };
}

export class ToolkitPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Removes control and bidi characters, collapses spaces, trims to `max`. */
export function cleanText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function recipientAllowed(email: string, domains: readonly string[]): boolean {
  const m = /^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9.-]{1,190})$/.exec(email);
  if (!m?.[1]) return false;
  const domain = m[1].toLowerCase();
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export interface CateringItemInput {
  readonly name: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
}

export interface CrossCheck {
  readonly status: 'match' | 'lagging' | 'mismatch' | 'nothing_to_check';
  readonly days: number;
  readonly ledgerCount: number;
  readonly ledgerTotalMinor: number;
  readonly listedCount: number;
  readonly notYetListed: number;
  readonly amountMismatches: number;
  readonly otherPayPalActivity: number;
  readonly lastRefreshed: string | null;
}

export interface TrackingView {
  readonly status: 'tracked' | 'not_tracked' | 'not_charged';
  readonly trackers: readonly { readonly trackingNumber: string; readonly status: string }[];
}

export class ToolkitGateway {
  constructor(
    private readonly runner: ToolkitRunner,
    readonly config: ToolkitGatewayConfig,
    private readonly now: () => number = Date.now
  ) {}

  // ---------- shipment tracking on supplier orders ----------

  /**
   * Adds delivery tracking to a PayPal capture after the goods arrived. The
   * tracking number is the supplier agent's order number (validated at
   * checkout) or our own reference. Idempotent per capture.
   */
  async trackDelivery(ctx: ServiceContext, payment: PaymentRecord, captureId: string): Promise<'tracked' | 'already' | 'failed'> {
    if (!payment.paypalCaptureIds.includes(captureId)) throw new ToolkitPolicyError('unknown_capture', 'That charge is not on this order');
    const events = await ctx.repo.listEvents(payment.id);
    if (events.some((e) => e.kind === 'shipment_tracked' && e.paypalResourceId === captureId)) return 'already';
    const ordered = [...events].reverse().find((e) => e.kind === 'supplier_ordered');
    const supplierRef = ordered?.detail?.merchant_order_number;
    const trackingNumber = typeof supplierRef === 'string' && SAFE_REF.test(supplierRef) ? supplierRef : `SVP-${payment.id.slice(0, 8).toUpperCase()}`;
    const requestId = `svp-track-${captureId}`;
    const out = await this.runner.run<{ tracker_identifiers?: unknown; errors?: unknown }>('create_shipment_tracking', {
      transaction_id: captureId,
      tracking_number: trackingNumber,
      status: 'DELIVERED',
      carrier: 'OTHER'
    }, requestId);
    const added = Array.isArray(out.tracker_identifiers) ? out.tracker_identifiers.length : 0;
    if (added === 0) return 'failed';
    await ctx.repo.record(payment.id, {
      event: {
        kind: 'shipment_tracked', amountMinor: 0, actor: 'system',
        reason: `Delivery tracking ${trackingNumber} added to the PayPal charge (Agent Toolkit)`,
        detail: { tracking_number: trackingNumber, status: 'DELIVERED', carrier: 'OTHER' },
        paypalRequestId: requestId, paypalResourceId: captureId, correlationId: ctx.correlationId
      }
    });
    return 'tracked';
  }

  /** PayPal's tracking for a supplier order's charges; adds any that is missing first. */
  async tracking(ctx: ServiceContext, payment: PaymentRecord): Promise<TrackingView> {
    const captures = payment.paypalCaptureIds.slice(-3);
    if (captures.length === 0) return { status: 'not_charged', trackers: [] };
    const trackers: { trackingNumber: string; status: string }[] = [];
    for (const captureId of captures) {
      await this.trackDelivery(ctx, payment, captureId).catch(() => 'failed' as const);
      const out = await this.runner.run<{ trackers?: unknown }>('get_shipment_tracking', { transaction_id: captureId });
      for (const t of Array.isArray(out.trackers) ? (out.trackers as Record<string, unknown>[]) : []) {
        const number = typeof t.tracking_number === 'string' && SAFE_REF.test(t.tracking_number) ? t.tracking_number : null;
        const status = typeof t.status === 'string' && TRACKER_STATUSES.has(t.status) ? t.status : null;
        if (number && status && !trackers.some((x) => x.trackingNumber === number)) trackers.push({ trackingNumber: number, status });
      }
    }
    return { status: trackers.length > 0 ? 'tracked' : 'not_tracked', trackers };
  }

  // ---------- ledger vs PayPal's own records ----------

  /**
   * Compares the ledger's charges and refunds in the last `days` days with
   * PayPal's transaction search. Sandbox search lags (toolkit spike T7), so
   * an unlisted charge is "not listed yet", not an error; a listed charge
   * with a different amount is a mismatch.
   */
  async crossCheck(ctx: ServiceContext, days: number): Promise<CrossCheck> {
    const span = Math.max(1, Math.min(MAX_CROSS_CHECK_DAYS, Math.floor(days)));
    const end = this.now();
    const start = end - span * DAY_MS;
    const ours = new Map<string, number>();
    for (const p of await ctx.repo.listPayments({ limit: 500 })) {
      if (p.paypalCaptureIds.length === 0) continue;
      for (const e of await ctx.repo.listEvents(p.id)) {
        const at = Date.parse(e.createdAt);
        if ((e.kind === 'captured' || e.kind === 'refunded') && e.paypalResourceId && at >= start && at <= end) {
          ours.set(e.paypalResourceId, e.kind === 'refunded' ? -e.amountMinor : e.amountMinor);
        }
      }
    }
    const ledgerTotalMinor = [...ours.values()].reduce((n, v) => n + v, 0);
    if (ours.size === 0) {
      return { status: 'nothing_to_check', days: span, ledgerCount: 0, ledgerTotalMinor: 0, listedCount: 0, notYetListed: 0, amountMismatches: 0, otherPayPalActivity: 0, lastRefreshed: null };
    }
    const out = await this.runner.run<{ transaction_details?: unknown; last_refreshed_datetime?: unknown }>('list_transactions', {
      start_date: new Date(start).toISOString(),
      end_date: new Date(end).toISOString(),
      transaction_status: 'S'
    });
    let listed = 0;
    let mismatches = 0;
    let other = 0;
    for (const row of Array.isArray(out.transaction_details) ? (out.transaction_details as Record<string, unknown>[]) : []) {
      const info = (row.transaction_info ?? {}) as Record<string, unknown>;
      const id = typeof info.transaction_id === 'string' ? info.transaction_id : '';
      const amount = info.transaction_amount as { currency_code?: unknown; value?: unknown } | undefined;
      const expected = ours.get(id);
      if (expected === undefined) {
        other += 1;
        continue;
      }
      listed += 1;
      let minor: number | null = null;
      try {
        minor = typeof amount?.value === 'string' && typeof amount.currency_code === 'string' ? signedMinor(amount.value, amount.currency_code) : null;
      } catch {
        minor = null;
      }
      if (minor !== expected) mismatches += 1;
    }
    const refreshed = typeof out.last_refreshed_datetime === 'string' && !Number.isNaN(Date.parse(out.last_refreshed_datetime)) ? new Date(out.last_refreshed_datetime).toISOString() : null;
    const notYetListed = ours.size - listed;
    return {
      status: mismatches > 0 ? 'mismatch' : notYetListed > 0 ? 'lagging' : 'match',
      days: span, ledgerCount: ours.size, ledgerTotalMinor, listedCount: listed, notYetListed, amountMismatches: mismatches, otherPayPalActivity: other, lastRefreshed: refreshed
    };
  }

  // ---------- catering invoices (the shop sells) ----------

  /**
   * Checks a catering invoice against the shop's bounds and stores it as a
   * draft. Nothing is sent: sending needs the owner's confirmation.
   */
  async prepareCatering(ctx: ServiceContext, input: { readonly customerEmail: string; readonly customerName: string | null; readonly items: readonly CateringItemInput[]; readonly note: string; readonly currency: string; readonly createdBy: 'agent' | 'owner' }): Promise<SalesInvoiceRecord> {
    const email = input.customerEmail.trim().toLowerCase();
    if (!recipientAllowed(email, this.config.recipientDomains)) {
      throw new ToolkitPolicyError('recipient_not_allowed', 'Invoices go to sandbox customers only (an example.com address)');
    }
    if (input.items.length === 0 || input.items.length > 10) throw new ToolkitPolicyError('invalid_items', 'An invoice needs between 1 and 10 items');
    const lines: SalesInvoiceLine[] = [];
    for (const item of input.items) {
      const name = cleanText(item.name, 80);
      if (name.length < 2) throw new ToolkitPolicyError('invalid_items', 'Each item needs a name');
      if (!Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > 500) throw new ToolkitPolicyError('invalid_items', `The quantity of ${name} must be between 1 and 500`);
      if (!Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 1 || item.unitPriceMinor > 50_000) throw new ToolkitPolicyError('invalid_items', `The price of ${name} must be between $0.01 and $500`);
      lines.push({ name, qty: item.qty, unitPriceMinor: item.unitPriceMinor });
    }
    const totalMinor = lines.reduce((n, l) => n + l.qty * l.unitPriceMinor, 0);
    if (totalMinor > this.config.cateringMaxMinor) {
      throw new ToolkitPolicyError('over_invoice_limit', `That comes to ${dollars(totalMinor)}, over the ${dollars(this.config.cateringMaxMinor)} catering invoice limit`);
    }
    const today = await ctx.repo.listSalesInvoices({ sinceIso: new Date(this.now() - DAY_MS).toISOString(), limit: 200 });
    if (today.length >= this.config.cateringMaxPerDay * 3 || today.filter((i) => i.status !== 'draft' && i.status !== 'failed').length >= this.config.cateringMaxPerDay) {
      throw new ToolkitPolicyError('daily_limit', 'That is the most catering invoices for one day');
    }
    const invoiceNumber = `SVP-CAT-${randomBytes(5).toString('hex').toUpperCase()}`;
    return ctx.repo.createSalesInvoice({
      customerEmail: email,
      customerName: input.customerName ? cleanText(input.customerName, 80) || null : null,
      lines,
      totalMinor,
      currency: input.currency,
      note: cleanText(input.note, 200),
      invoiceNumber,
      paypalRequestId: `svp-inv-${invoiceNumber}`,
      createdBy: input.createdBy,
      correlationId: ctx.correlationId
    });
  }

  /**
   * Sends a confirmed draft: toolkit create_invoice then send_invoice, each
   * with a request id derived from the invoice number. A failure after the
   * create leaves the row 'failed' with the PayPal id, and a retry replays
   * the same keys.
   */
  async sendCatering(ctx: ServiceContext, invoiceId: string, shopName: string): Promise<SalesInvoiceRecord> {
    const invoice = await ctx.repo.getSalesInvoice(invoiceId);
    if (!invoice) throw new ToolkitPolicyError('not_found', 'I could not find that invoice');
    if (invoice.status === 'sent' || invoice.status === 'paid') return invoice;
    if (invoice.status === 'cancelled') throw new ToolkitPolicyError('cancelled', 'That invoice was cancelled');
    let paypalId = invoice.paypalInvoiceId;
    try {
      if (!paypalId) {
        const link = await this.runner.run<{ href?: unknown }>('create_invoice', {
          currency_code: invoice.currency,
          invoice_number: invoice.invoiceNumber,
          reference: invoice.invoiceNumber,
          note: invoice.note || `Catering order from ${cleanText(shopName, 60)}`,
          invoicer_business_name: `${cleanText(shopName, 60)} (sandbox)`,
          primary_recipients: [{ billing_info: { email_address: invoice.customerEmail, ...(invoice.customerName ? { business_name: invoice.customerName } : {}) } }],
          items: invoice.lines.map((l) => ({ name: l.name, quantity: String(l.qty), unit_amount: { currency_code: invoice.currency, value: toPayPalValue(l.unitPriceMinor, invoice.currency) } }))
        }, invoice.paypalRequestId);
        const id = typeof link.href === 'string' ? link.href.split('?')[0]?.split('/').pop() ?? '' : '';
        if (!PAYPAL_INVOICE_ID.test(id)) throw new ToolkitError('unexpected_response', null, 'PayPal did not return an invoice id');
        paypalId = id;
      }
      await this.runner.run('send_invoice', { invoice_id: paypalId, send_to_recipient: true, send_to_invoicer: false }, `${invoice.paypalRequestId}-send`);
    } catch (error) {
      await ctx.repo.updateSalesInvoice(invoice.id, { status: 'failed', ...(paypalId ? { paypalInvoiceId: paypalId } : {}) });
      throw error;
    }
    return ctx.repo.updateSalesInvoice(invoice.id, { status: 'sent', paypalInvoiceId: paypalId, sentAt: new Date(this.now()).toISOString() });
  }

  /** Latest invoices, with sent ones refreshed from PayPal (paid or cancelled). */
  async listCatering(ctx: ServiceContext, limit: number): Promise<SalesInvoiceRecord[]> {
    const rows = await ctx.repo.listSalesInvoices({ limit: Math.max(1, Math.min(10, limit)) });
    const out: SalesInvoiceRecord[] = [];
    for (const row of rows) {
      if (row.status !== 'sent' || !row.paypalInvoiceId) {
        out.push(row);
        continue;
      }
      try {
        const live = await this.runner.run<{ status?: unknown }>('get_invoice', { invoice_id: row.paypalInvoiceId });
        const next = live.status === 'PAID' || live.status === 'MARKED_AS_PAID' ? 'paid' : live.status === 'CANCELLED' ? 'cancelled' : null;
        out.push(next ? await ctx.repo.updateSalesInvoice(row.id, { status: next }) : row);
      } catch {
        out.push(row);
      }
    }
    return out;
  }
}

function dollars(minor: number): string {
  return `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: minor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "-12.50" USD -> -1250. */
function signedMinor(value: string, currency: string): number {
  const negative = value.trim().startsWith('-');
  const minor = fromPayPalValue(value.trim().replace(/^[-+]/, ''), currency);
  return negative ? -minor : minor;
}
