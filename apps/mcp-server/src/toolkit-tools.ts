// Tools backed by the PayPal Agent Toolkit, through ToolkitGateway (the policy
// layer, DECISIONS D19). The model passes ShopVoice ids and plain amounts; it
// never names a toolkit method, a PayPal capture id or a PayPal invoice id,
// and none of those come back in tool output.
import { z } from 'zod';
import { defineTool, READ_ONLY, moneyOut } from './tools.js';
import type { ToolAnnotations, ToolContext } from './tools.js';
import { fitSpeech, formatMoney, minorToDisplay, speakList } from './speech.js';
import { maskEmail } from './payments/service.js';
import type { PublicPayment } from './payments/service.js';
import type { SalesInvoiceRecord } from './ledger/types.js';
import { ToolkitError } from './toolkit/agent-toolkit.js';
import { MAX_CROSS_CHECK_DAYS, ToolkitPolicyError } from './toolkit/toolkit-gateway.js';
import type { ToolkitGateway } from './toolkit/toolkit-gateway.js';
import { PayPalApiError, PayPalTransportError } from './payments/paypal-client.js';
import { LedgerConflictError } from './ledger/memory-ledger.js';
import { NOT_SET_UP, SESSION_WRITE, findPayment, lookupInput, nameOf, paymentOut, paymentSchema, supplierNames } from './payment-tools.js';

/** Reads from PayPal (open world). */
const PAYPAL_READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Adds missing delivery tracking on PayPal: a write, but idempotent, and it moves no money. */
const PAYPAL_TRACK: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const TOOLKIT_OFF = 'The PayPal toolkit features are not set up here.';
const CATERING_TTL_SECONDS = 300;

function gatewayOf(ctx: ToolContext): ToolkitGateway | null {
  return ctx.payments?.service.toolkit ?? null;
}

function isRemoteFailure(error: unknown): boolean {
  return error instanceof ToolkitError || error instanceof PayPalApiError || error instanceof PayPalTransportError;
}

// ---------- delivery tracking on supplier orders ----------

export const getDeliveryTracking = defineTool({
  name: 'get_delivery_tracking',
  title: 'Delivery tracking on a supplier charge',
  description: "Shows the delivery tracking PayPal has on a charged supplier order (added automatically through the PayPal Agent Toolkit once a delivery is charged; added now if it is missing). Defaults to the latest charged order. Tracking numbers come from the supplier's ordering agent (simulated).",
  input: lookupInput,
  output: {
    status: z.enum(['tracked', 'not_tracked', 'not_charged', 'not_found', 'not_set_up', 'unavailable']),
    trackers: z.array(z.object({ tracking_number: z.string(), status: z.string() })),
    payment: paymentSchema.nullable()
  },
  annotations: PAYPAL_TRACK,
  session: true,
  async run(ctx, args) {
    const gateway = gatewayOf(ctx);
    if (!ctx.payments || !gateway) return { speech: ctx.payments ? TOOLKIT_OFF : NOT_SET_UP, data: { status: 'not_set_up' as const, trackers: [], payment: null } };
    const bridge = ctx.payments;
    const names = await supplierNames(ctx.repo);
    const charged = (p: PublicPayment) => p.chargedMinor > 0 || p.refundedMinor > 0;
    const target = await findPayment(bridge, names, args, charged);
    if (!target) return { speech: args.supplier ? `I don't see a charged order from "${args.supplier}".` : "I don't see a charged supplier order yet.", data: { status: 'not_found' as const, trackers: [], payment: null } };
    const raw = await ctx.repo.payments.getPayment(target.paymentId);
    const supplier = nameOf(names, target.supplierCode);
    if (!raw) return { speech: `I don't see a charged order from ${supplier}.`, data: { status: 'not_found' as const, trackers: [], payment: null } };
    try {
      const view = await gateway.tracking(bridge.ctx, raw);
      const first = view.trackers[0];
      const speech = view.status === 'tracked' && first
        ? `PayPal shows the ${supplier} order as ${first.status.toLowerCase().replace('_', ' ')}, tracking ${first.trackingNumber}.`
        : view.status === 'not_charged'
          ? `Nothing has been charged for ${supplier} yet, so there is no tracking.`
          : `PayPal has no tracking on the ${supplier} charge yet.`;
      return { speech, data: { status: view.status, trackers: view.trackers.map((t) => ({ tracking_number: t.trackingNumber, status: t.status })), payment: paymentOut(ctx, target, names) } };
    } catch (error) {
      if (!isRemoteFailure(error)) throw error;
      return { speech: `I couldn't reach PayPal for the ${supplier} tracking. Try again in a minute.`, data: { status: 'unavailable' as const, trackers: [], payment: paymentOut(ctx, target, names) } };
    }
  }
});

// ---------- ledger vs PayPal's own records ----------

export const checkPayPalRecords = defineTool({
  name: 'check_paypal_records',
  title: "Cross-check spending with PayPal's records",
  description: "Cross-checks the ledger's supplier charges and refunds for the last N days (default 7, at most 31) against PayPal's own transaction records (PayPal Agent Toolkit list_transactions). Spend totals themselves come from the ledger (get_spend_summary); PayPal's sandbox records lag behind real time, so recent charges may not be listed yet.",
  input: { days: z.number().int().min(1).max(MAX_CROSS_CHECK_DAYS).default(7) },
  output: {
    status: z.enum(['match', 'lagging', 'mismatch', 'nothing_to_check', 'not_set_up', 'unavailable']),
    days: z.number().int(),
    ...moneyOut,
    ledger_count: z.number().int(),
    ledger_total: z.number(),
    listed_in_paypal: z.number().int(),
    not_yet_listed: z.number().int(),
    amount_mismatches: z.number().int(),
    other_paypal_activity: z.number().int(),
    paypal_last_refreshed: z.string().nullable()
  },
  annotations: PAYPAL_READ,
  session: true,
  async run(ctx, args) {
    const gateway = gatewayOf(ctx);
    const empty = { days: args.days, currency: ctx.money.currency, ledger_count: 0, ledger_total: 0, listed_in_paypal: 0, not_yet_listed: 0, amount_mismatches: 0, other_paypal_activity: 0, paypal_last_refreshed: null };
    if (!ctx.payments || !gateway) return { speech: ctx.payments ? TOOLKIT_OFF : NOT_SET_UP, data: { status: 'not_set_up' as const, ...empty } };
    try {
      const c = await gateway.crossCheck(ctx.payments.ctx, args.days);
      const span = `the last ${c.days === 1 ? 'day' : `${c.days} days`}`;
      const total = formatMoney(Math.abs(c.ledgerTotalMinor), ctx.money);
      const n = `${c.ledgerCount} ${c.ledgerCount === 1 ? 'charge' : 'charges and refunds'}`;
      const speech = c.status === 'match'
        ? `PayPal's records match the ledger: ${n}, ${total}, in ${span}.`
        : c.status === 'lagging'
          ? `PayPal lists ${c.listedCount} of ${n} so far, with no amount differences. Its sandbox records lag, so ${c.notYetListed} ${c.notYetListed === 1 ? "isn't" : "aren't"} listed yet.`
          : c.status === 'mismatch'
            ? `${c.amountMismatches} ${c.amountMismatches === 1 ? 'charge has' : 'charges have'} a different amount at PayPal than in the ledger. Check the Ledger tab.`
            : `There are no PayPal charges in ${span} to check.`;
      return {
        speech: fitSpeech([speech]),
        data: {
          status: c.status, days: c.days, currency: ctx.money.currency, ledger_count: c.ledgerCount, ledger_total: minorToDisplay(c.ledgerTotalMinor, ctx.money),
          listed_in_paypal: c.listedCount, not_yet_listed: c.notYetListed, amount_mismatches: c.amountMismatches, other_paypal_activity: c.otherPayPalActivity, paypal_last_refreshed: c.lastRefreshed
        }
      };
    } catch (error) {
      if (!isRemoteFailure(error)) throw error;
      return { speech: "I couldn't reach PayPal's records just now. The ledger is unaffected.", data: { status: 'unavailable' as const, ...empty } };
    }
  }
});

// ---------- catering invoices (the shop sells; two steps) ----------

const invoiceSchema = z.object({
  invoice_id: z.string(),
  number: z.string(),
  status: z.enum(['draft', 'sent', 'paid', 'cancelled', 'failed']),
  customer: z.string(),
  items: z.array(z.object({ description: z.string(), quantity: z.number().int(), unit_price: z.number() })),
  total: z.number(),
  created_at: z.string(),
  sent_at: z.string().nullable()
});

function invoiceOut(ctx: ToolContext, i: SalesInvoiceRecord): z.infer<typeof invoiceSchema> {
  return {
    invoice_id: i.id,
    number: i.invoiceNumber,
    status: i.status,
    customer: i.customerName ? `${i.customerName} (${maskEmail(i.customerEmail)})` : maskEmail(i.customerEmail),
    items: i.lines.map((l) => ({ description: l.name, quantity: l.qty, unit_price: minorToDisplay(l.unitPriceMinor, ctx.money) })),
    total: minorToDisplay(i.totalMinor, ctx.money),
    created_at: i.createdAt,
    sent_at: i.sentAt
  };
}

export const createCateringInvoice = defineTool({
  name: 'create_catering_invoice',
  title: 'Invoice a catering customer through PayPal (two steps)',
  description: "Bills one of the shop's own catering customers through a PayPal invoice (PayPal Agent Toolkit create_invoice and send_invoice). First call with customer_email and items: the server checks the bounds (sandbox customers only, at most 10 items, the shop's invoice limit) and returns a preview with a confirmation_token valid 5 minutes. A second call with that token sends the invoice. unit_price is in the shop currency.",
  input: {
    customer_email: z.string().trim().max(254).optional().describe('The customer\'s email address (sandbox: an example.com address).'),
    customer_name: z.string().trim().max(80).optional(),
    items: z.array(z.object({
      description: z.string().trim().min(2).max(80),
      quantity: z.number().int().min(1).max(500),
      unit_price: z.number().positive().max(500)
    })).min(1).max(10).optional(),
    note: z.string().trim().max(200).optional(),
    confirmation_token: z.string().trim().min(10).max(200).optional()
  },
  output: {
    status: z.enum(['needs_confirmation', 'sent', 'expired', 'invalid', 'refused', 'failed', 'not_set_up']),
    confirmation_token: z.string().nullable(),
    ...moneyOut,
    total: z.number(),
    invoice: invoiceSchema.nullable(),
    reason: z.string().nullable()
  },
  annotations: SESSION_WRITE,
  session: true,
  redact: (args) => ({ ...args, customer_email: args.customer_email ? maskEmail(args.customer_email) : undefined, confirmation_token: args.confirmation_token ? '[redacted]' : undefined }),
  async run(ctx, args) {
    const gateway = gatewayOf(ctx);
    const none = { confirmation_token: null, currency: ctx.money.currency, total: 0, invoice: null, reason: null };
    if (!ctx.payments || !gateway) return { speech: ctx.payments ? TOOLKIT_OFF : NOT_SET_UP, data: { status: 'not_set_up' as const, ...none } };
    const bridge = ctx.payments;
    const tenant = ctx.profile.tenantId;

    if (args.confirmation_token) {
      const [prefix, invoiceId = '', ...sig] = args.confirmation_token.split('.');
      const draft = prefix === 'ci' ? await ctx.repo.payments.getSalesInvoice(invoiceId) : null;
      const verdict = draft ? bridge.service.verifyConfirmation('catering_invoice', [tenant, draft.id, String(draft.totalMinor), draft.customerEmail], sig.join('.')) : 'invalid';
      if (!draft || verdict !== 'ok') {
        return { speech: verdict === 'expired' ? 'That invoice request expired. Ask me again to start a new one.' : "That invoice confirmation doesn't match. Ask me again to start a new one.", data: { status: verdict === 'ok' ? 'invalid' as const : verdict, ...none } };
      }
      try {
        const sent = await gateway.sendCatering(bridge.ctx, draft.id, ctx.profile.shopName);
        return {
          speech: `Sent. The ${formatMoney(sent.totalMinor, ctx.money)} catering invoice is on its way to ${maskEmail(sent.customerEmail)} through PayPal.`,
          data: { status: 'sent' as const, confirmation_token: null, currency: ctx.money.currency, total: minorToDisplay(sent.totalMinor, ctx.money), invoice: invoiceOut(ctx, sent), reason: null }
        };
      } catch (error) {
        if (error instanceof ToolkitPolicyError) return { speech: `${error.message}.`, data: { status: 'refused' as const, ...none, reason: error.message } };
        if (!isRemoteFailure(error)) throw error;
        return { speech: "PayPal didn't take the invoice, so nothing was sent. Say confirm to try again.", data: { status: 'failed' as const, ...none, reason: 'paypal_unavailable' } };
      }
    }

    if (!args.customer_email || !args.items || args.items.length === 0) {
      return { speech: "Who is the invoice for, and what's on it? I need the customer's email and the items.", data: { status: 'invalid' as const, ...none, reason: 'customer_email and items are required' } };
    }
    try {
      const draft = await gateway.prepareCatering(bridge.ctx, {
        customerEmail: args.customer_email,
        customerName: args.customer_name ?? null,
        items: args.items.map((i) => ({ name: i.description, qty: i.quantity, unitPriceMinor: Math.round(i.unit_price * ctx.money.minorPerUnit) })),
        note: args.note ?? '',
        currency: ctx.money.currency,
        createdBy: 'agent'
      });
      const signature = bridge.service.signConfirmation('catering_invoice', [tenant, draft.id, String(draft.totalMinor), draft.customerEmail], CATERING_TTL_SECONDS);
      const items = draft.lines.map((l) => `${l.qty} × ${l.name}`);
      const total = formatMoney(draft.totalMinor, ctx.money);
      const to = maskEmail(draft.customerEmail);
      return {
        speech: fitSpeech([
          `Invoice ${to} ${total} for ${speakList(items, 3, ', ')} through PayPal? Say "confirm" within 5 minutes.`,
          `Invoice ${to} ${total} through PayPal? Say "confirm" within 5 minutes.`
        ]),
        data: { status: 'needs_confirmation' as const, confirmation_token: `ci.${draft.id}.${signature}`, currency: ctx.money.currency, total: minorToDisplay(draft.totalMinor, ctx.money), invoice: invoiceOut(ctx, draft), reason: null }
      };
    } catch (error) {
      if (error instanceof ToolkitPolicyError) return { speech: `${error.message}.`, data: { status: 'refused' as const, ...none, reason: error.code } };
      if (error instanceof LedgerConflictError) return { speech: 'That invoice already exists. Ask me again to start a new one.', data: { status: 'invalid' as const, ...none, reason: error.code } };
      throw error;
    }
  }
});

export const getCateringInvoices = defineTool({
  name: 'get_catering_invoices',
  title: 'Catering invoices and whether they are paid',
  description: "Lists the shop's latest catering invoices (sent through PayPal) and whether each customer has paid, refreshed from PayPal (Agent Toolkit get_invoice).",
  input: { limit: z.number().int().min(1).max(10).default(3) },
  output: { ...moneyOut, invoices: z.array(invoiceSchema) },
  annotations: PAYPAL_READ,
  session: true,
  async run(ctx, args) {
    const gateway = gatewayOf(ctx);
    if (!ctx.payments || !gateway) return { speech: ctx.payments ? TOOLKIT_OFF : NOT_SET_UP, data: { currency: ctx.money.currency, invoices: [] } };
    const rows = (await gateway.listCatering(ctx.payments.ctx, args.limit)).filter((i) => i.status !== 'draft');
    if (rows.length === 0) return { speech: 'There are no catering invoices yet.', data: { currency: ctx.money.currency, invoices: [] } };
    const word = (i: SalesInvoiceRecord) => (i.status === 'sent' ? 'waiting for payment' : i.status === 'failed' ? 'not sent' : i.status);
    const parts = rows.map((i) => `${formatMoney(i.totalMinor, ctx.money)} to ${i.customerName ?? maskEmail(i.customerEmail)}, ${word(i)}`);
    const speech = rows.length === 1 ? `Latest catering invoice: ${parts[0]}.` : `${rows.length} catering invoices: ${speakList(parts, 3)}.`;
    return { speech: fitSpeech([speech, `Latest catering invoice: ${parts[0]}.`]), data: { currency: ctx.money.currency, invoices: rows.map((i) => invoiceOut(ctx, i)) } };
  }
});

export const TOOLKIT_TOOLS = [getDeliveryTracking, checkPayPalRecords, createCateringInvoice, getCateringInvoices] as const;
