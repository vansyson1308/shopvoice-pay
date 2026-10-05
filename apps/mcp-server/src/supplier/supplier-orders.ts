// ShopVoice's buyer agent for supplier ordering (agent to agent). After PayPal
// places a hold, server code (not the model) opens a cart with the supplier's
// agent, which implements the merchant side of PayPal's Cart API spec
// (simulated suppliers in this demo), resolves its validation issues within
// the owner's rules, and checks the cart out with the PayPal order id. Capture
// still waits for delivery (DECISIONS D6).
//
// Supplier responses are untrusted: names and messages from the supplier are
// never spoken or shown to the model; a substitution is judged by the policy's
// substitution rule using our own catalog's product facts, and can never cost
// more than the money already on hold.
import { signJwt } from '../../../../packages/common/dist/index.js';
import type { KeyObject } from 'node:crypto';
import { SUPPLIER_AGENT_AUDIENCE, fromMoney, toMoney } from '../../../supplier-agent/dist/index.js';
import type { Cart, CartItem, SupplierAgent, ValidationIssue } from '../../../supplier-agent/dist/index.js';
import { evaluateSubstitution } from '../policy/substitution.js';
import type { OfferLine } from '../policy/substitution.js';
import { DEFAULT_POLICY } from '../policy/policy-engine.js';
import type { PolicyDraftLine } from '../policy/policy-engine.js';
import type { PaymentRecord } from '../ledger/types.js';
import type { AfterAuthorized, ServiceContext } from '../payments/service.js';

export interface CartTransport {
  call(supplierCode: string, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }>;
}

/** The supplier agent mounted in this process (the default for the hosted demo). */
export class DirectCartTransport implements CartTransport {
  constructor(private readonly agent: SupplierAgent) {}
  call(supplierCode: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
    return this.agent.handle(supplierCode, method, path, headers, body);
  }
}

/** A supplier agent at another URL: `${base}/<supplier code>/merchant-cart...`. */
export class HttpCartTransport implements CartTransport {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async call(supplierCode: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(supplierCode)}/merchant-cart${path}`, {
      method,
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000)
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }
}

/** A product's family and sellable base units, from our own catalog name ("Large eggs 30 ct" -> large eggs, 30). */
export function productFacts(name: string): { family: string; baseUnits: number } {
  const lower = name.toLowerCase();
  const count = /(\d+)\s*ct\b/.exec(lower) ?? /crate of (\d+)/.exec(lower) ?? /(\d+)-pack\b/.exec(lower);
  const baseUnits = count ? Number(count[1]) : /\bdozen\b/.test(lower) ? 12 : 1;
  const family = lower
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d+\s*ct\b|\bdozen\b|\b\d+-pack\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { family, baseUnits };
}

interface Accepted {
  readonly from: PolicyDraftLine;
  readonly to: PolicyDraftLine;
  readonly priceChangePct: number;
}

function speakQty(line: PolicyDraftLine): string {
  return `${line.qty} × ${line.name}`;
}

export class SupplierOrders implements AfterAuthorized {
  constructor(
    private readonly transport: CartTransport,
    private readonly signer: { readonly privateKey: KeyObject; readonly kid: string },
    private readonly now: () => number = Date.now
  ) {}

  private headers(supplierCode: string, requestId?: string): Record<string, string> {
    const token = signJwt(this.signer.privateKey, this.signer.kid, { iss: 'shopvoice-buyer-agent', aud: SUPPLIER_AGENT_AUDIENCE, merchant_id: supplierCode, scope: ['cart'], ttlSeconds: 300 }, this.now());
    return { authorization: `Bearer ${token}`, ...(requestId ? { 'paypal-request-id': requestId } : {}) };
  }

  private itemsOf(lines: readonly PolicyDraftLine[], currency: string): CartItem[] {
    return lines.map((l) => ({ variant_id: l.sku, quantity: l.qty, name: l.name, price: toMoney(l.unitCostMinor, currency) }));
  }

  /** Resolves one issue within the rules, or explains why it cannot be. */
  private async resolve(ctx: ServiceContext, issue: ValidationIssue, lines: readonly PolicyDraftLine[], tolerancePct: number): Promise<{ accepted?: Accepted; problem?: string }> {
    const line = lines.find((l) => l.sku === issue.variant_id);
    if (!line) return { problem: 'reported a problem with an item that is not on the order' };
    const specific = issue.context?.specific_issue;
    if (specific === 'ITEM_OUT_OF_STOCK') {
      const alt = issue.context?.suggested_alternatives?.[0];
      const price = fromMoney(alt?.price);
      const ourName = alt && /^[A-Za-z0-9_-]{1,64}$/.test(alt.variant_id) ? await ctx.productName?.(alt.variant_id) : null;
      if (!alt || price === null || !ourName || !Number.isSafeInteger(alt.quantity) || alt.quantity <= 0) {
        return { problem: `is out of ${line.name} and offered nothing I can check` };
      }
      const orig = productFacts(line.name);
      const sub = productFacts(ourName);
      const original: OfferLine = { sku: line.sku, name: line.name, qty: line.qty, unitCostMinor: line.unitCostMinor, baseUnitsPerQty: orig.baseUnits, family: orig.family };
      const proposed: OfferLine = { sku: alt.variant_id, name: ourName, qty: alt.quantity, unitCostMinor: price, baseUnitsPerQty: sub.baseUnits, family: sub.family };
      const verdict = evaluateSubstitution(original, [proposed], tolerancePct);
      if (!verdict.accept) return { problem: `is out of ${line.name}; its offer was outside your rules (${verdict.reasons[0] ?? 'not accepted'})` };
      return { accepted: { from: line, to: { sku: alt.variant_id, name: ourName, qty: alt.quantity, unitCostMinor: price }, priceChangePct: verdict.priceChangePct } };
    }
    if (specific === 'PRICE_MISMATCH') {
      const current = fromMoney(issue.context?.current_price);
      if (current !== null && current <= line.unitCostMinor) return { accepted: { from: line, to: { ...line, unitCostMinor: current }, priceChangePct: 0 } };
      return { problem: `raised the price of ${line.name}, so I did not accept it` };
    }
    return { problem: `could not supply ${line.name}` };
  }

  async afterAuthorized(ctx: ServiceContext, payment: PaymentRecord): Promise<{ payment: PaymentRecord; note: string | null }> {
    if (payment.status !== 'authorized' || !payment.paypalOrderId || payment.capturedMinor > 0) return { payment, note: null };
    const events = await ctx.repo.listEvents(payment.id);
    if (events.some((e) => e.kind === 'supplier_ordered')) return { payment, note: null };
    const name = ctx.supplierName(payment.supplierCode);
    const policy = await ctx.repo.getPolicy();
    const tolerance = policy?.substitutionTolerancePct ?? DEFAULT_POLICY.substitutionTolerancePct;

    const created = await this.transport.call(payment.supplierCode, 'POST', '', this.headers(payment.supplierCode, `svp-cart-${payment.id}`), { items: this.itemsOf(payment.lines, payment.currency) });
    if (created.status === 404) return { payment, note: null }; // this supplier has no ordering agent
    if (created.status !== 201) throw new Error(`supplier agent refused the cart (${created.status})`);
    let cart = created.json as unknown as Cart;
    let lines: readonly PolicyDraftLine[] = payment.lines;
    let current = payment;
    let note: string | null = null;

    if (cart.status !== 'READY') {
      const accepted: Accepted[] = [];
      const problems: string[] = [];
      for (const issue of cart.validation_issues ?? []) {
        const r = await this.resolve(ctx, issue, lines, tolerance);
        if (r.accepted) accepted.push(r.accepted);
        else problems.push(r.problem ?? 'reported a problem');
      }
      const proposed = lines.map((l) => accepted.find((a) => a.from.sku === l.sku)?.to ?? l);
      const totalMinor = proposed.reduce((acc, l) => acc + l.qty * l.unitCostMinor, 0);
      if (problems.length === 0 && totalMinor > current.authorizedMinor) problems.push('offered changes that cost more than the money on hold');
      if (problems.length > 0) {
        await ctx.repo.record(payment.id, {
          event: { kind: 'cart_negotiated', amountMinor: payment.authorizedMinor, actor: 'agent', reason: `${name} ${problems[0]}. The order was not changed`, detail: { cart_id: cart.id, outcome: 'needs_owner', issues: (cart.validation_issues ?? []).map((i) => i.context?.specific_issue ?? i.code) }, correlationId: ctx.correlationId }
        });
        return { payment, note: `${name}'s substitute was outside your rules, so I kept the order as placed. Nothing is charged unless it arrives.` };
      }
      const replaced = await this.transport.call(payment.supplierCode, 'PUT', `/${encodeURIComponent(cart.id)}`, this.headers(payment.supplierCode), { items: this.itemsOf(proposed, payment.currency) });
      cart = replaced.json as unknown as Cart;
      if (replaced.status !== 200 || cart.status !== 'READY') throw new Error('supplier agent did not accept the updated cart');
      lines = proposed;
      const swap = accepted[0] as Accepted;
      const reason = `${name} was out of ${swap.from.name}; took ${speakQty(swap.to)} instead (price change ${swap.priceChangePct}%, within your ${tolerance}% rule)`;
      current = await ctx.repo.record(payment.id, {
        patch: { lines },
        event: { kind: 'cart_negotiated', amountMinor: totalMinor, actor: 'agent', reason, detail: { cart_id: cart.id, outcome: 'substituted', substitutions: accepted.map((a) => ({ from: a.from.sku, from_qty: a.from.qty, to: a.to.sku, to_qty: a.to.qty, unit_cost_minor: a.to.unitCostMinor, price_change_pct: a.priceChangePct })) }, correlationId: ctx.correlationId }
      });
      note = swap.priceChangePct === 0
        ? `${name} was out of ${swap.from.name}, so I took ${speakQty(swap.to)} at the same price.`
        : `${name} was out of ${swap.from.name}, so I took ${speakQty(swap.to)}, within your ${tolerance}% rule.`;
    }

    const checkout = await this.transport.call(payment.supplierCode, 'POST', `/${encodeURIComponent(cart.id)}/checkout`, this.headers(payment.supplierCode, `svp-checkout-${payment.id}`), { payment_method: { type: 'paypal', token: payment.paypalOrderId } });
    const done = checkout.json as unknown as Cart;
    const number = done.payment_confirmation?.merchant_order_number;
    if (checkout.status !== 200 || done.status !== 'COMPLETED' || typeof number !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(number)) {
      throw new Error(`supplier agent checkout failed (${checkout.status})`);
    }
    current = await ctx.repo.record(payment.id, {
      event: { kind: 'supplier_ordered', amountMinor: lines.reduce((acc, l) => acc + l.qty * l.unitCostMinor, 0), actor: 'system', reason: `Order ${number} placed with ${name}'s ordering agent (simulated)`, detail: { cart_id: cart.id, merchant_order_number: number }, correlationId: ctx.correlationId }
    });
    return { payment: current, note };
  }
}
