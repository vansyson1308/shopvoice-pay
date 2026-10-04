// PaymentsService: the only code that moves money. Tools call it with data
// the server loaded itself; the LLM can only reach it through a reorder draft
// and its confirmation token. Every decision goes through the policy engine,
// every money change through the ledger state machine, and every PayPal POST
// carries a PayPal-Request-Id derived from the payment, so re-running an
// operation after a crash replays the same key instead of paying twice.
//
// Settlement model (DECISIONS.md D1, sandbox-confirmed): orders are paid to
// the platform account; suppliers are paid out for what was captured.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decryptPayload, encryptPayload } from '../../../../packages/common/dist/index.js';
import { evaluatePolicy, periodStarts } from '../policy/policy-engine.js';
import type { PolicyDraft, PolicyResult, SpendHistoryEntry, SpendPolicy } from '../policy/policy-engine.js';
import { linesFingerprint } from '../policy/anomaly.js';
import { committedMinor, heldMinor, chargedMinor, LedgerError } from '../ledger/state-machine.js';
import type { PaymentRecord, PaymentsRepository, ReceivedLine, DeliveryOutcome, NewPaymentEvent, ApprovedBy, PaymentEventRecord, PaymentPatch } from '../ledger/types.js';
import { LedgerConflictError } from '../ledger/memory-ledger.js';
import type { PayPalClient } from './paypal-client.js';
import { PayPalApiError, PayPalTransportError } from './paypal-client.js';
import { createOrder, getOrder, authorizeOrder, firstAuthorization, captureAuthorization, voidAuthorization, reauthorize, getAuthorization } from './orders.js';
import { refundCapture } from './refunds.js';
import { createSetupToken, createPaymentToken } from './vault.js';
import { createPayout } from './payouts.js';
import { findLink } from './types.js';
import type { PayPalOrder } from './types.js';
import { speakMoney } from './money.js';

const DAY_MS = 86_400_000;
export const HONOR_PERIOD_MS = 3 * DAY_MS;

export interface PaymentsServiceConfig {
  readonly brandName: string;
  /** Where PayPal sends the owner back after approving (the console). */
  readonly returnBaseUrl: string;
  readonly mekB64: string;
  readonly approvalTtlSeconds: number;
  readonly timeZone: string;
}

export interface ServiceContext {
  readonly repo: PaymentsRepository;
  readonly correlationId: string;
  readonly supplierName: (code: string) => string;
}

interface SealedMethod {
  readonly setupTokenId?: string;
  readonly vaultId?: string;
  readonly customerId?: string;
}

/** What tools may show the model: no PayPal ids, vault ids or tokens. */
export interface PublicPayment {
  readonly paymentId: string;
  readonly supplierCode: string;
  readonly status: PaymentRecord['status'];
  readonly decision: PaymentRecord['decision'];
  readonly currency: string;
  readonly requestedMinor: number;
  readonly heldMinor: number;
  readonly chargedMinor: number;
  readonly releasedMinor: number;
  readonly refundedMinor: number;
  readonly reasons: readonly string[];
  readonly approvedBy: PaymentRecord['approvedBy'];
  /** PayPal honors the hold in full for 3 days; after that we reauthorize at capture time (never earlier). */
  readonly honorPeriodEndsAt: string | null;
  /** The hold itself lapses 29 days after it was placed. */
  readonly holdExpiresAt: string | null;
  readonly createdAt: string;
}

/** A ledger event as tools may show it: no PayPal ids or request ids. */
export interface PublicPaymentEvent {
  readonly kind: PaymentEventRecord['kind'];
  readonly amountMinor: number;
  readonly actor: PaymentEventRecord['actor'];
  readonly reason: string;
  readonly at: string;
}

export interface SpendSummary {
  readonly policy: SpendPolicy;
  readonly configured: boolean;
  readonly todayCommittedMinor: number;
  readonly weekCommittedMinor: number;
  readonly heldMinor: number;
  readonly pendingApprovals: number;
  readonly paypalConnected: boolean;
  readonly payerLabel: string | null;
}

export interface PayResult {
  readonly payment: PublicPayment | null;
  readonly policy: Pick<PolicyResult, 'decision' | 'reasons' | 'summary'>;
  /** Step-up only. Goes to the owner's approval card, never to the model. */
  readonly approval: { readonly token: string; readonly expiresAt: string } | null;
  readonly speech: string;
}

export class PaymentFlowError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function toPublicPayment(p: PaymentRecord): PublicPayment {
  return {
    paymentId: p.id,
    supplierCode: p.supplierCode,
    status: p.status,
    decision: p.decision,
    currency: p.currency,
    requestedMinor: p.requestedMinor,
    heldMinor: heldMinor(p),
    chargedMinor: chargedMinor(p),
    releasedMinor: p.voidedMinor,
    refundedMinor: p.refundedMinor,
    reasons: p.decisionReasons.map((r) => r.text),
    approvedBy: p.approvedBy,
    honorPeriodEndsAt: p.honorPeriodEndsAt,
    holdExpiresAt: p.authorizationExpiresAt,
    createdAt: p.createdAt
  };
}

export function toPublicEvent(e: PaymentEventRecord): PublicPaymentEvent {
  return { kind: e.kind, amountMinor: e.amountMinor, actor: e.actor, reason: e.reason, at: e.createdAt };
}

/** "maria.lopez@personal.example.com" -> "m***z@personal.example.com". */
export function maskEmail(email: string | undefined): string {
  if (!email || !email.includes('@')) return 'PayPal account';
  const [user, domain] = email.split('@') as [string, string];
  return `${user.slice(0, 1)}***${user.length > 2 ? user.slice(-1) : ''}@${domain}`;
}

function money(amountMinor: number, currency: string): string {
  return speakMoney({ amountMinor, currency });
}

export class PaymentsService {
  constructor(private readonly paypal: PayPalClient, private readonly config: PaymentsServiceConfig, private readonly now: () => number = Date.now) {}

  // ---------- Connect PayPal (vault, save without purchase) ----------

  /** Starts "Connect PayPal". Returns the PayPal approval URL for the owner (console only). */
  async startConnect(ctx: ServiceContext): Promise<{ methodId: string; approveUrl: string }> {
    const methodPlaceholder = await ctx.repo.createPaymentMethod(this.seal({}), '');
    const setup = await createSetupToken(this.paypal, {
      returnUrl: `${this.config.returnBaseUrl}/paypal/connected?method=${methodPlaceholder.id}`,
      cancelUrl: `${this.config.returnBaseUrl}/paypal/cancelled?method=${methodPlaceholder.id}`,
      brandName: this.config.brandName,
      description: `${this.config.brandName}: supplier payments within your rules`,
      requestId: `svp-setup-${methodPlaceholder.id}`,
      correlationId: ctx.correlationId
    });
    const approveUrl = findLink(setup.links, 'approve');
    if (!approveUrl) throw new PaymentFlowError('paypal_no_approve_link', 'PayPal did not return an approval link');
    await ctx.repo.updatePaymentMethod(methodPlaceholder.id, 'pending', this.seal({ setupTokenId: setup.id }), null);
    return { methodId: methodPlaceholder.id, approveUrl };
  }

  /** Finishes "Connect PayPal" after the owner approved: exchanges the setup token for a vault id. */
  async completeConnect(ctx: ServiceContext, methodId: string): Promise<{ payerLabel: string }> {
    const method = await ctx.repo.getPaymentMethod(methodId);
    if (!method || method.status !== 'pending') throw new PaymentFlowError('no_pending_connect', 'No PayPal connection is waiting to be finished');
    const sealed = this.unseal(method.sealed);
    if (!sealed.setupTokenId) throw new PaymentFlowError('no_pending_connect', 'No PayPal connection is waiting to be finished');
    const token = await createPaymentToken(this.paypal, sealed.setupTokenId, `svp-vault-${methodId}`, ctx.correlationId);
    const payerLabel = maskEmail(token.payment_source?.paypal?.email_address);
    const previous = await ctx.repo.getActivePaymentMethod();
    if (previous) await ctx.repo.updatePaymentMethod(previous.id, 'revoked', null, null);
    await ctx.repo.updatePaymentMethod(methodId, 'active', this.seal({ vaultId: token.id, ...(token.customer?.id ? { customerId: token.customer.id } : {}) }), payerLabel);
    return { payerLabel };
  }

  // ---------- Pay for a reorder draft ----------

  async evaluate(ctx: ServiceContext, draft: PolicyDraft, excludePaymentId: string | null = null): Promise<PolicyResult> {
    const policy = await this.policy(ctx.repo, draft.currency);
    const now = this.now();
    const { dayStart, weekStart } = periodStarts(now, this.config.timeZone);
    const recent = await ctx.repo.listPayments({ sinceIso: new Date(Math.min(weekStart, now - DAY_MS)).toISOString(), limit: 1000 });
    const history: SpendHistoryEntry[] = recent
      .filter((p) => p.id !== excludePaymentId && p.status !== 'blocked')
      .map((p) => ({
        paymentId: p.id,
        draftId: p.draftId ?? p.id,
        supplierId: p.supplierCode,
        committedMinor: committedMinor(p),
        currency: p.currency,
        createdAt: p.createdAt,
        status: p.status === 'blocked' ? 'failed' : p.status,
        fingerprint: p.linesFingerprint
      }));
    const skus = draft.lines.map((l) => l.sku);
    const since = new Date(now - 30 * DAY_MS).toISOString().slice(0, 10);
    const [priceHistory, pastQuantities, payee, all] = await Promise.all([
      ctx.repo.priceHistory(draft.supplierId, skus, since),
      ctx.repo.pastQuantities(skus),
      ctx.repo.getPayee(draft.supplierId),
      ctx.repo.listPayments({ limit: 1000 })
    ]);
    const completedOrders = all.filter((p) => p.supplierCode === draft.supplierId && p.capturedMinor > 0).length;
    const method = await ctx.repo.getActivePaymentMethod();
    return evaluatePolicy({
      draft,
      history: { payments: history, priceHistory, pastQuantities },
      policy,
      payee: { hasPayee: !!payee && !!(payee.paypalEmail || payee.paypalMerchantId), verified: payee?.verified ?? false, completedOrders },
      paymentMethodConnected: !!method,
      now,
      dayStart,
      weekStart
    });
  }

  /**
   * Called by confirm_reorder after the draft's own confirmation token was
   * checked. Autopay authorizes from the vault now; step-up records a
   * pending approval; blocked records why and moves nothing.
   */
  async payForDraft(ctx: ServiceContext, draft: PolicyDraft, createdBy: 'agent' | 'owner'): Promise<PayResult> {
    const existing = isUuid(draft.id) ? await ctx.repo.findPaymentByDraftId(draft.id) : null;
    if (existing) return this.existingResult(ctx, existing);
    const policy = await this.evaluate(ctx, draft);
    const supplierName = draft.supplierName;
    if (draft.totalMinor <= 0 || draft.lines.length === 0) {
      return { payment: null, policy, approval: null, speech: policy.summary };
    }
    const base = {
      draftId: isUuid(draft.id) ? draft.id : null,
      supplierCode: draft.supplierId,
      currency: draft.currency,
      requestedMinor: draft.totalMinor,
      decision: policy.decision,
      decisionReasons: policy.reasons,
      linesFingerprint: linesFingerprint(draft.supplierId, draft.lines),
      lines: draft.lines,
      createdBy,
      correlationId: ctx.correlationId
    } as const;
    const evaluated: NewPaymentEvent = { kind: 'policy_evaluated', amountMinor: draft.totalMinor, actor: 'system', reason: policy.summary, detail: { decision: policy.decision, codes: policy.reasons.map((r) => r.code) }, correlationId: ctx.correlationId };

    if (policy.decision === 'blocked') {
      const payment = await ctx.repo.createPayment({ ...base, status: 'blocked' }, evaluated);
      return { payment: toPublicPayment(payment), policy, approval: null, speech: policy.summary };
    }
    let payment: PaymentRecord;
    try {
      payment = await ctx.repo.createPayment({ ...base, status: 'pending_approval' }, evaluated);
    } catch (error) {
      // A concurrent confirm of the same draft won the race: report its payment instead of paying twice.
      if (error instanceof LedgerConflictError && error.code === 'draft_already_paid' && base.draftId) {
        const winner = await ctx.repo.findPaymentByDraftId(base.draftId);
        if (winner) return this.existingResult(ctx, winner);
      }
      throw error;
    }
    if (policy.decision === 'step_up') {
      const approval = await this.requestApproval(ctx, payment);
      return { payment: toPublicPayment(await this.reload(ctx, payment.id)), policy, approval, speech: policy.summary };
    }
    const method = await this.activeVault(ctx.repo);
    if (!method) throw new PaymentFlowError('no_payment_method', 'PayPal is not connected');
    const authorized = await this.authorizeFromVault(ctx, payment, method.vaultId, 'agent');
    const speech = authorized.status === 'authorized'
      ? `${money(authorized.authorizedMinor, authorized.currency)} to ${supplierName} is held on your PayPal, not charged until delivery.`
      : `I couldn't place the hold with PayPal for ${supplierName}. Nothing was charged.`;
    return { payment: toPublicPayment(authorized), policy, approval: null, speech };
  }

  /** A draft that already has a payment: report it; a step-up still waiting gets a fresh approval token (the old one stops working). */
  private async existingResult(ctx: ServiceContext, payment: PaymentRecord): Promise<PayResult> {
    const policy = { decision: payment.decision, reasons: payment.decisionReasons, summary: payment.decisionReasons.map((r) => r.text).join(' ') };
    const waiting = payment.status === 'pending_approval' && payment.decision === 'step_up' && !payment.approvedBy && !payment.paypalOrderId;
    const approval = waiting ? await this.requestApproval(ctx, payment) : null;
    const fresh = waiting ? await this.reload(ctx, payment.id) : payment;
    return { payment: toPublicPayment(fresh), policy, approval, speech: `That order was already handled: ${describeStatus(fresh)}.` };
  }

  /**
   * Fallback approval for clients without an in-client form: a one-off PayPal
   * order the owner approves on PayPal's own page (phone QR or link). PayPal's
   * login is the owner's step-up; no ShopVoice token is involved. Once PayPal
   * reports the order approved, completeBuyerApproval places the hold.
   */
  async startPayPalApproval(ctx: ServiceContext, paymentId: string): Promise<{ approveUrl: string; payment: PublicPayment }> {
    const payment = await this.mustGet(ctx, paymentId);
    if (payment.status !== 'pending_approval' || payment.decision !== 'step_up' || payment.approvedBy) throw new PaymentFlowError('approval_not_found', 'That approval is not waiting anymore');
    if (!payment.approvalExpiresAt || Date.parse(payment.approvalExpiresAt) <= this.now()) throw new PaymentFlowError('approval_expired', 'That approval expired; ask me to reorder again');
    const name = ctx.supplierName(payment.supplierCode);
    const recheck = await this.evaluate(ctx, this.draftOf(payment, name), payment.id);
    if (recheck.decision === 'blocked') {
      await ctx.repo.record(payment.id, { action: { kind: 'decline' }, patch: { approvalTokenHash: null, approvalExpiresAt: null }, event: { kind: 'declined', amountMinor: payment.requestedMinor, actor: 'system', reason: recheck.summary, correlationId: ctx.correlationId } });
      throw new PaymentFlowError('blocked_on_recheck', recheck.summary);
    }
    const requestId = `svp-order-${payment.id}`;
    const order = await createOrder(this.paypal, {
      intent: 'AUTHORIZE',
      purchaseUnit: this.purchaseUnit(payment, name),
      paymentSource: { kind: 'paypal_approval', returnUrl: `${this.config.returnBaseUrl}/paypal/approved?payment=${payment.id}`, cancelUrl: `${this.config.returnBaseUrl}/paypal/cancelled?payment=${payment.id}`, brandName: this.config.brandName },
      requestId,
      correlationId: ctx.correlationId
    });
    const approveUrl = findLink(order.links, 'payer-action', 'approve');
    if (!approveUrl) throw new PaymentFlowError('paypal_no_approve_link', 'PayPal did not return an approval link');
    const updated = payment.paypalOrderId === order.id
      ? payment
      : await ctx.repo.record(payment.id, { patch: { paypalOrderId: order.id }, event: { kind: 'approval_requested', amountMinor: payment.requestedMinor, actor: 'system', reason: 'Waiting for the owner to approve in PayPal', paypalRequestId: requestId, correlationId: ctx.correlationId } });
    return { approveUrl, payment: toPublicPayment(updated) };
  }

  private async requestApproval(ctx: ServiceContext, payment: PaymentRecord): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(this.now() + this.config.approvalTtlSeconds * 1000).toISOString();
    await ctx.repo.record(payment.id, {
      patch: { approvalTokenHash: sha256Hex(token), approvalExpiresAt: expiresAt },
      event: { kind: 'approval_requested', amountMinor: payment.requestedMinor, actor: 'system', reason: payment.decisionReasons.filter((r) => r.effect === 'step_up').map((r) => r.text).join(' '), correlationId: ctx.correlationId }
    });
    return { token, expiresAt };
  }

  /**
   * The owner approved a step-up (voice "yes" matched server-side, a console
   * tap, or the PayPal page). The policy runs again: step-up reasons are now
   * acknowledged, but anything that blocks still blocks.
   */
  async approve(ctx: ServiceContext, approvalToken: string, by: ApprovedBy): Promise<{ payment: PublicPayment; payerActionUrl: string | null; speech: string }> {
    const payment = await ctx.repo.findPaymentByApprovalHash(sha256Hex(approvalToken));
    if (!payment || payment.status !== 'pending_approval') throw new PaymentFlowError('approval_not_found', 'That approval is not waiting anymore');
    if (!payment.approvalExpiresAt || Date.parse(payment.approvalExpiresAt) <= this.now()) throw new PaymentFlowError('approval_expired', 'That approval expired; ask me to reorder again');
    const name = ctx.supplierName(payment.supplierCode);
    const recheck = await this.evaluate(ctx, this.draftOf(payment, name), payment.id);
    if (recheck.decision === 'blocked') {
      await ctx.repo.record(payment.id, { action: { kind: 'decline' }, patch: { approvalTokenHash: null, approvalExpiresAt: null }, event: { kind: 'declined', amountMinor: payment.requestedMinor, actor: 'system', reason: recheck.summary, correlationId: ctx.correlationId } });
      throw new PaymentFlowError('blocked_on_recheck', recheck.summary);
    }
    const approved = await ctx.repo.record(payment.id, {
      patch: { approvalTokenHash: null, approvalExpiresAt: null, approvedBy: by },
      event: { kind: 'approved', amountMinor: payment.requestedMinor, actor: 'owner', reason: `Approved by ${by.replace('owner_', '')}`, correlationId: ctx.correlationId }
    });
    const method = await this.activeVault(ctx.repo);
    if (method) {
      const result = await this.authorizeFromVault(ctx, approved, method.vaultId, 'owner');
      const speech = result.status === 'authorized'
        ? `Approved. ${money(result.authorizedMinor, result.currency)} to ${name} is held, not charged until delivery.`
        : `PayPal didn't accept the hold for ${name}. Nothing was charged.`;
      return { payment: toPublicPayment(result), payerActionUrl: null, speech };
    }
    // No vaulted account yet: the owner approves this one order in PayPal (phone QR).
    const order = await createOrder(this.paypal, {
      intent: 'AUTHORIZE',
      purchaseUnit: this.purchaseUnit(approved, name),
      paymentSource: { kind: 'paypal_approval', returnUrl: `${this.config.returnBaseUrl}/paypal/approved?payment=${approved.id}`, cancelUrl: `${this.config.returnBaseUrl}/paypal/cancelled?payment=${approved.id}`, brandName: this.config.brandName },
      requestId: `svp-order-${approved.id}`,
      correlationId: ctx.correlationId
    });
    await ctx.repo.record(approved.id, { patch: { paypalOrderId: order.id }, event: { kind: 'approval_requested', amountMinor: approved.requestedMinor, actor: 'system', reason: 'Waiting for approval in PayPal', paypalRequestId: `svp-order-${approved.id}`, correlationId: ctx.correlationId } });
    return { payment: toPublicPayment(approved), payerActionUrl: findLink(order.links, 'payer-action', 'approve'), speech: `Approve ${money(approved.requestedMinor, approved.currency)} to ${name} in PayPal on your phone.` };
  }

  /** The owner declined a step-up. Nothing was held, so nothing moves. */
  async decline(ctx: ServiceContext, approvalToken: string): Promise<PublicPayment> {
    const payment = await ctx.repo.findPaymentByApprovalHash(sha256Hex(approvalToken));
    if (!payment || payment.status !== 'pending_approval') throw new PaymentFlowError('approval_not_found', 'That approval is not waiting anymore');
    const declined = await ctx.repo.record(payment.id, { action: { kind: 'decline' }, patch: { approvalTokenHash: null, approvalExpiresAt: null }, event: { kind: 'declined', amountMinor: payment.requestedMinor, actor: 'owner', reason: 'Declined by the owner', correlationId: ctx.correlationId } });
    return toPublicPayment(declined);
  }

  /** After a PayPal-page approval: authorize the order once PayPal says APPROVED. Safe to call repeatedly. */
  async completeBuyerApproval(ctx: ServiceContext, paymentId: string): Promise<PublicPayment> {
    const payment = await this.mustGet(ctx, paymentId);
    if (payment.status !== 'pending_approval' || !payment.paypalOrderId) return toPublicPayment(payment);
    const order = await getOrder(this.paypal, payment.paypalOrderId, ctx.correlationId);
    if (order.status !== 'APPROVED' && order.status !== 'COMPLETED') return toPublicPayment(payment);
    const requestId = `svp-authorize-${payment.id}`;
    if (order.status === 'APPROVED') {
      // Rules may have changed since the owner was asked: a block still blocks, even after PayPal approval.
      const recheck = await this.evaluate(ctx, this.draftOf(payment, ctx.supplierName(payment.supplierCode)), payment.id);
      if (recheck.decision === 'blocked') {
        const declined = await ctx.repo.record(payment.id, { action: { kind: 'decline' }, patch: { approvalTokenHash: null, approvalExpiresAt: null }, event: { kind: 'declined', amountMinor: payment.requestedMinor, actor: 'system', reason: recheck.summary, correlationId: ctx.correlationId } });
        return toPublicPayment(declined);
      }
    }
    const authorized = order.status === 'COMPLETED' ? order : await authorizeOrder(this.paypal, payment.paypalOrderId, requestId, ctx.correlationId);
    const approvedBy = payment.approvedBy ? {} : { approvedBy: 'owner_paypal' as const };
    return toPublicPayment(await this.recordAuthorization(ctx, payment, authorized, requestId, 'owner', { ...approvedBy, approvalTokenHash: null, approvalExpiresAt: null }));
  }

  private async authorizeFromVault(ctx: ServiceContext, payment: PaymentRecord, vaultId: string, actor: 'agent' | 'owner'): Promise<PaymentRecord> {
    const requestId = `svp-auth-${payment.id}`;
    try {
      const order = await createOrder(this.paypal, {
        intent: 'AUTHORIZE',
        purchaseUnit: this.purchaseUnit(payment, ctx.supplierName(payment.supplierCode)),
        paymentSource: { kind: 'vault', vaultId },
        requestId,
        correlationId: ctx.correlationId
      });
      return await this.recordAuthorization(ctx, payment, order, requestId, actor);
    } catch (error) {
      if (error instanceof PayPalTransportError) {
        // Outcome unknown: leave it pending. Retrying reuses requestId, so PayPal cannot hold twice.
        return payment;
      }
      if (error instanceof PayPalApiError) {
        return ctx.repo.record(payment.id, { action: { kind: 'fail' }, event: { kind: 'failed', amountMinor: payment.requestedMinor, actor: 'paypal', reason: `PayPal declined the hold (${error.code})`, paypalRequestId: requestId, ...(error.debugId ? { paypalDebugId: error.debugId } : {}), correlationId: ctx.correlationId } });
      }
      throw error;
    }
  }

  private async recordAuthorization(ctx: ServiceContext, payment: PaymentRecord, order: PayPalOrder, requestId: string, actor: 'agent' | 'owner', extra: PaymentPatch = {}): Promise<PaymentRecord> {
    const auth = firstAuthorization(order);
    if (!auth || auth.status !== 'CREATED') {
      return ctx.repo.record(payment.id, { action: { kind: 'fail' }, event: { kind: 'failed', amountMinor: payment.requestedMinor, actor: 'paypal', reason: `PayPal returned no usable hold (${auth?.status ?? order.status})`, paypalRequestId: requestId, correlationId: ctx.correlationId } });
    }
    const created = Date.parse(auth.create_time ?? '') || this.now();
    return ctx.repo.record(payment.id, {
      action: { kind: 'authorize', amountMinor: payment.requestedMinor },
      patch: {
        ...extra,
        paypalOrderId: order.id,
        paypalAuthorizationId: auth.id,
        ...(auth.expiration_time ? { authorizationExpiresAt: new Date(auth.expiration_time).toISOString() } : {}),
        honorPeriodEndsAt: new Date(created + HONOR_PERIOD_MS).toISOString()
      },
      event: { kind: 'authorized', amountMinor: payment.requestedMinor, actor, reason: 'Held on PayPal until delivery', paypalRequestId: requestId, paypalResourceId: auth.id, correlationId: ctx.correlationId }
    });
  }

  // ---------- Delivery: pay only for what arrived ----------

  /**
   * Captures the value of what was received and releases the rest. Anything
   * received beyond what was ordered, or priced above the order, is held for
   * the owner instead of captured (we never capture more than was approved).
   */
  async recordDelivery(ctx: ServiceContext, paymentId: string, received: readonly { readonly sku: string; readonly receivedQty: number }[], source: 'voice' | 'invoice_photo' | 'console'): Promise<{ payment: PublicPayment; outcome: DeliveryOutcome; deliveredMinor: number; speech: string }> {
    let payment = await this.mustGet(ctx, paymentId);
    if (payment.status !== 'authorized' && payment.status !== 'partially_captured') throw new PaymentFlowError('nothing_held', 'This order has no money on hold');
    if (!payment.paypalAuthorizationId) throw new PaymentFlowError('nothing_held', 'This order has no PayPal hold');
    const name = ctx.supplierName(payment.supplierCode);
    const lines: ReceivedLine[] = payment.lines.map((l) => {
      const got = received.find((r) => r.sku === l.sku);
      const qty = got ? Math.max(0, Math.floor(got.receivedQty)) : 0;
      return { sku: l.sku, orderedQty: l.qty, receivedQty: qty, unitCostMinor: l.unitCostMinor };
    });
    const unknown = received.filter((r) => !payment.lines.some((l) => l.sku === r.sku) && r.receivedQty > 0);
    const over = lines.some((l) => l.receivedQty > l.orderedQty) || unknown.length > 0;
    const deliveredMinor = lines.reduce((acc, l) => acc + Math.min(l.receivedQty, l.orderedQty) * l.unitCostMinor, 0);
    const held = heldMinor(payment);
    const value = Math.min(deliveredMinor, held);
    const outcome: DeliveryOutcome = over ? 'hold' : value === 0 ? 'none' : value === held ? 'full' : 'partial';
    // The delivery row is written after the money moves, so it never claims a charge that failed.
    const note = () => ctx.repo.recordDelivery({ paymentId, source, receivedLines: lines, outcome, deliveredValueMinor: deliveredMinor, currency: payment.currency });
    if (outcome === 'hold') {
      await note();
      return { payment: toPublicPayment(payment), outcome, deliveredMinor, speech: `${name} delivered more than you ordered. I'm holding the money until you check it.` };
    }
    payment = await this.ensureCapturable(ctx, payment);
    const authId = payment.paypalAuthorizationId as string;
    if (outcome === 'none') {
      const voided = await this.voidHold(ctx, payment, 'Nothing was delivered');
      await note();
      return { payment: toPublicPayment(voided), outcome, deliveredMinor, speech: `Nothing arrived from ${name}, so I released the ${money(held, payment.currency)} hold. You weren't charged.` };
    }
    const n = payment.paypalCaptureIds.length + 1;
    const captureId = `svp-cap-${payment.id}-${n}`;
    const capture = await captureAuthorization(this.paypal, authId, { amount: { amountMinor: value, currency: payment.currency }, finalCapture: outcome === 'full', invoiceId: `SVP-${payment.id.slice(0, 8)}-${n}`, requestId: captureId, correlationId: ctx.correlationId });
    payment = await ctx.repo.record(payment.id, {
      action: { kind: 'capture', amountMinor: value, final: outcome === 'full' },
      patch: { addCaptureId: capture.id },
      event: { kind: 'captured', amountMinor: value, actor: 'system', reason: outcome === 'full' ? 'Everything arrived' : `Charged for what arrived (${source})`, paypalRequestId: captureId, paypalResourceId: capture.id, correlationId: ctx.correlationId }
    });
    if (outcome === 'full') {
      await note();
      return { payment: toPublicPayment(payment), outcome, deliveredMinor, speech: `Everything from ${name} arrived. Charged ${money(value, payment.currency)}.` };
    }
    const released = heldMinor(payment);
    payment = await this.voidHold(ctx, payment, 'Released what did not arrive');
    await note();
    return { payment: toPublicPayment(payment), outcome, deliveredMinor, speech: `Charged ${money(value, payment.currency)} for what arrived from ${name} and released ${money(released, payment.currency)}.` };
  }

  private async voidHold(ctx: ServiceContext, payment: PaymentRecord, reason: string): Promise<PaymentRecord> {
    const requestId = `svp-void-${payment.id}`;
    const amount = heldMinor(payment);
    await voidAuthorization(this.paypal, payment.paypalAuthorizationId as string, requestId, ctx.correlationId);
    return ctx.repo.record(payment.id, { action: { kind: 'void' }, event: { kind: 'voided', amountMinor: amount, actor: 'system', reason, paypalRequestId: requestId, correlationId: ctx.correlationId } });
  }

  /** Past the 3-day honor period, get a fresh authorization before capturing (same 29-day end). */
  private async ensureCapturable(ctx: ServiceContext, payment: PaymentRecord): Promise<PaymentRecord> {
    if (!payment.honorPeriodEndsAt || Date.parse(payment.honorPeriodEndsAt) > this.now() || payment.capturedMinor > 0) return payment;
    const requestId = `svp-reauth-${payment.id}-${payment.paypalAuthorizationId}`;
    try {
      const fresh = await reauthorize(this.paypal, payment.paypalAuthorizationId as string, null, requestId, ctx.correlationId);
      return ctx.repo.record(payment.id, {
        patch: { paypalAuthorizationId: fresh.id, honorPeriodEndsAt: new Date(this.now() + HONOR_PERIOD_MS).toISOString() },
        event: { kind: 'reauthorized', amountMinor: heldMinor(payment), actor: 'system', reason: 'Renewed the hold after the 3-day honor period', paypalRequestId: requestId, paypalResourceId: fresh.id, correlationId: ctx.correlationId }
      });
    } catch (error) {
      // Capture is still allowed within 29 days; a failed reauthorization is noted, not fatal.
      if (error instanceof PayPalApiError) return payment;
      throw error;
    }
  }

  // ---------- Refunds and settlement ----------

  async refund(ctx: ServiceContext, paymentId: string, amountMinor: number | null, reason: string): Promise<{ payment: PublicPayment; refundedMinor: number; speech: string }> {
    const payment = await this.mustGet(ctx, paymentId);
    const captureId = payment.paypalCaptureIds[payment.paypalCaptureIds.length - 1];
    const refundable = chargedMinor(payment);
    if (!captureId || refundable <= 0) throw new PaymentFlowError('nothing_to_refund', 'Nothing was charged for this order');
    const amount = amountMinor ?? refundable;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > refundable) throw new PaymentFlowError('over_refund', `You can get back at most ${money(refundable, payment.currency)}`);
    const n = (await ctx.repo.listEvents(payment.id)).filter((e) => e.kind === 'refunded').length + 1;
    const requestId = `svp-refund-${payment.id}-${n}`;
    const refund = await refundCapture(this.paypal, captureId, { amount: { amountMinor: amount, currency: payment.currency }, noteToPayer: reason.slice(0, 200), requestId, correlationId: ctx.correlationId });
    const updated = await ctx.repo.record(payment.id, { action: { kind: 'refund', amountMinor: amount }, event: { kind: 'refunded', amountMinor: amount, actor: 'owner', reason: reason.slice(0, 200), paypalRequestId: requestId, paypalResourceId: refund.id, correlationId: ctx.correlationId } });
    return { payment: toPublicPayment(updated), refundedMinor: amount, speech: `Refund of ${money(amount, payment.currency)} from ${ctx.supplierName(payment.supplierCode)} is on its way back to your PayPal.` };
  }

  /** Pays the supplier (Payouts) for what the shop was charged and has not been paid out yet. */
  async settle(ctx: ServiceContext, paymentId: string): Promise<{ payment: PublicPayment; paidMinor: number }> {
    const payment = await this.mustGet(ctx, paymentId);
    const due = chargedMinor(payment) - payment.settledMinor;
    if (due <= 0 || heldMinor(payment) > 0) return { payment: toPublicPayment(payment), paidMinor: 0 };
    const payee = await ctx.repo.getPayee(payment.supplierCode);
    if (!payee?.verified || !payee.paypalEmail) throw new PaymentFlowError('no_payee', 'This supplier has no verified PayPal account');
    const n = (await ctx.repo.listEvents(payment.id)).filter((e) => e.kind === 'payout_sent').length + 1;
    const requestId = `svp-payout-${payment.id}-${n}`;
    const batch = await createPayout(this.paypal, {
      senderBatchId: requestId,
      emailSubject: `Payment from ${this.config.brandName}`,
      items: [{ receiverEmail: payee.paypalEmail, amount: { amountMinor: due, currency: payment.currency }, note: `Order SVP-${payment.id.slice(0, 8)}`, senderItemId: `${payment.id}-${n}` }],
      requestId,
      correlationId: ctx.correlationId
    });
    const updated = await ctx.repo.record(payment.id, { action: { kind: 'settle', amountMinor: due }, event: { kind: 'payout_sent', amountMinor: due, actor: 'system', reason: 'Paid the supplier for what was delivered', paypalRequestId: requestId, paypalResourceId: batch.batch_header.payout_batch_id, correlationId: ctx.correlationId } });
    return { payment: toPublicPayment(updated), paidMinor: due };
  }

  // ---------- Status sync (polling fallback; webhooks call the same path) ----------

  /** Reconciles the ledger with PayPal's view of the hold (expiry, an outside void). */
  async sync(ctx: ServiceContext, paymentId: string): Promise<PublicPayment> {
    let payment = await this.mustGet(ctx, paymentId);
    if (payment.status === 'pending_approval' && payment.paypalOrderId) return this.completeBuyerApproval(ctx, paymentId);
    // A vault hold whose outcome was unknown (network): retry with the same PayPal-Request-Id.
    const cleared = payment.decision === 'autopay' || payment.approvedBy !== null;
    if (payment.status === 'pending_approval' && cleared && !payment.approvalTokenHash) {
      const method = await this.activeVault(ctx.repo);
      if (method) return toPublicPayment(await this.authorizeFromVault(ctx, payment, method.vaultId, payment.approvedBy ? 'owner' : 'agent'));
    }
    if ((payment.status === 'authorized' || payment.status === 'partially_captured') && payment.paypalAuthorizationId && heldMinor(payment) > 0) {
      const auth = await getAuthorization(this.paypal, payment.paypalAuthorizationId, ctx.correlationId);
      if (auth.status === 'VOIDED' || auth.status === 'EXPIRED') {
        payment = await ctx.repo.record(payment.id, { action: { kind: 'void' }, event: { kind: 'voided', amountMinor: heldMinor(payment), actor: 'paypal', reason: auth.status === 'EXPIRED' ? 'The PayPal hold expired' : 'PayPal released the hold', paypalResourceId: auth.id, correlationId: ctx.correlationId } });
      }
    }
    return toPublicPayment(payment);
  }

  // ---------- Read views for tools (no PayPal ids) ----------

  async getPolicy(ctx: ServiceContext, currency: string): Promise<{ policy: SpendPolicy; configured: boolean }> {
    const stored = await ctx.repo.getPolicy();
    return { policy: stored ?? (await this.policy(ctx.repo, currency)), configured: !!stored };
  }

  async savePolicy(ctx: ServiceContext, policy: SpendPolicy): Promise<void> {
    await ctx.repo.savePolicy(policy, 'owner');
  }

  async spendSummary(ctx: ServiceContext, currency: string): Promise<SpendSummary> {
    const { policy, configured } = await this.getPolicy(ctx, currency);
    const now = this.now();
    const { dayStart, weekStart } = periodStarts(now, this.config.timeZone);
    const recent = await ctx.repo.listPayments({ sinceIso: new Date(Math.min(weekStart, dayStart)).toISOString(), limit: 1000 });
    const live = recent.filter((p) => p.status !== 'blocked' && p.status !== 'failed');
    const sum = (since: number) => live.filter((p) => Date.parse(p.createdAt) >= since).reduce((n, p) => n + committedMinor(p), 0);
    const all = await ctx.repo.listPayments({ limit: 1000 });
    const method = await ctx.repo.getActivePaymentMethod();
    return {
      policy,
      configured,
      todayCommittedMinor: sum(dayStart),
      weekCommittedMinor: sum(weekStart),
      heldMinor: all.reduce((n, p) => n + heldMinor(p), 0),
      pendingApprovals: all.filter((p) => p.status === 'pending_approval' && p.decision === 'step_up' && !p.approvedBy).length,
      paypalConnected: !!method,
      payerLabel: method?.payerLabel ?? null
    };
  }

  async listPublicPayments(ctx: ServiceContext, limit: number): Promise<PublicPayment[]> {
    return (await ctx.repo.listPayments({ limit })).map(toPublicPayment);
  }

  async explain(ctx: ServiceContext, paymentId: string): Promise<{ payment: PublicPayment; events: PublicPaymentEvent[] }> {
    const payment = await this.mustGet(ctx, paymentId);
    return { payment: toPublicPayment(payment), events: (await ctx.repo.listEvents(payment.id)).map(toPublicEvent) };
  }

  // ---------- Two-step confirmations (stateless) ----------

  /**
   * Signs a short-lived confirmation for a two-step tool (refunds). The
   * signature binds the purpose and every field, so a token for one payment
   * or amount cannot confirm another. Key derived from the master key.
   */
  signConfirmation(purpose: string, fields: readonly string[], ttlSeconds: number): string {
    const exp = Math.floor(this.now() / 1000) + ttlSeconds;
    return `${exp.toString(36)}.${this.confirmMac(purpose, fields, exp)}`;
  }

  verifyConfirmation(purpose: string, fields: readonly string[], signature: string): 'ok' | 'expired' | 'invalid' {
    const [expText = '', mac = ''] = signature.split('.');
    const exp = parseInt(expText, 36);
    if (!Number.isSafeInteger(exp) || !/^[A-Za-z0-9_-]{32}$/.test(mac)) return 'invalid';
    const expected = Buffer.from(this.confirmMac(purpose, fields, exp));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
    return exp * 1000 <= this.now() ? 'expired' : 'ok';
  }

  private confirmMac(purpose: string, fields: readonly string[], exp: number): string {
    const key = createHash('sha256').update('svp-confirm|').update(Buffer.from(this.config.mekB64, 'base64')).digest();
    return createHmac('sha256', key).update([purpose, ...fields, String(exp)].join('|')).digest('base64url').slice(0, 32);
  }

  // ---------- helpers ----------

  private async policy(repo: PaymentsRepository, currency: string): Promise<SpendPolicy> {
    const stored = await repo.getPolicy();
    if (stored) return stored;
    // No policy yet: nothing is allow-listed, so every order is blocked until the owner sets rules.
    return { currency, perOrderAutopayMaxMinor: 0, dailyMaxMinor: 0, weeklyMaxMinor: 0, dailyHardCapMinor: 0, weeklyHardCapMinor: 0, allowListedSupplierIds: [], priceJumpPct: 20, substitutionTolerancePct: 5, quantitySpikeMultiplier: 3, requireDeliveryCheck: true };
  }

  private draftOf(p: PaymentRecord, supplierName: string): PolicyDraft {
    return { id: p.draftId ?? p.id, supplierId: p.supplierCode, supplierName, lines: p.lines, totalMinor: p.requestedMinor, currency: p.currency };
  }

  private purchaseUnit(p: PaymentRecord, supplierName: string) {
    return {
      referenceId: p.id,
      description: `Supplier order: ${supplierName}`,
      invoiceId: `SVP-${p.id}`,
      customId: p.id,
      amount: { amountMinor: p.requestedMinor, currency: p.currency },
      items: p.lines.map((l) => ({ name: l.name, sku: l.sku, quantity: l.qty, unitAmount: { amountMinor: l.unitCostMinor, currency: p.currency } }))
    };
  }

  private async activeVault(repo: PaymentsRepository): Promise<{ vaultId: string } | null> {
    const method = await repo.getActivePaymentMethod();
    if (!method) return null;
    const sealed = this.unseal(method.sealed);
    return sealed.vaultId ? { vaultId: sealed.vaultId } : null;
  }

  private async mustGet(ctx: ServiceContext, id: string): Promise<PaymentRecord> {
    const payment = await ctx.repo.getPayment(id);
    if (!payment) throw new PaymentFlowError('payment_not_found', 'I could not find that payment');
    return payment;
  }

  private async reload(ctx: ServiceContext, id: string): Promise<PaymentRecord> {
    return this.mustGet(ctx, id);
  }

  private seal(value: SealedMethod) {
    return encryptPayload(JSON.stringify(value), this.config.mekB64);
  }

  private unseal(sealed: Parameters<typeof decryptPayload>[0]): SealedMethod {
    return JSON.parse(decryptPayload(sealed, this.config.mekB64)) as SealedMethod;
  }
}

/** "held $84", "charged $56", "waiting for your approval", ... for short spoken status lines. */
export function describeStatus(p: PaymentRecord | PublicPayment): string {
  const held = 'heldMinor' in p ? p.heldMinor : heldMinor(p);
  const charged = 'chargedMinor' in p ? p.chargedMinor : chargedMinor(p);
  switch (p.status) {
    case 'pending_approval': return p.decision === 'step_up' ? 'waiting for your approval' : 'being placed with PayPal';
    case 'authorized': return `${money(held, p.currency)} held, not charged yet`;
    case 'partially_captured': return held > 0 ? `${money(charged, p.currency)} charged, ${money(held, p.currency)} still held` : `${money(charged, p.currency)} charged`;
    case 'captured': return `${money(charged, p.currency)} charged`;
    case 'voided': return 'released, nothing charged';
    case 'refunded': return 'refunded';
    case 'failed': return 'not placed, PayPal declined it';
    case 'blocked': return 'blocked by your rules';
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export { LedgerError };
