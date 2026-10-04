// Refunds on a capture (Payments v2), partial or full.
import type { PayPalClient } from './paypal-client.js';
import type { Money } from './money.js';
import { toPayPalAmount } from './money.js';
import type { PayPalRefund } from './types.js';

export interface RefundInput {
  /** Omit for a full refund of the remaining captured amount. */
  readonly amount?: Money;
  readonly noteToPayer?: string;
  readonly invoiceId?: string;
  readonly requestId: string;
  readonly correlationId?: string;
}

export async function refundCapture(client: PayPalClient, captureId: string, input: RefundInput): Promise<PayPalRefund> {
  const res = await client.request<PayPalRefund>({
    method: 'POST',
    path: `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    body: {
      ...(input.amount ? { amount: toPayPalAmount(input.amount) } : {}),
      ...(input.noteToPayer ? { note_to_payer: input.noteToPayer.slice(0, 255) } : {}),
      ...(input.invoiceId ? { invoice_id: input.invoiceId } : {})
    },
    requestId: input.requestId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {})
  });
  return res.data;
}

export async function getRefund(client: PayPalClient, refundId: string, correlationId?: string): Promise<PayPalRefund> {
  const res = await client.request<PayPalRefund>({ method: 'GET', path: `/v2/payments/refunds/${encodeURIComponent(refundId)}`, ...(correlationId ? { correlationId } : {}) });
  return res.data;
}
