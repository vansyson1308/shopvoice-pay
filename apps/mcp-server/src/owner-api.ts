// Owner API: what the ShopVoice console's own screens use (approvals,
// ledger, spending rules, suppliers, Connect PayPal, deliveries, refunds),
// plus the PayPal webhook receiver.
//
// It is not an MCP surface and no model calls it. http.ts admits only static
// bearer tokens here (the console's server-side credential); OAuth tokens held
// by third-party AI clients are refused. Every route runs in the tenant that
// token resolves to, through PaymentsService, so the same rules, ledger state
// machine and PayPal-Request-Id discipline apply as for the tools.
import type { CountedLine, InvoiceLine, ThreeWayResult } from './reconcile/three-way-match.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../../../packages/common/dist/index.js';
import type { ShopStore } from './store.js';
import { autoCommitRepository } from './auto-commit.js';
import type { PaymentsSetup } from './payments-setup.js';
import { PaymentFlowError, describeStatus, toPublicEvent } from './payments/service.js';
import type { ServiceContext } from './payments/service.js';
import type { PaymentRecord } from './ledger/types.js';
import { heldMinor, chargedMinor, LedgerError } from './ledger/state-machine.js';
import { LedgerConflictError } from './ledger/memory-ledger.js';
import type { SpendPolicy } from './policy/policy-engine.js';
import { PayPalApiError, PayPalTransportError } from './payments/paypal-client.js';
import { readWebhookHeaders, verifyWebhookSignature } from './payments/webhooks.js';

export interface OwnerApiDeps {
  readonly store: ShopStore;
  readonly payments: PaymentsSetup;
  readonly logger: Logger;
  /** Re-seeds a sample shop to its starting state; false for a real shop. Absent = not offered. */
  readonly resetDemo?: (tenantId: string) => Promise<boolean>;
}

export const MOCK_WEBHOOK_ID = 'MOCKWEBHOOK0001';

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store'
};

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > maxBytes) throw new HttpError(413, 'body_too_large', 'Request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readRaw(req, 16_384);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body must be JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'invalid_json', 'Body must be a JSON object');
  return parsed as Record<string, unknown>;
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const minor = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 100_000_000) throw new HttpError(400, 'invalid_field', `${field} must be a whole number of cents`);
  return v;
};

/** What the console shows for a payment. No PayPal ids, vault ids or approval tokens. */
export function ownerPaymentView(p: PaymentRecord, names: Map<string, string>) {
  return {
    id: p.id,
    supplier_code: p.supplierCode,
    supplier_name: names.get(p.supplierCode) ?? p.supplierCode,
    status: p.status,
    status_text: describeStatus(p),
    decision: p.decision,
    currency: p.currency,
    amount_minor: p.requestedMinor,
    held_minor: heldMinor(p),
    charged_minor: chargedMinor(p),
    released_minor: p.voidedMinor,
    refunded_minor: p.refundedMinor,
    settled_minor: p.settledMinor,
    reasons: p.decisionReasons.map((r) => ({ code: r.code, effect: r.effect, text: r.text })),
    lines: p.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unit_cost_minor: l.unitCostMinor })),
    approved_by: p.approvedBy,
    waiting_in_paypal: p.status === 'pending_approval' && !!p.paypalOrderId,
    approval_expires_at: p.approvalExpiresAt,
    honor_period_ends_at: p.honorPeriodEndsAt,
    hold_expires_at: p.authorizationExpiresAt,
    created_by: p.createdBy,
    created_at: p.createdAt,
    updated_at: p.updatedAt
  };
}

function policyView(p: SpendPolicy) {
  return {
    currency: p.currency,
    per_order_autopay_max_minor: p.perOrderAutopayMaxMinor,
    daily_max_minor: p.dailyMaxMinor,
    weekly_max_minor: p.weeklyMaxMinor,
    daily_hard_cap_minor: p.dailyHardCapMinor,
    weekly_hard_cap_minor: p.weeklyHardCapMinor,
    allow_listed_supplier_codes: [...p.allowListedSupplierIds],
    price_jump_pct: p.priceJumpPct,
    substitution_tolerance_pct: p.substitutionTolerancePct,
    quantity_spike_multiplier: p.quantitySpikeMultiplier,
    require_delivery_check: p.requireDeliveryCheck
  };
}

function intIn(v: unknown, lo: number, hi: number, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, 'invalid_field', `${field} must be a whole number from ${lo} to ${hi}`);
  return v;
}

/** The owner edits rules directly here (authenticated owner UI), loosening included; still validated. */
function policyFromBody(before: SpendPolicy, b: Record<string, unknown>, supplierCodes: Set<string>): SpendPolicy {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const cap = (k: string, current: number | null) => (has(k) ? (b[k] === null ? null : minor(b[k], k)) : current);
  const allow = has('allow_listed_supplier_codes') ? b.allow_listed_supplier_codes : before.allowListedSupplierIds;
  if (!Array.isArray(allow) || !allow.every((c) => typeof c === 'string' && supplierCodes.has(c))) throw new HttpError(400, 'invalid_field', 'allow_listed_supplier_codes must list known supplier codes');
  const next: SpendPolicy = {
    ...before,
    perOrderAutopayMaxMinor: has('per_order_autopay_max_minor') ? minor(b.per_order_autopay_max_minor, 'per_order_autopay_max_minor') : before.perOrderAutopayMaxMinor,
    dailyMaxMinor: has('daily_max_minor') ? minor(b.daily_max_minor, 'daily_max_minor') : before.dailyMaxMinor,
    weeklyMaxMinor: has('weekly_max_minor') ? minor(b.weekly_max_minor, 'weekly_max_minor') : before.weeklyMaxMinor,
    dailyHardCapMinor: cap('daily_hard_cap_minor', before.dailyHardCapMinor),
    weeklyHardCapMinor: cap('weekly_hard_cap_minor', before.weeklyHardCapMinor),
    allowListedSupplierIds: [...new Set(allow as string[])],
    priceJumpPct: has('price_jump_pct') ? intIn(b.price_jump_pct, 1, 500, 'price_jump_pct') : before.priceJumpPct,
    substitutionTolerancePct: has('substitution_tolerance_pct') ? intIn(b.substitution_tolerance_pct, 0, 50, 'substitution_tolerance_pct') : before.substitutionTolerancePct,
    quantitySpikeMultiplier: has('quantity_spike_multiplier') ? intIn(b.quantity_spike_multiplier, 2, 20, 'quantity_spike_multiplier') : before.quantitySpikeMultiplier,
    requireDeliveryCheck: has('require_delivery_check') ? b.require_delivery_check === true : before.requireDeliveryCheck
  };
  if ((next.dailyHardCapMinor !== null && next.dailyHardCapMinor < next.dailyMaxMinor) || (next.weeklyHardCapMinor !== null && next.weeklyHardCapMinor < next.weeklyMaxMinor)) {
    throw new HttpError(400, 'hard_cap_below_budget', 'A hard cap must be at least the budget it backs up');
  }
  return next;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** Validates invoice lines from the console: plain data, bounded, nothing else passes. */
export function invoiceLinesFrom(raw: unknown): InvoiceLine[] {
  if (!Array.isArray(raw) || raw.length > 40) throw new HttpError(400, 'invalid_field', 'lines must be a list of at most 40 invoice lines');
  return raw.map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const description = typeof row.description === 'string' ? row.description.replace(CONTROL, ' ').trim().slice(0, 120) : '';
    if (!description) throw new HttpError(400, 'invalid_field', 'each invoice line needs a description');
    const sku = typeof row.sku === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(row.sku.trim()) ? row.sku.trim().toUpperCase() : null;
    return { description, sku, quantity: intIn(row.quantity, 0, 100_000, 'quantity'), unitPriceMinor: intIn(row.unit_price_minor, 0, 10_000_000, 'unit_price_minor') };
  });
}

function countedFrom(raw: unknown): CountedLine[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length > 40) throw new HttpError(400, 'invalid_field', 'counted must be a list');
  return raw.map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    if (typeof row.sku !== 'string') throw new HttpError(400, 'invalid_field', 'each counted line needs a sku');
    return { sku: row.sku, receivedQty: intIn(row.received_qty, 0, 100_000, 'received_qty') };
  });
}

export function matchView(m: ThreeWayResult) {
  return {
    result: m.result, decision: m.decision, payable_minor: m.payableMinor, invoice_total_minor: m.invoiceTotalMinor, variance_minor: m.varianceMinor,
    two_way: m.twoWay, reasons: m.reasons,
    lines: m.lines.map((l) => ({
      sku: l.sku, name: l.name, ordered_qty: l.orderedQty, counted_qty: l.countedQty, invoiced_qty: l.invoicedQty,
      po_unit_minor: l.poUnitMinor, invoice_unit_minor: l.invoiceUnitMinor, pay_qty: l.payQty, pay_minor: l.payMinor, notes: l.notes
    })),
    unmatched: m.unmatched.map((l) => ({ description: l.description, quantity: l.quantity, unit_price_minor: l.unitPriceMinor }))
  };
}

export function createOwnerApi(deps: OwnerApiDeps) {
  const { store, payments, logger } = deps;
  const service = payments.service;
  const webhookId = payments.runtime.config.webhookId || (payments.runtime.mock ? MOCK_WEBHOOK_ID : '');

  async function context(tenantId: string): Promise<{ ctx: ServiceContext; names: Map<string, string>; repo: ReturnType<typeof autoCommitRepository> }> {
    const repo = autoCommitRepository(store, tenantId);
    const names = new Map((await repo.listSuppliers()).map((s) => [s.code, s.name]));
    return { repo, names, ctx: { repo: repo.payments, correlationId: randomUUID(), supplierName: (code) => names.get(code) ?? code } };
  }

  async function mustPayment(repo: ReturnType<typeof autoCommitRepository>, id: string): Promise<PaymentRecord> {
    const p = isUuid(id) ? await repo.payments.getPayment(id) : null;
    if (!p) throw new HttpError(404, 'payment_not_found', 'No such payment');
    return p;
  }

  async function route(req: IncomingMessage, url: URL, tenantId: string): Promise<{ status: number; body: unknown }> {
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/^\/owner\/api/, '') || '/';
    const { ctx, names, repo } = await context(tenantId);
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/overview') {
      const profile = await repo.getProfile();
      const summary = await service.spendSummary(ctx, profile.displayCurrency);
      return {
        status: 200,
        body: {
          shop: { name: profile.shopName, currency: profile.displayCurrency, timezone: profile.timezone, today: await repo.today() },
          paypal: { mode: payments.runtime.config.mode, connected: summary.paypalConnected, account: summary.payerLabel },
          spend: {
            today_committed_minor: summary.todayCommittedMinor, week_committed_minor: summary.weekCommittedMinor,
            held_minor: summary.heldMinor, pending_approvals: summary.pendingApprovals
          },
          policy: policyView(summary.policy),
          policy_configured: summary.configured,
          demo_reset_available: !!deps.resetDemo
        }
      };
    }
    if (method === 'GET' && path === '/approvals') {
      const all = await repo.payments.listPayments({ limit: 200 });
      const waiting = all.filter((p) => p.status === 'pending_approval' && p.decision === 'step_up' && !p.approvedBy);
      return { status: 200, body: { approvals: waiting.map((p) => ownerPaymentView(p, names)) } };
    }
    if ((m = /^\/approvals\/([^/]+)\/(approve|decline|paypal)$/.exec(path)) && method === 'POST') {
      const [, id = '', action] = m;
      await mustPayment(repo, id);
      if (action === 'approve') {
        const body = await readBody(req);
        const result = await service.approveById(ctx, id, body.via === 'voice' ? 'owner_voice' : 'owner_tap');
        return { status: 200, body: { payment: ownerPaymentView(await mustPayment(repo, id), names), paypal_url: result.payerActionUrl, speech: result.speech } };
      }
      if (action === 'decline') {
        await service.declineById(ctx, id);
        return { status: 200, body: { payment: ownerPaymentView(await mustPayment(repo, id), names) } };
      }
      const { approveUrl } = await service.startPayPalApproval(ctx, id);
      return { status: 200, body: { approve_url: approveUrl, payment: ownerPaymentView(await mustPayment(repo, id), names) } };
    }
    if (method === 'GET' && path === '/ledger') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '200') || 200));
      return { status: 200, body: { payments: (await repo.payments.listPayments({ limit })).map((p) => ownerPaymentView(p, names)) } };
    }
    if ((m = /^\/payments\/([^/]+)$/.exec(path)) && method === 'GET') {
      const p = await mustPayment(repo, m[1] ?? '');
      const [events, deliveries] = await Promise.all([repo.payments.listEvents(p.id), repo.payments.listDeliveries(p.id)]);
      return {
        status: 200,
        body: {
          payment: ownerPaymentView(p, names),
          events: events.map(toPublicEvent),
          deliveries: deliveries.map((d) => ({ source: d.source, outcome: d.outcome, delivered_value_minor: d.deliveredValueMinor, lines: d.receivedLines, created_at: d.createdAt })),
          invoice_matches: (await repo.payments.listInvoiceMatches(p.id)).map((m) => ({ result: m.result, variance_minor: m.varianceMinor, extractor: m.extractor, invoice_lines: m.extractedLines, lines: m.poLines, created_at: m.createdAt }))
        }
      };
    }
    if ((m = /^\/payments\/([^/]+)\/invoice$/.exec(path)) && method === 'POST') {
      // Lines read from an invoice photo: untrusted data. They can only lower a charge or hold the money.
      const id = m[1] ?? '';
      await mustPayment(repo, id);
      const body = await readBody(req);
      const invoice = invoiceLinesFrom(body.lines);
      const counted = countedFrom(body.counted);
      const extractor = typeof body.extractor === 'string' ? body.extractor.replace(/[^\w .:/()+-]/g, '').slice(0, 80) : 'unknown';
      if (body.preview === true) {
        const { match } = await service.previewInvoiceMatch(ctx, id, invoice, counted);
        return { status: 200, body: { preview: true, match: matchView(match), payment: ownerPaymentView(await mustPayment(repo, id), names) } };
      }
      const result = await service.recordInvoiceDelivery(ctx, id, invoice, counted, extractor);
      let paidMinor = 0;
      if (result.payment.heldMinor === 0 && result.payment.chargedMinor > 0) {
        try {
          paidMinor = (await service.settle(ctx, id)).paidMinor;
        } catch (error) {
          if (!(error instanceof PaymentFlowError) && !(error instanceof PayPalApiError) && !(error instanceof PayPalTransportError)) throw error;
          logger.warn('owner_settle_failed', { payment_id: id, error: error.message });
        }
      }
      return { status: 200, body: { preview: false, match: matchView(result.match), outcome: result.outcome, payment: ownerPaymentView(await mustPayment(repo, id), names), supplier_paid_minor: paidMinor, speech: result.speech } };
    }
    if ((m = /^\/payments\/([^/]+)\/(delivery|refund|sync)$/.exec(path)) && method === 'POST') {
      const [, id = '', action] = m;
      const p = await mustPayment(repo, id);
      if (action === 'sync') {
        await service.sync(ctx, id);
        return { status: 200, body: { payment: ownerPaymentView(await mustPayment(repo, id), names) } };
      }
      const body = await readBody(req);
      if (action === 'refund') {
        const reason = typeof body.reason === 'string' && body.reason.trim().length >= 3 ? body.reason.trim().slice(0, 200) : null;
        if (!reason) throw new HttpError(400, 'invalid_field', 'reason is required');
        const amount = body.amount_minor === undefined || body.amount_minor === null ? null : minor(body.amount_minor, 'amount_minor');
        const done = await service.refund(ctx, id, amount, reason);
        return { status: 200, body: { payment: ownerPaymentView(await mustPayment(repo, id), names), refunded_minor: done.refundedMinor, speech: done.speech } };
      }
      let received: { sku: string; receivedQty: number }[];
      if (body.all === true) received = p.lines.map((l) => ({ sku: l.sku, receivedQty: l.qty }));
      else if (body.none === true) received = [];
      else if (Array.isArray(body.lines)) {
        received = body.lines.map((l: unknown) => {
          const row = (l ?? {}) as Record<string, unknown>;
          if (typeof row.sku !== 'string') throw new HttpError(400, 'invalid_field', 'each line needs a sku');
          return { sku: row.sku, receivedQty: intIn(row.received_qty, 0, 100_000, 'received_qty') };
        });
      } else throw new HttpError(400, 'invalid_field', 'send all, none, or lines');
      const result = await service.recordDelivery(ctx, id, received, 'console');
      let paidMinor = 0;
      if (result.payment.heldMinor === 0 && result.payment.chargedMinor > 0) {
        try {
          paidMinor = (await service.settle(ctx, id)).paidMinor;
        } catch (error) {
          if (!(error instanceof PaymentFlowError) && !(error instanceof PayPalApiError) && !(error instanceof PayPalTransportError)) throw error;
          logger.warn('owner_settle_failed', { payment_id: id, error: error.message });
        }
      }
      return { status: 200, body: { payment: ownerPaymentView(await mustPayment(repo, id), names), outcome: result.outcome, supplier_paid_minor: paidMinor, speech: result.speech } };
    }
    if (method === 'GET' && path === '/policy') {
      const profile = await repo.getProfile();
      const { policy, configured } = await service.getPolicy(ctx, profile.displayCurrency);
      return { status: 200, body: { policy: policyView(policy), configured } };
    }
    if (method === 'PUT' && path === '/policy') {
      const profile = await repo.getProfile();
      const { policy: before } = await service.getPolicy(ctx, profile.displayCurrency);
      const next = policyFromBody(before, await readBody(req), new Set(names.keys()));
      await service.savePolicy(ctx, next);
      return { status: 200, body: { policy: policyView(next), configured: true } };
    }
    if (method === 'GET' && path === '/suppliers') {
      const [suppliers, payees, policy] = await Promise.all([repo.listSuppliers(), repo.payments.listPayees(), repo.payments.getPolicy()]);
      const byCode = new Map(payees.map((p) => [p.supplierCode, p]));
      return {
        status: 200,
        body: {
          suppliers: suppliers.map((s) => ({
            code: s.code, name: s.name, lead_time_days: s.leadTimeDays,
            paypal_email: byCode.get(s.code)?.paypalEmail ?? null, verified: byCode.get(s.code)?.verified ?? false,
            approved: policy?.allowListedSupplierIds.includes(s.code) ?? false
          }))
        }
      };
    }
    if ((m = /^\/suppliers\/([^/]+)$/.exec(path)) && method === 'PUT') {
      const code = decodeURIComponent(m[1] ?? '');
      if (!names.has(code)) throw new HttpError(404, 'supplier_not_found', 'No such supplier');
      const body = await readBody(req);
      const email = typeof body.paypal_email === 'string' ? body.paypal_email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'invalid_field', 'paypal_email must be an email address');
      const current = (await repo.payments.listPayees()).find((p) => p.supplierCode === code);
      await repo.payments.upsertPayee({ supplierCode: code, paypalEmail: email, paypalMerchantId: null, currency: current?.currency ?? 'USD', verified: body.verified === true });
      return { status: 200, body: { code, paypal_email: email, verified: body.verified === true } };
    }
    if (method === 'POST' && path === '/paypal/connect') {
      const { methodId, approveUrl } = await service.startConnect(ctx);
      return { status: 200, body: { method_id: methodId, approve_url: approveUrl } };
    }
    if (method === 'POST' && path === '/paypal/complete') {
      const body = await readBody(req);
      const methodId = typeof body.method_id === 'string' ? body.method_id : '';
      if (!isUuid(methodId)) throw new HttpError(400, 'invalid_field', 'method_id is required');
      const { payerLabel } = await service.completeConnect(ctx, methodId);
      return { status: 200, body: { connected: true, account: payerLabel } };
    }
    if ((m = /^\/mock-paypal\/(order|setup)\/([A-Za-z0-9]{6,40})(\/approve)?$/.exec(path))) {
      const mock = payments.runtime.mock;
      if (!mock) throw new HttpError(404, 'not_found', 'Simulated PayPal is only available with PAYPAL_MODE=mock');
      const kind = m[1] as 'order' | 'setup';
      const objectId = m[2] ?? '';
      const page = mock.approvalPage(kind, objectId);
      if (!page) throw new HttpError(404, 'not_found', 'No such simulated PayPal approval');
      if (method === 'GET' && !m[3]) return { status: 200, body: { simulated: true, kind, amount_minor: page.amountMinor, currency: page.currency, description: page.description, return_url: page.returnUrl, cancel_url: page.cancelUrl } };
      if (method === 'POST' && m[3]) {
        if (kind === 'order') mock.approveOrder(objectId); else mock.approveSetupToken(objectId);
        return { status: 200, body: { approved: true, return_url: page.returnUrl } };
      }
    }
    if (method === 'POST' && path === '/demo/reset') {
      if (!deps.resetDemo) throw new HttpError(404, 'not_found', 'Demo reset is not available here');
      if (!(await deps.resetDemo(tenantId))) throw new HttpError(409, 'not_a_sample_shop', 'Only sample shops can be reset');
      return { status: 200, body: { reset: true } };
    }
    throw new HttpError(404, 'not_found', 'No such owner API route');
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL, tenantId: string): Promise<void> {
      try {
        const out = await route(req, url, tenantId);
        send(res, out.status, out.body);
      } catch (error) {
        if (error instanceof HttpError) return send(res, error.status, { error: error.code, message: error.message });
        if (error instanceof PaymentFlowError) return send(res, 409, { error: error.code, message: error.message });
        if (error instanceof LedgerError || error instanceof LedgerConflictError) return send(res, 409, { error: error.code, message: error.message });
        if (error instanceof PayPalApiError) return send(res, 502, { error: 'paypal_error', message: `PayPal declined the request (${error.code})` });
        if (error instanceof PayPalTransportError) return send(res, 504, { error: 'paypal_unreachable', message: 'PayPal did not answer; nothing was changed twice. Retry shortly.' });
        logger.error('owner_api_failed', { path: url.pathname, error: error instanceof Error ? error.message : 'unknown' });
        send(res, 500, { error: 'server_error', message: 'Something went wrong; retry in a few seconds.' });
      }
    },

    /**
     * PayPal webhook. The signature is checked with PayPal itself (the raw
     * body, byte for byte); the event only tells us which payment to look at.
     * Money state is never taken from the payload: sync() re-reads PayPal.
     */
    async handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const raw = await readRaw(req, 65_536);
        const headers = readWebhookHeaders(req.headers);
        if (!headers || !webhookId) return send(res, 400, { error: 'unverifiable' });
        let event: { id?: unknown; event_type?: unknown; resource?: Record<string, unknown> };
        try {
          event = JSON.parse(raw) as typeof event;
        } catch {
          return send(res, 400, { error: 'invalid_json' });
        }
        const ok = await verifyWebhookSignature(payments.runtime.client, { webhookId, headers, rawEvent: raw, requestId: `svp-whv-${headers.transmissionId}`.slice(0, 100) });
        if (!ok) {
          logger.warn('paypal_webhook_rejected', { transmission_id: headers.transmissionId });
          return send(res, 400, { error: 'signature_invalid' });
        }
        const resource = event.resource ?? {};
        const units = Array.isArray(resource.purchase_units) ? (resource.purchase_units as Record<string, unknown>[]) : [];
        const paymentId = String(resource.custom_id ?? units[0]?.custom_id ?? '');
        const tenantId = isUuid(paymentId) ? await store.resolvePaymentTenant(paymentId) : null;
        if (!tenantId) return send(res, 200, { status: 'ignored' });
        const { ctx, repo } = await context(tenantId);
        try {
          await repo.payments.record(paymentId, {
            event: { kind: 'webhook_received', amountMinor: 0, actor: 'paypal', reason: `PayPal event ${String(event.event_type ?? 'unknown')}`.slice(0, 200), paypalRequestId: `wh-${String(event.id ?? headers.transmissionId)}`.slice(0, 120), correlationId: ctx.correlationId }
          });
        } catch (error) {
          if (error instanceof LedgerConflictError && error.code === 'duplicate_request_id') return send(res, 200, { status: 'duplicate' });
          throw error;
        }
        await service.sync(ctx, paymentId);
        send(res, 200, { status: 'processed' });
      } catch (error) {
        if (error instanceof HttpError) return send(res, error.status, { error: error.code });
        logger.error('paypal_webhook_failed', { error: error instanceof Error ? error.message : 'unknown' });
        // 500 makes PayPal retry later, which is what we want for transient failures.
        send(res, 500, { error: 'server_error' });
      }
    }
  };
}

export type OwnerApi = ReturnType<typeof createOwnerApi>;
