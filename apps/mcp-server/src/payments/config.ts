// Builds the PayPal client from env. PAYPAL_MODE=mock needs no credentials and
// never leaves the process; PAYPAL_MODE=sandbox needs sandbox REST app
// credentials. There is no live mode.
import { PayPalClient, SANDBOX_BASE_URL } from './paypal-client.js';
import type { PayPalLogger, PayPalMode } from './paypal-client.js';
import { MOCK_BASE_URL, MockPayPal } from './mock-paypal.js';

export interface PayPalEnvConfig {
  readonly mode: PayPalMode;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly baseUrl: string;
  readonly webhookId: string;
  readonly partnerAttributionId: string;
}

export function loadPayPalConfig(env: Record<string, string | undefined>): PayPalEnvConfig {
  const raw = (env.PAYPAL_MODE ?? '').trim().toLowerCase();
  const hasCreds = !!env.PAYPAL_CLIENT_ID && !!env.PAYPAL_CLIENT_SECRET;
  if (raw === 'live' || raw === 'production') throw new Error('PAYPAL_MODE=live is not supported: ShopVoice Pay is sandbox-only');
  if (raw !== '' && raw !== 'mock' && raw !== 'sandbox') throw new Error(`PAYPAL_MODE must be mock or sandbox, got ${raw}`);
  const mode: PayPalMode = raw === 'sandbox' || (raw === '' && hasCreds) ? 'sandbox' : 'mock';
  if (mode === 'sandbox' && !hasCreds) throw new Error('PAYPAL_MODE=sandbox requires PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET');
  return {
    mode,
    clientId: mode === 'sandbox' ? env.PAYPAL_CLIENT_ID ?? '' : 'mock-client-id',
    clientSecret: mode === 'sandbox' ? env.PAYPAL_CLIENT_SECRET ?? '' : 'mock-client-secret',
    baseUrl: mode === 'sandbox' ? (env.PAYPAL_BASE_URL || SANDBOX_BASE_URL) : MOCK_BASE_URL,
    webhookId: env.PAYPAL_WEBHOOK_ID ?? '',
    partnerAttributionId: env.PAYPAL_PARTNER_ATTRIBUTION_ID ?? ''
  };
}

export interface PayPalRuntime {
  readonly config: PayPalEnvConfig;
  readonly client: PayPalClient;
  /** Present only in mock mode: lets the console simulate buyer approval. */
  readonly mock: MockPayPal | null;
}

export function createPayPalRuntime(
  env: Record<string, string | undefined>,
  opts: { readonly logger?: PayPalLogger; readonly approveBaseUrl?: string; readonly now?: () => number } = {}
): PayPalRuntime {
  const config = loadPayPalConfig(env);
  const mock = config.mode === 'mock'
    ? new MockPayPal({ ...(opts.approveBaseUrl ? { approveBaseUrl: opts.approveBaseUrl } : {}), ...(opts.now ? { now: opts.now } : {}) })
    : null;
  const client = new PayPalClient({
    mode: config.mode,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    baseUrl: config.baseUrl,
    ...(mock ? { fetch: mock.fetch, sleep: async () => {} } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(config.partnerAttributionId ? { partnerAttributionId: config.partnerAttributionId } : {})
  });
  return { config, client, mock };
}
