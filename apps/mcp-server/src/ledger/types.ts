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
  | 'captured' | 'voided' | 'refunded' | 'payout_sent' | 'payout_completed' | 'failed' | 'webhook_received';
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
}
