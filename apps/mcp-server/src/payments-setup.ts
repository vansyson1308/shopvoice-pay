// Builds the PaymentsService for the MCP server from env. Sandbox only:
// PAYPAL_MODE=mock (default, in-process fake calibrated to the sandbox) or
// PAYPAL_MODE=sandbox (real sandbox REST app). There is no live mode.
import { randomBytes } from 'node:crypto';
import type { Logger } from '../../../packages/common/dist/index.js';
import { createPayPalRuntime } from './payments/config.js';
import type { PayPalRuntime } from './payments/config.js';
import { PaymentsService } from './payments/service.js';
import type { ShopStore } from './store.js';
import { autoCommitRepository } from './auto-commit.js';
import { createToolkitRunner } from './toolkit/agent-toolkit.js';
import { ToolkitGateway, loadToolkitGatewayConfig } from './toolkit/toolkit-gateway.js';

export interface PaymentsSetup {
  readonly service: PaymentsService;
  readonly runtime: PayPalRuntime;
}

export function loadPaymentsSetup(env: Record<string, string | undefined>, logger: Logger, now: () => number = Date.now): PaymentsSetup {
  const consoleUrl = (env.CONSOLE_PUBLIC_URL || 'http://localhost:8091').replace(/\/+$/, '');
  const runtime = createPayPalRuntime(env, { approveBaseUrl: `${consoleUrl}/sim/paypal`, now });
  let mekB64 = env.APP_MEK_B64 ?? '';
  if (Buffer.from(mekB64, 'base64').length !== 32) {
    if (runtime.config.mode !== 'mock') throw new Error('APP_MEK_B64 (32 random bytes, base64) is required with PAYPAL_MODE=sandbox');
    mekB64 = randomBytes(32).toString('base64');
    logger.warn('payments_ephemeral_key', { message: 'APP_MEK_B64 not set: using a throwaway key (mock PayPal only). Saved PayPal connections will not survive a restart.' });
  }
  const service = new PaymentsService(runtime.client, {
    brandName: 'ShopVoice Pay',
    returnBaseUrl: consoleUrl,
    mekB64,
    approvalTtlSeconds: Number.parseInt(env.PAYMENTS_APPROVAL_TTL_SECONDS ?? '900', 10) || 900,
    timeZone: env.SHOP_TIMEZONE || 'America/New_York'
  }, now);
  // PayPal Agent Toolkit behind the policy layer (DECISIONS D19). PAYPAL_TOOLKIT=off disables it.
  const toolkit = env.PAYPAL_TOOLKIT === 'off' ? null : new ToolkitGateway(createToolkitRunner(runtime, logger), loadToolkitGatewayConfig(env), now);
  service.useToolkit(toolkit);
  logger.info('payments_ready', { paypal_mode: runtime.config.mode, return_base_url: consoleUrl, agent_toolkit: toolkit ? 'on' : 'off' });
  return { service, runtime };
}

/**
 * Mock mode only: saves a simulated PayPal account for a demo shop, the way
 * "Connect PayPal" does after the owner approves, so auto-pay works at once.
 * Labelled as simulated in the console; never runs against the sandbox.
 */
export async function connectMockPayPal(setup: PaymentsSetup, store: ShopStore, tenantId: string): Promise<boolean> {
  const mock = setup.runtime.mock;
  if (!mock) return false;
  const repo = autoCommitRepository(store, tenantId);
  if (await repo.payments.getActivePaymentMethod()) return false;
  const ctx = { repo: repo.payments, correlationId: `mock-connect-${tenantId}`, supplierName: (code: string) => code };
  const { methodId, approveUrl } = await setup.service.startConnect(ctx);
  const setupTokenId = new URL(approveUrl).searchParams.get('approval_session_id');
  if (!setupTokenId) throw new Error('mock PayPal returned no setup token');
  mock.approveSetupToken(setupTokenId);
  await setup.service.completeConnect(ctx, methodId);
  return true;
}
