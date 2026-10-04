// Orders v2 and Payments v2 (authorizations, captures) wrappers.
import type { PayPalClient } from './paypal-client.js';
import type { Money } from './money.js';
import { toPayPalAmount } from './money.js';
import type { PayPalAuthorization, PayPalCapture, PayPalOrder, PayPalPayee } from './types.js';

export interface OrderLineItem {
  readonly name: string;
  readonly sku?: string;
  readonly quantity: number;
  readonly unitAmount: Money;
}

export interface PurchaseUnitInput {
  readonly referenceId: string;
  readonly description: string;
  readonly invoiceId?: string;
  /** Our own id (supplier_payments.id) echoed back in webhooks; never a secret. */
  readonly customId?: string;
  readonly amount: Money;
  readonly items?: readonly OrderLineItem[];
  /** Third-party payee (the supplier). Omit for the platform-wallet fallback. */
  readonly payee?: { readonly emailAddress?: string; readonly merchantId?: string };
  readonly softDescriptor?: string;
}

export type OrderPaymentSource =
  | { readonly kind: 'paypal_approval'; readonly returnUrl: string; readonly cancelUrl: string; readonly brandName: string }
  | { readonly kind: 'vault'; readonly vaultId: string };

export interface CreateOrderInput {
  readonly intent: 'AUTHORIZE' | 'CAPTURE';
  readonly purchaseUnit: PurchaseUnitInput;
  readonly paymentSource: OrderPaymentSource;
  readonly requestId: string;
  readonly correlationId?: string;
}

export function buildOrderBody(input: CreateOrderInput): Record<string, unknown> {
  const pu = input.purchaseUnit;
  const currency = pu.amount.currency;
  const itemTotal = pu.items?.reduce((acc, item) => acc + item.unitAmount.amountMinor * item.quantity, 0);
  if (itemTotal !== undefined && itemTotal !== pu.amount.amountMinor) {
    throw new Error(`order_items_do_not_sum: items=${itemTotal} amount=${pu.amount.amountMinor}`);
  }
  const payee: PayPalPayee | undefined = pu.payee
    ? { ...(pu.payee.emailAddress ? { email_address: pu.payee.emailAddress } : {}), ...(pu.payee.merchantId ? { merchant_id: pu.payee.merchantId } : {}) }
    : undefined;
  const purchaseUnit: Record<string, unknown> = {
    reference_id: pu.referenceId,
    description: pu.description.slice(0, 127),
    ...(pu.invoiceId ? { invoice_id: pu.invoiceId } : {}),
    ...(pu.customId ? { custom_id: pu.customId } : {}),
    ...(pu.softDescriptor ? { soft_descriptor: pu.softDescriptor.slice(0, 22) } : {}),
    ...(payee ? { payee } : {}),
    amount: pu.items
      ? { ...toPayPalAmount(pu.amount), breakdown: { item_total: toPayPalAmount({ amountMinor: itemTotal ?? 0, currency }) } }
      : toPayPalAmount(pu.amount),
    ...(pu.items
      ? {
        items: pu.items.map((item) => ({
          name: item.name.slice(0, 127),
          ...(item.sku ? { sku: item.sku } : {}),
          quantity: String(item.quantity),
          unit_amount: toPayPalAmount(item.unitAmount),
          category: 'PHYSICAL_GOODS'
        }))
      }
      : {})
  };
  const source = input.paymentSource;
  const paymentSource = source.kind === 'vault'
    ? { paypal: { vault_id: source.vaultId, stored_credential: { payment_initiator: 'MERCHANT', usage: 'SUBSEQUENT', usage_pattern: 'UNSCHEDULED_POSTPAID' } } }
    : {
      paypal: {
        experience_context: {
          brand_name: source.brandName.slice(0, 127),
          user_action: 'CONTINUE',
          shipping_preference: 'NO_SHIPPING',
          return_url: source.returnUrl,
          cancel_url: source.cancelUrl
        }
      }
    };
  return { intent: input.intent, purchase_units: [purchaseUnit], payment_source: paymentSource };
}

export async function createOrder(client: PayPalClient, input: CreateOrderInput): Promise<PayPalOrder> {
  const res = await client.request<PayPalOrder>({
    method: 'POST',
    path: '/v2/checkout/orders',
    body: buildOrderBody(input),
    requestId: input.requestId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {})
  });
  return res.data;
}

export async function getOrder(client: PayPalClient, orderId: string, correlationId?: string): Promise<PayPalOrder> {
  const res = await client.request<PayPalOrder>({ method: 'GET', path: `/v2/checkout/orders/${encodeURIComponent(orderId)}`, ...(correlationId ? { correlationId } : {}) });
  return res.data;
}

export async function authorizeOrder(client: PayPalClient, orderId: string, requestId: string, correlationId?: string): Promise<PayPalOrder> {
  const res = await client.request<PayPalOrder>({
    method: 'POST',
    path: `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
    body: {},
    requestId,
    ...(correlationId ? { correlationId } : {})
  });
  return res.data;
}

export function firstAuthorization(order: PayPalOrder): PayPalAuthorization | null {
  return order.purchase_units?.[0]?.payments?.authorizations?.[0] ?? null;
}

export function firstCapture(order: PayPalOrder): PayPalCapture | null {
  return order.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
}

export interface CaptureInput {
  /** Omit to capture the full authorized amount. */
  readonly amount?: Money;
  readonly finalCapture: boolean;
  readonly invoiceId?: string;
  readonly noteToPayer?: string;
  readonly requestId: string;
  readonly correlationId?: string;
}

export async function captureAuthorization(client: PayPalClient, authorizationId: string, input: CaptureInput): Promise<PayPalCapture> {
  const res = await client.request<PayPalCapture>({
    method: 'POST',
    path: `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
    body: {
      ...(input.amount ? { amount: toPayPalAmount(input.amount) } : {}),
      final_capture: input.finalCapture,
      ...(input.invoiceId ? { invoice_id: input.invoiceId } : {}),
      ...(input.noteToPayer ? { note_to_payer: input.noteToPayer.slice(0, 255) } : {})
    },
    requestId: input.requestId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {})
  });
  return res.data;
}

export async function voidAuthorization(client: PayPalClient, authorizationId: string, requestId: string, correlationId?: string): Promise<PayPalAuthorization | null> {
  const res = await client.request<PayPalAuthorization | Record<string, never>>({
    method: 'POST',
    path: `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
    requestId,
    ...(correlationId ? { correlationId } : {})
  });
  return 'id' in res.data ? (res.data as PayPalAuthorization) : null;
}

export async function reauthorize(client: PayPalClient, authorizationId: string, amount: Money | null, requestId: string, correlationId?: string): Promise<PayPalAuthorization> {
  const res = await client.request<PayPalAuthorization>({
    method: 'POST',
    path: `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/reauthorize`,
    body: amount ? { amount: toPayPalAmount(amount) } : {},
    requestId,
    ...(correlationId ? { correlationId } : {})
  });
  return res.data;
}

export async function getAuthorization(client: PayPalClient, authorizationId: string, correlationId?: string): Promise<PayPalAuthorization> {
  const res = await client.request<PayPalAuthorization>({ method: 'GET', path: `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`, ...(correlationId ? { correlationId } : {}) });
  return res.data;
}

export async function getCapture(client: PayPalClient, captureId: string, correlationId?: string): Promise<PayPalCapture> {
  const res = await client.request<PayPalCapture>({ method: 'GET', path: `/v2/payments/captures/${encodeURIComponent(captureId)}`, ...(correlationId ? { correlationId } : {}) });
  return res.data;
}
