// Postgres PaymentsRepository (migration 019). Runs on the tenant-scoped
// client from runTenantScopedTransaction, so RLS confines every statement to
// the current shop; `record` locks the payment row, applies the state machine
// and appends the event in the same transaction. All SQL is parameterised.
import type { EnvelopeEncrypted, PgClientLike } from '../../../../packages/common/dist/index.js';
import type { PolicyDraftLine, PolicyReason, SpendPolicy } from '../policy/policy-engine.js';
import type { PriceObservation } from '../policy/anomaly.js';
import { applyAction } from './state-machine.js';
import type { LedgerAction, PaymentStatus } from './state-machine.js';
import { LedgerConflictError } from './memory-ledger.js';
import type {
  ApprovedBy, DeliveryOutcome, DeliveryRecord, NewPayment, ReceivedLine, NewPaymentEvent, PaymentDecision, PaymentEventRecord, PaymentMethodStatus, PaymentPatch,
  PaymentRecord, PaymentsRepository, StoredPaymentMethod, SupplierPayee, EventActor, EventKind
} from './types.js';

type Queryable = Pick<PgClientLike, 'query'>;
type Row = Record<string, unknown>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : str(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const buf = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(str(v)));

const PAYMENT_COLUMNS = `id, draft_id, supplier_code, currency, status, decision, decision_reasons, lines_fingerprint, lines, created_by,
  approved_by, amount_requested_minor, amount_authorized_minor, amount_captured_minor, amount_voided_minor,
  amount_refunded_minor, amount_settled_minor, paypal_order_id, paypal_authorization_id, paypal_capture_ids,
  authorization_expires_at, honor_period_ends_at, approval_token_hash, approval_expires_at, correlation_id,
  created_at, updated_at`;

function toPayment(r: Row): PaymentRecord {
  return {
    id: str(r.id),
    draftId: strOrNull(r.draft_id),
    supplierCode: str(r.supplier_code),
    currency: str(r.currency),
    status: str(r.status) as PaymentStatus,
    decision: str(r.decision) as PaymentDecision,
    decisionReasons: (Array.isArray(r.decision_reasons) ? r.decision_reasons : []) as PolicyReason[],
    linesFingerprint: str(r.lines_fingerprint),
    lines: (Array.isArray(r.lines) ? r.lines : []) as PolicyDraftLine[],
    createdBy: str(r.created_by) as 'agent' | 'owner',
    approvedBy: strOrNull(r.approved_by) as ApprovedBy | null,
    requestedMinor: num(r.amount_requested_minor),
    authorizedMinor: num(r.amount_authorized_minor),
    capturedMinor: num(r.amount_captured_minor),
    voidedMinor: num(r.amount_voided_minor),
    refundedMinor: num(r.amount_refunded_minor),
    settledMinor: num(r.amount_settled_minor),
    paypalOrderId: strOrNull(r.paypal_order_id),
    paypalAuthorizationId: strOrNull(r.paypal_authorization_id),
    paypalCaptureIds: Array.isArray(r.paypal_capture_ids) ? r.paypal_capture_ids.map(str) : [],
    authorizationExpiresAt: isoOrNull(r.authorization_expires_at),
    honorPeriodEndsAt: isoOrNull(r.honor_period_ends_at),
    approvalTokenHash: strOrNull(r.approval_token_hash),
    approvalExpiresAt: isoOrNull(r.approval_expires_at),
    correlationId: str(r.correlation_id),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at)
  };
}

function toMethod(r: Row): StoredPaymentMethod {
  return {
    id: str(r.id),
    status: str(r.status) as PaymentMethodStatus,
    sealed: { encryptedDek: buf(r.encrypted_dek), dekNonce: buf(r.dek_nonce), encryptedValue: buf(r.encrypted_value), valueNonce: buf(r.value_nonce) },
    payerLabel: str(r.payer_label),
    createdAt: iso(r.created_at)
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: string; constraint?: string; message?: string };
  return e?.code === '23505' && (e.constraint === constraint || (e.message ?? '').includes(constraint));
}

export class PgPaymentsRepository implements PaymentsRepository {
  constructor(private readonly client: Queryable) {}

  async getPolicy(): Promise<SpendPolicy | null> {
    const { rows } = await this.client.query(
      `SELECT currency, per_order_autopay_max_minor, daily_max_minor, weekly_max_minor, daily_hard_cap_minor, weekly_hard_cap_minor,
              allow_listed_supplier_codes, price_jump_pct, substitution_tolerance_pct, quantity_spike_multiplier, require_delivery_check
         FROM spend_policies WHERE tenant_id = _rls_tenant_id()`
    );
    const r = rows[0];
    if (!r) return null;
    return {
      currency: str(r.currency),
      perOrderAutopayMaxMinor: num(r.per_order_autopay_max_minor),
      dailyMaxMinor: num(r.daily_max_minor),
      weeklyMaxMinor: num(r.weekly_max_minor),
      dailyHardCapMinor: r.daily_hard_cap_minor === null ? null : num(r.daily_hard_cap_minor),
      weeklyHardCapMinor: r.weekly_hard_cap_minor === null ? null : num(r.weekly_hard_cap_minor),
      allowListedSupplierIds: Array.isArray(r.allow_listed_supplier_codes) ? r.allow_listed_supplier_codes.map(str) : [],
      priceJumpPct: num(r.price_jump_pct),
      substitutionTolerancePct: num(r.substitution_tolerance_pct),
      quantitySpikeMultiplier: num(r.quantity_spike_multiplier),
      requireDeliveryCheck: r.require_delivery_check === true
    };
  }

  async savePolicy(p: SpendPolicy, updatedBy: 'owner' | 'seed'): Promise<void> {
    await this.client.query(
      `INSERT INTO spend_policies (tenant_id, currency, per_order_autopay_max_minor, daily_max_minor, weekly_max_minor,
              daily_hard_cap_minor, weekly_hard_cap_minor, allow_listed_supplier_codes, price_jump_pct,
              substitution_tolerance_pct, quantity_spike_multiplier, require_delivery_check, updated_by, updated_at)
       VALUES (_rls_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         currency = EXCLUDED.currency, per_order_autopay_max_minor = EXCLUDED.per_order_autopay_max_minor,
         daily_max_minor = EXCLUDED.daily_max_minor, weekly_max_minor = EXCLUDED.weekly_max_minor,
         daily_hard_cap_minor = EXCLUDED.daily_hard_cap_minor, weekly_hard_cap_minor = EXCLUDED.weekly_hard_cap_minor,
         allow_listed_supplier_codes = EXCLUDED.allow_listed_supplier_codes, price_jump_pct = EXCLUDED.price_jump_pct,
         substitution_tolerance_pct = EXCLUDED.substitution_tolerance_pct, quantity_spike_multiplier = EXCLUDED.quantity_spike_multiplier,
         require_delivery_check = EXCLUDED.require_delivery_check, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [p.currency, p.perOrderAutopayMaxMinor, p.dailyMaxMinor, p.weeklyMaxMinor, p.dailyHardCapMinor, p.weeklyHardCapMinor,
        [...p.allowListedSupplierIds], p.priceJumpPct, p.substitutionTolerancePct, p.quantitySpikeMultiplier, p.requireDeliveryCheck, updatedBy]
    );
  }

  async listPayees(): Promise<SupplierPayee[]> {
    const { rows } = await this.client.query(
      `SELECT supplier_code, paypal_email, paypal_merchant_id, currency, verified
         FROM supplier_payees WHERE tenant_id = _rls_tenant_id() ORDER BY supplier_code`
    );
    return rows.map((r) => ({ supplierCode: str(r.supplier_code), paypalEmail: strOrNull(r.paypal_email), paypalMerchantId: strOrNull(r.paypal_merchant_id), currency: str(r.currency), verified: r.verified === true }));
  }

  async getPayee(supplierCode: string): Promise<SupplierPayee | null> {
    return (await this.listPayees()).find((p) => p.supplierCode === supplierCode) ?? null;
  }

  async upsertPayee(p: SupplierPayee): Promise<void> {
    await this.client.query(
      `INSERT INTO supplier_payees (tenant_id, supplier_code, paypal_email, paypal_merchant_id, currency, verified, verified_at)
       VALUES (_rls_tenant_id(), $1, $2, $3, $4, $5, CASE WHEN $5 THEN now() END)
       ON CONFLICT (tenant_id, supplier_code) DO UPDATE SET
         paypal_email = EXCLUDED.paypal_email, paypal_merchant_id = EXCLUDED.paypal_merchant_id, currency = EXCLUDED.currency,
         verified = EXCLUDED.verified, verified_at = EXCLUDED.verified_at, updated_at = now()`,
      [p.supplierCode, p.paypalEmail, p.paypalMerchantId, p.currency, p.verified]
    );
  }

  async getActivePaymentMethod(): Promise<StoredPaymentMethod | null> {
    const { rows } = await this.client.query(
      `SELECT id, status, encrypted_dek, dek_nonce, encrypted_value, value_nonce, payer_label, created_at
         FROM payment_methods WHERE tenant_id = _rls_tenant_id() AND status = 'active'`
    );
    return rows[0] ? toMethod(rows[0]) : null;
  }

  async getPaymentMethod(id: string): Promise<StoredPaymentMethod | null> {
    const { rows } = await this.client.query(
      `SELECT id, status, encrypted_dek, dek_nonce, encrypted_value, value_nonce, payer_label, created_at
         FROM payment_methods WHERE tenant_id = _rls_tenant_id() AND id = $1`,
      [id]
    );
    return rows[0] ? toMethod(rows[0]) : null;
  }

  async createPaymentMethod(sealed: EnvelopeEncrypted, payerLabel: string): Promise<StoredPaymentMethod> {
    const { rows } = await this.client.query(
      `INSERT INTO payment_methods (tenant_id, status, encrypted_dek, dek_nonce, encrypted_value, value_nonce, payer_label)
       VALUES (_rls_tenant_id(), 'pending', $1, $2, $3, $4, $5)
       RETURNING id, status, encrypted_dek, dek_nonce, encrypted_value, value_nonce, payer_label, created_at`,
      [sealed.encryptedDek, sealed.dekNonce, sealed.encryptedValue, sealed.valueNonce, payerLabel]
    );
    return toMethod(rows[0] as Row);
  }

  async updatePaymentMethod(id: string, status: PaymentMethodStatus, sealed: EnvelopeEncrypted | null, payerLabel: string | null): Promise<void> {
    try {
      const { rows } = await this.client.query(
        `UPDATE payment_methods SET
           status = $2,
           encrypted_dek = COALESCE($3, encrypted_dek), dek_nonce = COALESCE($4, dek_nonce),
           encrypted_value = COALESCE($5, encrypted_value), value_nonce = COALESCE($6, value_nonce),
           payer_label = COALESCE($7, payer_label),
           activated_at = CASE WHEN $2 = 'active' THEN now() ELSE activated_at END,
           revoked_at = CASE WHEN $2 = 'revoked' THEN now() ELSE revoked_at END
         WHERE tenant_id = _rls_tenant_id() AND id = $1
         RETURNING id`,
        [id, status, sealed?.encryptedDek ?? null, sealed?.dekNonce ?? null, sealed?.encryptedValue ?? null, sealed?.valueNonce ?? null, payerLabel]
      );
      if (rows.length === 0) throw new LedgerConflictError('not_found', 'payment method not found');
    } catch (error) {
      if (isUniqueViolation(error, 'uq_payment_methods_one_active')) throw new LedgerConflictError('one_active_method', 'another PayPal account is already active');
      throw error;
    }
  }

  async priceHistory(supplierCode: string, skus: readonly string[], sinceDate: string): Promise<Record<string, PriceObservation[]>> {
    const { rows } = await this.client.query(
      `SELECT sku, unit_cost_minor, to_char(observed_on, 'YYYY-MM-DD') AS observed_on
         FROM supplier_price_history
        WHERE tenant_id = _rls_tenant_id() AND supplier_code = $1 AND sku = ANY($2::text[]) AND observed_on >= $3::date
        ORDER BY observed_on`,
      [supplierCode, [...skus], sinceDate]
    );
    const out: Record<string, PriceObservation[]> = {};
    for (const r of rows) (out[str(r.sku)] ??= []).push({ unitCostMinor: num(r.unit_cost_minor), at: `${str(r.observed_on)}T12:00:00Z` });
    return out;
  }

  async recordPrice(supplierCode: string, sku: string, unitCostMinor: number, currency: string, observedOn: string): Promise<void> {
    await this.client.query(
      `INSERT INTO supplier_price_history (tenant_id, supplier_code, sku, unit_cost_minor, currency, observed_on)
       VALUES (_rls_tenant_id(), $1, $2, $3, $4, $5::date)
       ON CONFLICT (tenant_id, supplier_code, sku, observed_on) DO UPDATE SET unit_cost_minor = EXCLUDED.unit_cost_minor, currency = EXCLUDED.currency`,
      [supplierCode, sku, unitCostMinor, currency, observedOn]
    );
  }

  async pastQuantities(skus: readonly string[]): Promise<Record<string, number[]>> {
    const { rows } = await this.client.query(
      `SELECT line->>'sku' AS sku, (line->>'qty')::numeric AS qty
         FROM purchase_order_drafts d, jsonb_array_elements(d.lines) AS line
        WHERE d.tenant_id = _rls_tenant_id() AND d.status IN ('confirmed', 'sent') AND line->>'sku' = ANY($1::text[])
        ORDER BY d.created_at DESC
        LIMIT 500`,
      [[...skus]]
    );
    const out: Record<string, number[]> = {};
    for (const r of rows) (out[str(r.sku)] ??= []).push(num(r.qty));
    return out;
  }

  private async insertEvent(payment: PaymentRecord, e: NewPaymentEvent): Promise<void> {
    try {
      await this.client.query(
        `INSERT INTO payment_events (tenant_id, payment_id, kind, amount_minor, currency, actor, reason, detail,
                paypal_request_id, paypal_resource_id, paypal_debug_id, correlation_id, created_at)
         VALUES (_rls_tenant_id(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, clock_timestamp())`,
        [payment.id, e.kind, e.amountMinor, payment.currency, e.actor, e.reason.slice(0, 500), JSON.stringify(e.detail ?? {}),
          e.paypalRequestId ?? null, e.paypalResourceId ?? null, e.paypalDebugId ?? null, e.correlationId]
      );
    } catch (error) {
      if (isUniqueViolation(error, 'uq_payment_events_request')) throw new LedgerConflictError('duplicate_request_id', `PayPal-Request-Id ${e.paypalRequestId ?? ''} already recorded`);
      throw error;
    }
  }

  async createPayment(input: NewPayment, event: NewPaymentEvent): Promise<PaymentRecord> {
    let rows: Row[];
    try {
      ({ rows } = await this.client.query(
        `INSERT INTO supplier_payments (tenant_id, draft_id, supplier_code, currency, amount_requested_minor, status, decision,
                decision_reasons, lines_fingerprint, lines, created_by, correlation_id)
         VALUES (_rls_tenant_id(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11)
         RETURNING ${PAYMENT_COLUMNS}`,
        [input.draftId, input.supplierCode, input.currency, input.requestedMinor, input.status, input.decision,
          JSON.stringify(input.decisionReasons), input.linesFingerprint, JSON.stringify(input.lines), input.createdBy, input.correlationId]
      ));
    } catch (error) {
      if (isUniqueViolation(error, 'uq_supplier_payments_live_draft')) throw new LedgerConflictError('draft_already_paid', 'this draft already has a payment');
      throw error;
    }
    const payment = toPayment(rows[0] as Row);
    await this.insertEvent(payment, event);
    return payment;
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    const { rows } = await this.client.query(`SELECT ${PAYMENT_COLUMNS} FROM supplier_payments WHERE tenant_id = _rls_tenant_id() AND id = $1`, [id]);
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async listPayments(opts: { readonly sinceIso?: string; readonly limit?: number } = {}): Promise<PaymentRecord[]> {
    const { rows } = await this.client.query(
      `SELECT ${PAYMENT_COLUMNS} FROM supplier_payments
        WHERE tenant_id = _rls_tenant_id() AND ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [opts.sinceIso ?? null, Math.min(Math.max(opts.limit ?? 500, 1), 1000)]
    );
    return rows.map(toPayment);
  }

  async findPaymentByApprovalHash(tokenHash: string): Promise<PaymentRecord | null> {
    const { rows } = await this.client.query(`SELECT ${PAYMENT_COLUMNS} FROM supplier_payments WHERE tenant_id = _rls_tenant_id() AND approval_token_hash = $1`, [tokenHash]);
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findPaymentByDraftId(draftId: string): Promise<PaymentRecord | null> {
    const { rows } = await this.client.query(`SELECT ${PAYMENT_COLUMNS} FROM supplier_payments WHERE tenant_id = _rls_tenant_id() AND draft_id = $1 AND status <> 'failed'`, [draftId]);
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async findPaymentByAuthorizationId(authorizationId: string): Promise<PaymentRecord | null> {
    const { rows } = await this.client.query(`SELECT ${PAYMENT_COLUMNS} FROM supplier_payments WHERE tenant_id = _rls_tenant_id() AND paypal_authorization_id = $1`, [authorizationId]);
    return rows[0] ? toPayment(rows[0]) : null;
  }

  async record(id: string, change: { readonly action?: LedgerAction; readonly patch?: PaymentPatch; readonly event: NewPaymentEvent }): Promise<PaymentRecord> {
    const locked = await this.client.query(`SELECT ${PAYMENT_COLUMNS} FROM supplier_payments WHERE tenant_id = _rls_tenant_id() AND id = $1 FOR UPDATE`, [id]);
    if (!locked.rows[0]) throw new LedgerConflictError('not_found', 'payment not found');
    const current = toPayment(locked.rows[0]);
    const money = change.action ? applyAction(current, change.action) : current;
    const p = change.patch ?? {};
    const { rows } = await this.client.query(
      `UPDATE supplier_payments SET
         status = $2, amount_authorized_minor = $3, amount_captured_minor = $4, amount_voided_minor = $5,
         amount_refunded_minor = $6, amount_settled_minor = $7,
         approved_by = COALESCE($8, approved_by),
         paypal_order_id = COALESCE($9, paypal_order_id),
         paypal_authorization_id = COALESCE($10, paypal_authorization_id),
         paypal_capture_ids = CASE WHEN $11::text IS NULL THEN paypal_capture_ids ELSE array_append(paypal_capture_ids, $11::text) END,
         authorization_expires_at = COALESCE($12::timestamptz, authorization_expires_at),
         honor_period_ends_at = COALESCE($13::timestamptz, honor_period_ends_at),
         approval_token_hash = CASE WHEN $14 THEN $15 ELSE approval_token_hash END,
         approval_expires_at = CASE WHEN $16 THEN $17::timestamptz ELSE approval_expires_at END,
         updated_at = now()
       WHERE tenant_id = _rls_tenant_id() AND id = $1
       RETURNING ${PAYMENT_COLUMNS}`,
      [id, money.status, money.authorizedMinor, money.capturedMinor, money.voidedMinor, money.refundedMinor, money.settledMinor,
        p.approvedBy ?? null, p.paypalOrderId ?? null, p.paypalAuthorizationId ?? null, p.addCaptureId ?? null,
        p.authorizationExpiresAt ?? null, p.honorPeriodEndsAt ?? null,
        p.approvalTokenHash !== undefined, p.approvalTokenHash ?? null, p.approvalExpiresAt !== undefined, p.approvalExpiresAt ?? null]
    );
    const next = toPayment(rows[0] as Row);
    await this.insertEvent(next, change.event);
    return next;
  }

  async listEvents(paymentId: string): Promise<PaymentEventRecord[]> {
    const { rows } = await this.client.query(
      `SELECT id, payment_id, kind, amount_minor, currency, actor, reason, detail, paypal_request_id, paypal_resource_id,
              paypal_debug_id, correlation_id, created_at
         FROM payment_events WHERE tenant_id = _rls_tenant_id() AND payment_id = $1 ORDER BY created_at, id`,
      [paymentId]
    );
    return rows.map((r) => ({
      id: str(r.id),
      paymentId: str(r.payment_id),
      kind: str(r.kind) as EventKind,
      amountMinor: num(r.amount_minor),
      currency: str(r.currency),
      actor: str(r.actor) as EventActor,
      reason: str(r.reason),
      detail: (r.detail && typeof r.detail === 'object' ? r.detail : {}) as Record<string, unknown>,
      ...(r.paypal_request_id ? { paypalRequestId: str(r.paypal_request_id) } : {}),
      ...(r.paypal_resource_id ? { paypalResourceId: str(r.paypal_resource_id) } : {}),
      ...(r.paypal_debug_id ? { paypalDebugId: str(r.paypal_debug_id) } : {}),
      correlationId: str(r.correlation_id),
      createdAt: iso(r.created_at)
    }));
  }

  async recordDelivery(d: Omit<DeliveryRecord, 'id' | 'createdAt'>): Promise<DeliveryRecord> {
    const { rows } = await this.client.query(
      `INSERT INTO deliveries (tenant_id, payment_id, source, received_lines, outcome, delivered_value_minor, currency)
       VALUES (_rls_tenant_id(), $1, $2, $3::jsonb, $4, $5, $6)
       RETURNING id, payment_id, source, received_lines, outcome, delivered_value_minor, currency, created_at`,
      [d.paymentId, d.source, JSON.stringify(d.receivedLines), d.outcome, d.deliveredValueMinor, d.currency]
    );
    return toDelivery(rows[0] as Row);
  }

  async listDeliveries(paymentId: string): Promise<DeliveryRecord[]> {
    const { rows } = await this.client.query(
      `SELECT id, payment_id, source, received_lines, outcome, delivered_value_minor, currency, created_at
         FROM deliveries WHERE tenant_id = _rls_tenant_id() AND payment_id = $1 ORDER BY created_at, id`,
      [paymentId]
    );
    return rows.map(toDelivery);
  }
}

function toDelivery(r: Row): DeliveryRecord {
  return {
    id: str(r.id),
    paymentId: str(r.payment_id),
    source: str(r.source) as DeliveryRecord['source'],
    receivedLines: (Array.isArray(r.received_lines) ? r.received_lines : []) as ReceivedLine[],
    outcome: str(r.outcome) as DeliveryOutcome,
    deliveredValueMinor: num(r.delivered_value_minor),
    currency: str(r.currency),
    createdAt: iso(r.created_at)
  };
}
