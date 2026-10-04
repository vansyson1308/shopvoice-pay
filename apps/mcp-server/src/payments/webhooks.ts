// Webhook registration and signature verification via PayPal's
// verify-webhook-signature endpoint (the documented, cert-chain-free path).
import type { PayPalClient } from './paypal-client.js';

export const WEBHOOK_EVENT_TYPES = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.AUTHORIZATION.CREATED',
  'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.REFUNDED',
  'VAULT.PAYMENT-TOKEN.CREATED'
] as const;

export interface WebhookHeaders {
  readonly authAlgo: string;
  readonly certUrl: string;
  readonly transmissionId: string;
  readonly transmissionSig: string;
  readonly transmissionTime: string;
}

/** Reads PayPal's transmission headers (lower-cased by node:http). Null when any is missing. */
export function readWebhookHeaders(headers: Record<string, string | string[] | undefined>): WebhookHeaders | null {
  const get = (name: string): string => {
    const value = headers[name];
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  };
  const out = {
    authAlgo: get('paypal-auth-algo'),
    certUrl: get('paypal-cert-url'),
    transmissionId: get('paypal-transmission-id'),
    transmissionSig: get('paypal-transmission-sig'),
    transmissionTime: get('paypal-transmission-time')
  };
  return Object.values(out).every((v) => v.length > 0) ? out : null;
}

/**
 * Asks PayPal whether a delivery is genuine. `rawEvent` must be the request
 * body exactly as received: PayPal verifies the event byte-for-byte, so it is
 * spliced into the verify request without being parsed and re-serialised.
 */
export async function verifyWebhookSignature(
  client: PayPalClient,
  input: { readonly webhookId: string; readonly headers: WebhookHeaders; readonly rawEvent: string; readonly requestId: string }
): Promise<boolean> {
  JSON.parse(input.rawEvent);
  const envelope = JSON.stringify({
    auth_algo: input.headers.authAlgo,
    cert_url: input.headers.certUrl,
    transmission_id: input.headers.transmissionId,
    transmission_sig: input.headers.transmissionSig,
    transmission_time: input.headers.transmissionTime,
    webhook_id: input.webhookId
  });
  const res = await client.request<{ verification_status?: string }>({
    method: 'POST',
    path: '/v1/notifications/verify-webhook-signature',
    rawBody: `${envelope.slice(0, -1)},"webhook_event":${input.rawEvent.trim()}}`,
    requestId: input.requestId,
    representation: false
  });
  return res.data.verification_status === 'SUCCESS';
}

export interface RegisteredWebhook {
  readonly id: string;
  readonly url: string;
  readonly event_types: readonly { readonly name: string }[];
}

export async function registerWebhook(client: PayPalClient, url: string, requestId: string): Promise<RegisteredWebhook> {
  const res = await client.request<RegisteredWebhook>({
    method: 'POST',
    path: '/v1/notifications/webhooks',
    body: { url, event_types: WEBHOOK_EVENT_TYPES.map((name) => ({ name })) },
    requestId,
    representation: false
  });
  return res.data;
}

export async function listWebhooks(client: PayPalClient): Promise<readonly RegisteredWebhook[]> {
  const res = await client.request<{ webhooks?: RegisteredWebhook[] }>({ method: 'GET', path: '/v1/notifications/webhooks' });
  return res.data.webhooks ?? [];
}
