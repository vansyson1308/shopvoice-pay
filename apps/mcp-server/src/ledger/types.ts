// Payments data contract. Every method runs inside ShopStore.withTenant(), so
// the Postgres implementation is scoped by RLS (migration 019) and the memory
// implementation by tenant id. PayPal identifiers and the encrypted vault
// payload live here and in the payments service only; MCP tool output never
// carries them.
import type { PolicyDraftLine, PolicyReason, SpendPolicy } from '../policy/policy-engine.js';
import type { PriceObservation } from '../policy/anomaly.js';
import type { LedgerAction, MoneyState, PaymentStatus } from './state-machine.js';
import type { EnvelopeEncrypted } from '../../../../packages/common/dist/index.js';

export interface SupplierPayee {
  readonly supplierCode: string;
  readonly paypalEmail: string | null;
  readonly paypalMerchantId: string | null;
  readonly currency: string;
  readonly verified: boolean;
}

export type PaymentMethodStatus = 'pending' | 'active' | 'revoked' | 'failed';

export interface StoredPaymentMethod {
  readonly id: string;
  readonly status: PaymentMethodStatus;
  /** Envelope-encrypted JSON: { setupTokenId?, vaultId?, customerId? }. */
  readonly sealed: EnvelopeEncrypted;
  readonly payerLabel: string;
  readonly createdAt: string;
}

export type PaymentDecision = 'autopay' | 'step_up' | 'blocked';
/** owner_elicitation: approved in the MCP client's own confirmation form (MCP elicitation), outside the model. */
export type ApprovedBy = 'owner_voice' | 'owner_tap' | 'owner_paypal' | 'owner_elicitation';
export type EventKind =
  | 'policy_evaluated' | 'approval_requested' | 'approved' | 'declined' | 'authorized' | 'reauthorized'
  | 'captured' | 'voided' | 'refunded' | 'payout_sent' | 'payout_completed' | 'failed' | 'webhook_received'
  | 'cart_negotiated' | 'supplier_ordered' | 'shipment_tracked';
export type EventActor = 'agent' | 'owner' | 'system' | 'paypal';

export interface PaymentRecord extends MoneyState {
  readonly id: string;
  readonly draftId: string | null;
  readonly supplierCode: string;
  readonly currency: string;
  readonly decision: PaymentDecision;
  readonly decisionReasons: readonly PolicyReason[];
  readonly linesFingerprint: string;
  readonly lines: readonly PolicyDraftLine[];
  readonly createdBy: 'agent' | 'owner';
  readonly approvedBy: ApprovedBy | null;
  readonly paypalOrderId: string | null;
  readonly paypalAuthorizationId: string | null;
  readonly paypalCaptureIds: readonly string[];
  readonly authorizationExpiresAt: string | null;
  readonly honorPeriodEndsAt: string | null;
  readonly approvalTokenHash: string | null;
  readonly approvalExpiresAt: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewPayment {
  readonly draftId: string | null;
  readonly supplierCode: string;
  readonly currency: string;
  readonly requestedMinor: number;
  readonly status: Extract<PaymentStatus, 'pending_approval' | 'blocked'>;
  readonly decision: PaymentDecision;
  readonly decisionReasons: readonly PolicyReason[];
  readonly linesFingerprint: string;
  readonly lines: readonly PolicyDraftLine[];
  readonly createdBy: 'agent' | 'owner';
  readonly correlationId: string;
}

export type DeliveryOutcome = 'full' | 'partial' | 'hold' | 'none';

export interface ReceivedLine {
  readonly sku: string;
  readonly orderedQty: number;
  readonly receivedQty: number;
  readonly unitCostMinor: number;
}

export interface DeliveryRecord {
  readonly id: string;
  readonly paymentId: string;
  readonly source: 'voice' | 'invoice_photo' | 'console';
  readonly receivedLines: readonly ReceivedLine[];
  readonly outcome: DeliveryOutcome;
  readonly deliveredValueMinor: number;
  readonly currency: string;
  readonly createdAt: string;
}

/** A 3-way match against an invoice photo. Extracted lines are untrusted data, kept for review only. */
export interface InvoiceMatchRecord {
  readonly id: string;
  readonly deliveryId: string;
  readonly extractedLines: readonly Readonly<Record<string, unknown>>[];
  readonly poLines: readonly Readonly<Record<string, unknown>>[];
  readonly result: 'match' | 'short' | 'over' | 'price_mismatch' | 'mismatch';
  readonly varianceMinor: number;
  readonly extractor: string;
  readonly createdAt: string;
}

export type SalesInvoiceStatus = 'draft' | 'sent' | 'paid' | 'cancelled' | 'failed';

export interface SalesInvoiceLine {
  readonly name: string;
  readonly qty: number;
  readonly unitPriceMinor: number;
}

/**
 * The shop's own catering invoice (sell side), sent through the PayPal Agent
 * Toolkit after the owner confirms a preview. The PayPal invoice id stays here
 * and in the toolkit gateway; tools show the ShopVoice id only.
 */
export interface SalesInvoiceRecord {
  readonly id: string;
  readonly status: SalesInvoiceStatus;
  readonly customerEmail: string;
  readonly customerName: string | null;
  readonly lines: readonly SalesInvoiceLine[];
  readonly totalMinor: number;
  readonly currency: string;
  readonly note: string;
  readonly invoiceNumber: string;
  readonly paypalInvoiceId: string | null;
  readonly paypalRequestId: string;
  readonly createdBy: 'agent' | 'owner';
  readonly correlationId: string;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly updatedAt: string;
}

export type NewSalesInvoice = Omit<SalesInvoiceRecord, 'id' | 'status' | 'paypalInvoiceId' | 'createdAt' | 'sentAt' | 'updatedAt'>;

export interface SalesInvoicePatch {
  readonly status: SalesInvoiceStatus;
  readonly paypalInvoiceId?: string;
  readonly sentAt?: string;
}

const SALES_INVOICE_MOVES: Readonly<Record<SalesInvoiceStatus, readonly SalesInvoiceStatus[]>> = {
  draft: ['sent', 'failed'],
  failed: ['sent', 'failed'],
  sent: ['paid', 'cancelled'],
  paid: [],
  cancelled: []
};

/** Throws on an illegal status move (a sent invoice never goes back to draft). */
export function assertSalesInvoiceMove(from: SalesInvoiceStatus, to: SalesInvoiceStatus): void {
  if (!SALES_INVOICE_MOVES[from].includes(to)) throw new Error(`sales_invoice_illegal_move: ${from} -> ${to}`);
}

/** Non-money fields a transition may set. `null` clears a field. */
export interface PaymentPatch {
  readonly approvedBy?: ApprovedBy;
  readonly paypalOrderId?: string;
  readonly paypalAuthorizationId?: string;
  readonly addCaptureId?: string;
  readonly authorizationExpiresAt?: string;
  readonly honorPeriodEndsAt?: string;
  readonly approvalTokenHash?: string | null;
  readonly approvalExpiresAt?: string | null;
  /**
   * A supplier substitution accepted by the rules: new order lines. Only while
   * the money is held, before any charge, and never above the hold (guarded).
   */
  readonly lines?: readonly PolicyDraftLine[];
}

export interface NewPaymentEvent {
  readonly kind: EventKind;
  readonly amountMinor: number;
  readonly actor: EventActor;
  readonly reason: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly paypalRequestId?: string;
  readonly paypalResourceId?: string;
  readonly paypalDebugId?: string;
  readonly correlationId: string;
}

export interface PaymentEventRecord extends NewPaymentEvent {
  readonly id: string;
  readonly paymentId: string;
  readonly currency: string;
  readonly createdAt: string;
}

export interface PaymentsRepository {
  getPolicy(): Promise<SpendPolicy | null>;
  savePolicy(policy: SpendPolicy, updatedBy: 'owner' | 'seed'): Promise<void>;

  listPayees(): Promise<SupplierPayee[]>;
  getPayee(supplierCode: string): Promise<SupplierPayee | null>;
  upsertPayee(payee: SupplierPayee): Promise<void>;

  getActivePaymentMethod(): Promise<StoredPaymentMethod | null>;
  getPaymentMethod(id: string): Promise<StoredPaymentMethod | null>;
  createPaymentMethod(sealed: EnvelopeEncrypted, payerLabel: string): Promise<StoredPaymentMethod>;
  /** Moves a method to a new status (and new sealed payload, e.g. pending -> active with the vault id). */
  updatePaymentMethod(id: string, status: PaymentMethodStatus, sealed: EnvelopeEncrypted | null, payerLabel: string | null): Promise<void>;

  priceHistory(supplierCode: string, skus: readonly string[], sinceDate: string): Promise<Record<string, PriceObservation[]>>;
  recordPrice(supplierCode: string, sku: string, unitCostMinor: number, currency: string, observedOn: string): Promise<void>;
  /** Past confirmed order quantities per SKU (for the "3x usual" rule). */
  pastQuantities(skus: readonly string[]): Promise<Record<string, number[]>>;

  createPayment(input: NewPayment, event: NewPaymentEvent): Promise<PaymentRecord>;
  getPayment(id: string): Promise<PaymentRecord | null>;
  listPayments(opts?: { readonly sinceIso?: string; readonly limit?: number }): Promise<PaymentRecord[]>;
  findPaymentByApprovalHash(tokenHash: string): Promise<PaymentRecord | null>;
  /** The draft's live payment (any status but 'failed'); at most one exists (migration 021). */
  findPaymentByDraftId(draftId: string): Promise<PaymentRecord | null>;
  findPaymentByAuthorizationId(authorizationId: string): Promise<PaymentRecord | null>;
  /**
   * Atomically: re-reads the payment (locked), applies `action` through the
   * state machine (LedgerError on an illegal move), writes the new money
   * state and `patch`, and appends `event`. With no action, only the patch
   * and event are written.
   */
  record(id: string, change: { readonly action?: LedgerAction; readonly patch?: PaymentPatch; readonly event: NewPaymentEvent }): Promise<PaymentRecord>;
  listEvents(paymentId: string): Promise<PaymentEventRecord[]>;

  recordDelivery(delivery: Omit<DeliveryRecord, 'id' | 'createdAt'>): Promise<DeliveryRecord>;
  listDeliveries(paymentId: string): Promise<DeliveryRecord[]>;
  recordInvoiceMatch(match: Omit<InvoiceMatchRecord, 'id' | 'createdAt'>): Promise<InvoiceMatchRecord>;
  /** Matches for a payment's deliveries, oldest first. */
  listInvoiceMatches(paymentId: string): Promise<InvoiceMatchRecord[]>;

  createSalesInvoice(input: NewSalesInvoice): Promise<SalesInvoiceRecord>;
  getSalesInvoice(id: string): Promise<SalesInvoiceRecord | null>;
  /** Newest first. */
  listSalesInvoices(opts?: { readonly sinceIso?: string; readonly limit?: number }): Promise<SalesInvoiceRecord[]>;
  /** Moves the invoice through assertSalesInvoiceMove (locked re-read). */
  updateSalesInvoice(id: string, patch: SalesInvoicePatch): Promise<SalesInvoiceRecord>;
}
