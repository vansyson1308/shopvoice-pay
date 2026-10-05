// In-memory PaymentsRepository: unit tests, CI without Postgres, and the
// offline demo. Mirrors migration 019: one active payment method per shop, a
// PayPal-Request-Id recorded once, and every money change through the same
// state machine (which enforces the invariants the database CHECKs).
import { randomUUID } from 'node:crypto';
import type { EnvelopeEncrypted } from '../../../../packages/common/dist/index.js';
import type { SpendPolicy } from '../policy/policy-engine.js';
import type { PriceObservation } from '../policy/anomaly.js';
import { applyAction, newPaymentState } from './state-machine.js';
import type {
  DeliveryRecord,
  InvoiceMatchRecord, NewPayment, NewPaymentEvent, PaymentEventRecord, PaymentMethodStatus, PaymentPatch, PaymentRecord,
  PaymentsRepository, StoredPaymentMethod, SupplierPayee
} from './types.js';
import type { LedgerAction } from './state-machine.js';

export interface MemoryPriceRow {
  readonly supplierCode: string;
  readonly sku: string;
  readonly unitCostMinor: number;
  readonly currency: string;
  readonly observedOn: string;
}

/** A completed past order, seeded as ledger history (no PayPal transaction behind it). */
export interface MemorySeedPayment {
  readonly supplierCode: string;
  readonly lines: readonly { readonly sku: string; readonly name: string; readonly qty: number; readonly unitCostMinor: number }[];
  readonly amountMinor: number;
  readonly createdAt: string;
}

/** Optional per-tenant seed for the payments tables. */
export interface MemoryPaymentsSeed {
  readonly history?: readonly MemorySeedPayment[];
  readonly policy?: SpendPolicy;
  readonly payees?: readonly SupplierPayee[];
  readonly prices?: readonly MemoryPriceRow[];
  /** Past order quantities per SKU (the "usual" baseline). */
  readonly pastQuantities?: Readonly<Record<string, readonly number[]>>;
}

export class MemoryPaymentsData {
  policy: SpendPolicy | null;
  readonly payees = new Map<string, SupplierPayee>();
  readonly methods: StoredPaymentMethod[] = [];
  readonly prices: MemoryPriceRow[];
  readonly pastQuantities: Record<string, number[]>;
  readonly payments = new Map<string, PaymentRecord>();
  readonly events: PaymentEventRecord[] = [];
  readonly deliveries: DeliveryRecord[] = [];
  readonly invoiceMatches: InvoiceMatchRecord[] = [];

  constructor(seed: MemoryPaymentsSeed = {}) {
    this.policy = seed.policy ?? null;
    for (const payee of seed.payees ?? []) this.payees.set(payee.supplierCode, payee);
    this.prices = [...(seed.prices ?? [])];
    this.pastQuantities = Object.fromEntries(Object.entries(seed.pastQuantities ?? {}).map(([k, v]) => [k, [...v]]));
    (seed.history ?? []).forEach((h, i) => {
      const id = `seed-${String(i + 1).padStart(4, '0')}-${h.supplierCode.toLowerCase()}`;
      const text = 'Seeded order history (no PayPal transaction).';
      this.payments.set(id, {
        id,
        draftId: null,
        supplierCode: h.supplierCode,
        currency: 'USD',
        status: 'captured',
        decision: 'autopay',
        decisionReasons: [{ code: 'within_policy', effect: 'info', text }],
        linesFingerprint: `${h.supplierCode}|${h.lines.map((l) => `${l.sku}x${l.qty}`).join(',')}`,
        lines: h.lines.map((l) => ({ ...l })),
        createdBy: 'agent',
        approvedBy: null,
        requestedMinor: h.amountMinor,
        authorizedMinor: h.amountMinor,
        capturedMinor: h.amountMinor,
        voidedMinor: 0,
        refundedMinor: 0,
        settledMinor: h.amountMinor,
        paypalOrderId: null,
        paypalAuthorizationId: null,
        paypalCaptureIds: [],
        authorizationExpiresAt: null,
        honorPeriodEndsAt: null,
        approvalTokenHash: null,
        approvalExpiresAt: null,
        correlationId: 'seed',
        createdAt: h.createdAt,
        updatedAt: h.createdAt
      });
      this.events.push({ id: `${id}-e1`, paymentId: id, kind: 'captured', amountMinor: h.amountMinor, currency: 'USD', actor: 'system', reason: text, correlationId: 'seed', createdAt: h.createdAt });
    });
  }
}

export class LedgerConflictError extends Error {
  constructor(readonly code: 'duplicate_request_id' | 'one_active_method' | 'not_found' | 'draft_already_paid', message: string) {
    super(message);
  }
}

export class MemoryPaymentsRepository implements PaymentsRepository {
  constructor(private readonly data: MemoryPaymentsData, private readonly now: () => number) {}

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  async getPolicy(): Promise<SpendPolicy | null> {
    return this.data.policy ? { ...this.data.policy, allowListedSupplierIds: [...this.data.policy.allowListedSupplierIds] } : null;
  }

  async savePolicy(policy: SpendPolicy): Promise<void> {
    this.data.policy = { ...policy, allowListedSupplierIds: [...policy.allowListedSupplierIds] };
  }

  async listPayees(): Promise<SupplierPayee[]> {
    return [...this.data.payees.values()].sort((a, b) => a.supplierCode.localeCompare(b.supplierCode));
  }

  async getPayee(supplierCode: string): Promise<SupplierPayee | null> {
    return this.data.payees.get(supplierCode) ?? null;
  }

  async upsertPayee(payee: SupplierPayee): Promise<void> {
    this.data.payees.set(payee.supplierCode, payee);
  }

  async getActivePaymentMethod(): Promise<StoredPaymentMethod | null> {
    return this.data.methods.find((m) => m.status === 'active') ?? null;
  }

  async getPaymentMethod(id: string): Promise<StoredPaymentMethod | null> {
    return this.data.methods.find((m) => m.id === id) ?? null;
  }

  async createPaymentMethod(sealed: EnvelopeEncrypted, payerLabel: string): Promise<StoredPaymentMethod> {
    const method: StoredPaymentMethod = { id: randomUUID(), status: 'pending', sealed, payerLabel, createdAt: this.iso() };
    this.data.methods.push(method);
    return method;
  }

  async updatePaymentMethod(id: string, status: PaymentMethodStatus, sealed: EnvelopeEncrypted | null, payerLabel: string | null): Promise<void> {
    const index = this.data.methods.findIndex((m) => m.id === id);
    const current = this.data.methods[index];
    if (!current) throw new LedgerConflictError('not_found', 'payment method not found');
    if (status === 'active' && this.data.methods.some((m) => m.status === 'active' && m.id !== id)) {
      throw new LedgerConflictError('one_active_method', 'another PayPal account is already active');
    }
    this.data.methods[index] = { ...current, status, sealed: sealed ?? current.sealed, payerLabel: payerLabel ?? current.payerLabel };
  }

  async priceHistory(supplierCode: string, skus: readonly string[], sinceDate: string): Promise<Record<string, PriceObservation[]>> {
    const out: Record<string, PriceObservation[]> = {};
    for (const row of this.data.prices) {
      if (row.supplierCode !== supplierCode || !skus.includes(row.sku) || row.observedOn < sinceDate) continue;
      (out[row.sku] ??= []).push({ unitCostMinor: row.unitCostMinor, at: `${row.observedOn}T12:00:00Z` });
    }
    return out;
  }

  async recordPrice(supplierCode: string, sku: string, unitCostMinor: number, currency: string, observedOn: string): Promise<void> {
    const i = this.data.prices.findIndex((p) => p.supplierCode === supplierCode && p.sku === sku && p.observedOn === observedOn);
    const row = { supplierCode, sku, unitCostMinor, currency, observedOn };
    if (i >= 0) this.data.prices[i] = row;
    else this.data.prices.push(row);
  }

  async pastQuantities(skus: readonly string[]): Promise<Record<string, number[]>> {
    return Object.fromEntries(skus.filter((s) => this.data.pastQuantities[s]).map((s) => [s, [...this.data.pastQuantities[s]!]]));
  }

  private appendEvent(payment: PaymentRecord, event: NewPaymentEvent): void {
    if (event.paypalRequestId && this.data.events.some((e) => e.paypalRequestId === event.paypalRequestId)) {
      throw new LedgerConflictError('duplicate_request_id', `PayPal-Request-Id ${event.paypalRequestId} already recorded`);
    }
    this.data.events.push({ ...event, id: randomUUID(), paymentId: payment.id, currency: payment.currency, createdAt: this.iso() });
  }

  async createPayment(input: NewPayment, event: NewPaymentEvent): Promise<PaymentRecord> {
    if (input.draftId && (await this.findPaymentByDraftId(input.draftId))) {
      throw new LedgerConflictError('draft_already_paid', 'this draft already has a payment');
    }
    const at = this.iso();
    const payment: PaymentRecord = {
      ...newPaymentState(input.requestedMinor, input.status),
      id: randomUUID(),
      draftId: input.draftId,
      supplierCode: input.supplierCode,
      currency: input.currency,
      decision: input.decision,
      decisionReasons: input.decisionReasons,
      linesFingerprint: input.linesFingerprint,
      lines: input.lines.map((l) => ({ ...l })),
      createdBy: input.createdBy,
      approvedBy: null,
      paypalOrderId: null,
      paypalAuthorizationId: null,
      paypalCaptureIds: [],
      authorizationExpiresAt: null,
      honorPeriodEndsAt: null,
      approvalTokenHash: null,
      approvalExpiresAt: null,
      correlationId: input.correlationId,
      createdAt: at,
      updatedAt: at
    };
    this.appendEvent(payment, event);
    this.data.payments.set(payment.id, payment);
    return payment;
  }

  async getPayment(id: string): Promise<PaymentRecord | null> {
    return this.data.payments.get(id) ?? null;
  }

  async listPayments(opts: { readonly sinceIso?: string; readonly limit?: number } = {}): Promise<PaymentRecord[]> {
    return [...this.data.payments.values()]
      .filter((p) => !opts.sinceIso || p.createdAt >= opts.sinceIso)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, opts.limit ?? 500);
  }

  async findPaymentByApprovalHash(tokenHash: string): Promise<PaymentRecord | null> {
    return [...this.data.payments.values()].find((p) => p.approvalTokenHash === tokenHash) ?? null;
  }

  async findPaymentByDraftId(draftId: string): Promise<PaymentRecord | null> {
    return [...this.data.payments.values()].find((p) => p.draftId === draftId && p.status !== 'failed') ?? null;
  }

  async findPaymentByAuthorizationId(authorizationId: string): Promise<PaymentRecord | null> {
    return [...this.data.payments.values()].find((p) => p.paypalAuthorizationId === authorizationId) ?? null;
  }

  async record(id: string, change: { readonly action?: LedgerAction; readonly patch?: PaymentPatch; readonly event: NewPaymentEvent }): Promise<PaymentRecord> {
    const current = this.data.payments.get(id);
    if (!current) throw new LedgerConflictError('not_found', 'payment not found');
    const money = change.action ? applyAction(current, change.action) : current;
    const patch = change.patch ?? {};
    const next: PaymentRecord = {
      ...current,
      ...money,
      ...(patch.approvedBy !== undefined ? { approvedBy: patch.approvedBy } : {}),
      ...(patch.paypalOrderId !== undefined ? { paypalOrderId: patch.paypalOrderId } : {}),
      ...(patch.paypalAuthorizationId !== undefined ? { paypalAuthorizationId: patch.paypalAuthorizationId } : {}),
      ...(patch.addCaptureId !== undefined ? { paypalCaptureIds: [...current.paypalCaptureIds, patch.addCaptureId] } : {}),
      ...(patch.authorizationExpiresAt !== undefined ? { authorizationExpiresAt: patch.authorizationExpiresAt } : {}),
      ...(patch.honorPeriodEndsAt !== undefined ? { honorPeriodEndsAt: patch.honorPeriodEndsAt } : {}),
      ...(patch.approvalTokenHash !== undefined ? { approvalTokenHash: patch.approvalTokenHash } : {}),
      ...(patch.approvalExpiresAt !== undefined ? { approvalExpiresAt: patch.approvalExpiresAt } : {}),
      updatedAt: this.iso()
    };
    this.appendEvent(next, change.event);
    this.data.payments.set(id, next);
    return next;
  }

  async listEvents(paymentId: string): Promise<PaymentEventRecord[]> {
    return this.data.events.filter((e) => e.paymentId === paymentId);
  }

  async recordDelivery(delivery: Omit<DeliveryRecord, 'id' | 'createdAt'>): Promise<DeliveryRecord> {
    if (!this.data.payments.has(delivery.paymentId)) throw new LedgerConflictError('not_found', 'payment not found');
    const row: DeliveryRecord = { ...delivery, receivedLines: delivery.receivedLines.map((l) => ({ ...l })), id: randomUUID(), createdAt: this.iso() };
    this.data.deliveries.push(row);
    return row;
  }

  async listDeliveries(paymentId: string): Promise<DeliveryRecord[]> {
    return this.data.deliveries.filter((d) => d.paymentId === paymentId);
  }

  async recordInvoiceMatch(match: Omit<InvoiceMatchRecord, 'id' | 'createdAt'>): Promise<InvoiceMatchRecord> {
    if (!this.data.deliveries.some((d) => d.id === match.deliveryId)) throw new LedgerConflictError('not_found', 'delivery not found');
    const row: InvoiceMatchRecord = { ...structuredClone(match), id: randomUUID(), createdAt: this.iso() };
    this.data.invoiceMatches.push(row);
    return row;
  }

  async listInvoiceMatches(paymentId: string): Promise<InvoiceMatchRecord[]> {
    const ids = new Set(this.data.deliveries.filter((d) => d.paymentId === paymentId).map((d) => d.id));
    return this.data.invoiceMatches.filter((m) => ids.has(m.deliveryId));
  }
}
