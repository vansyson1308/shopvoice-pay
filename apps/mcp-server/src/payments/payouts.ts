// Payouts v1: settles a supplier from the platform "procurement wallet" when
// the vault + third-party-payee path is unavailable (see docs/paypal/SPIKE.md).
import type { PayPalClient } from './paypal-client.js';
import type { Money } from './money.js';
import { toPayPalAmount } from './money.js';
import type { PayPalPayoutBatch } from './types.js';

export interface PayoutItemInput {
  readonly receiverEmail: string;
  readonly amount: Money;
  readonly note: string;
  /** Our capture id: makes the item traceable back to the ledger. */
  readonly senderItemId: string;
}

export interface PayoutInput {
  /** Must be unique per batch; PayPal rejects a reused sender_batch_id. */
  readonly senderBatchId: string;
  readonly emailSubject: string;
  readonly items: readonly PayoutItemInput[];
  readonly requestId: string;
  readonly correlationId?: string;
}

export async function createPayout(client: PayPalClient, input: PayoutInput): Promise<PayPalPayoutBatch> {
  const res = await client.request<PayPalPayoutBatch>({
    method: 'POST',
    path: '/v1/payments/payouts',
    body: {
      sender_batch_header: { sender_batch_id: input.senderBatchId, email_subject: input.emailSubject.slice(0, 255) },
      items: input.items.map((item) => ({
        recipient_type: 'EMAIL',
        receiver: item.receiverEmail,
        amount: { value: toPayPalAmount(item.amount).value, currency: item.amount.currency },
        note: item.note.slice(0, 4000),
        sender_item_id: item.senderItemId
      }))
    },
    requestId: input.requestId,
    representation: false,
    ...(input.correlationId ? { correlationId: input.correlationId } : {})
  });
  return res.data;
}

export async function getPayoutBatch(client: PayPalClient, payoutBatchId: string): Promise<PayPalPayoutBatch> {
  const res = await client.request<PayPalPayoutBatch>({ method: 'GET', path: `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}` });
  return res.data;
}
