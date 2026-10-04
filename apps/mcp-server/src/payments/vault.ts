// Vault v3: save a PayPal wallet without a purchase, then charge it later
// with no payer interaction (merchant-initiated).
import type { PayPalClient } from './paypal-client.js';
import type { PayPalPaymentToken, PayPalSetupToken } from './types.js';

export interface SetupTokenInput {
  readonly returnUrl: string;
  readonly cancelUrl: string;
  readonly brandName: string;
  readonly description: string;
  readonly requestId: string;
  readonly correlationId?: string;
}

export function buildSetupTokenBody(input: Omit<SetupTokenInput, 'requestId' | 'correlationId'>): Record<string, unknown> {
  return {
    payment_source: {
      paypal: {
        description: input.description.slice(0, 127),
        usage_pattern: 'UNSCHEDULED_POSTPAID',
        usage_type: 'MERCHANT',
        customer_type: 'CONSUMER',
        permit_multiple_payment_tokens: true,
        experience_context: {
          brand_name: input.brandName.slice(0, 127),
          shipping_preference: 'NO_SHIPPING',
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl
        }
      }
    }
  };
}

export async function createSetupToken(client: PayPalClient, input: SetupTokenInput): Promise<PayPalSetupToken> {
  const res = await client.request<PayPalSetupToken>({
    method: 'POST',
    path: '/v3/vault/setup-tokens',
    body: buildSetupTokenBody(input),
    requestId: input.requestId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {})
  });
  return res.data;
}

export async function getSetupToken(client: PayPalClient, setupTokenId: string): Promise<PayPalSetupToken> {
  const res = await client.request<PayPalSetupToken>({ method: 'GET', path: `/v3/vault/setup-tokens/${encodeURIComponent(setupTokenId)}` });
  return res.data;
}

/** Exchanges an approved setup token for a long-lived payment token (the vault id). */
export async function createPaymentToken(client: PayPalClient, setupTokenId: string, requestId: string, correlationId?: string): Promise<PayPalPaymentToken> {
  const res = await client.request<PayPalPaymentToken>({
    method: 'POST',
    path: '/v3/vault/payment-tokens',
    body: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } },
    requestId,
    ...(correlationId ? { correlationId } : {})
  });
  return res.data;
}

export async function getPaymentToken(client: PayPalClient, vaultId: string): Promise<PayPalPaymentToken> {
  const res = await client.request<PayPalPaymentToken>({ method: 'GET', path: `/v3/vault/payment-tokens/${encodeURIComponent(vaultId)}` });
  return res.data;
}

export async function deletePaymentToken(client: PayPalClient, vaultId: string, correlationId?: string): Promise<void> {
  await client.request({ method: 'DELETE', path: `/v3/vault/payment-tokens/${encodeURIComponent(vaultId)}`, ...(correlationId ? { correlationId } : {}) });
}
