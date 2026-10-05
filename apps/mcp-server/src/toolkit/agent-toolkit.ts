// PayPal Agent Toolkit (@paypal/agent-toolkit) run by server code, never by
// the model. The toolkit's own functions build each PayPal request; ShopVoice
// injects the client they call through, so that:
//  * the access token comes from our PayPalClient (sandbox only, refused for live);
//  * every POST carries a PayPal-Request-Id that we derive from our ledger, so a
//    retry replays the same key (the toolkit would otherwise send none);
//  * only an allow-list of methods can run. Refunds and payments move money and
//    stay in PaymentsService; merchant insights are not supported in the sandbox.
//
// PAYPAL_MODE=mock: the toolkit still makes real HTTP calls (axios), to a
// bridge bound to 127.0.0.1 under a random path that hands them to the
// in-process MockPayPal. Nothing leaves the machine.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PayPalAPI } from '@paypal/agent-toolkit/mcp';
import type { PayPalClient, PayPalLogger } from '../payments/paypal-client.js';
import { MOCK_BASE_URL } from '../payments/mock-paypal.js';
import type { MockPayPal } from '../payments/mock-paypal.js';
import type { PayPalRuntime } from '../payments/config.js';

/** Toolkit methods ShopVoice calls, with their HTTP method (POST needs a request id). */
export const TOOLKIT_METHODS = {
  create_invoice: 'POST',
  send_invoice: 'POST',
  get_invoice: 'GET',
  create_shipment_tracking: 'POST',
  get_shipment_tracking: 'GET',
  list_transactions: 'GET'
} as const;

export type ToolkitMethod = keyof typeof TOOLKIT_METHODS;

/** Toolkit methods ShopVoice deliberately never calls, and why. */
export const TOOLKIT_DENIED: Readonly<Record<string, string>> = {
  create_refund: 'Refunds move money, so they go through PaymentsService (request_refund): ledger check, PayPal-Request-Id, audit event.',
  create_order: 'Supplier payments go through the policy engine and PaymentsService only.',
  pay_order: 'Supplier payments go through the policy engine and PaymentsService only.',
  capture_order: 'Captures happen only on delivery, in PaymentsService.',
  get_merchant_insights: 'Not supported in the PayPal sandbox (toolkit spike T8). Spend summaries come from the ledger.'
};

export class ToolkitError extends Error {
  constructor(readonly code: string, readonly status: number | null, message: string) {
    super(message);
  }
}

export interface ToolkitRunner {
  run<T = Record<string, unknown>>(method: ToolkitMethod, args: Record<string, unknown>, requestId?: string): Promise<T>;
}

type ToolkitClient = ConstructorParameters<typeof PayPalAPI>[0];

function parseResult(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The toolkit reports failures as JSON: an LlmError ({ok: false, status, code}) or {error: {message}}. */
function failureOf(result: Record<string, unknown>): ToolkitError | null {
  if (result.ok === false) {
    const status = typeof result.status === 'number' ? result.status : null;
    return new ToolkitError(typeof result.code === 'string' ? result.code : 'PAYPAL_TOOL_ERROR', status, String(result.message ?? 'PayPal toolkit call failed').slice(0, 200));
  }
  const error = result.error as Record<string, unknown> | undefined;
  if (error && typeof error === 'object') return new ToolkitError('paypal_error', null, String(error.message ?? 'PayPal toolkit call failed').slice(0, 200));
  return null;
}

export class PayPalToolkitRunner implements ToolkitRunner {
  constructor(
    private readonly client: PayPalClient,
    private readonly baseUrl: () => Promise<string>,
    private readonly logger?: PayPalLogger
  ) {}

  async run<T = Record<string, unknown>>(method: ToolkitMethod, args: Record<string, unknown>, requestId?: string): Promise<T> {
    if (!Object.hasOwn(TOOLKIT_METHODS, method)) throw new ToolkitError('toolkit_method_denied', null, TOOLKIT_DENIED[method] ?? `${String(method)} is not on the toolkit allow-list`);
    if (TOOLKIT_METHODS[method] === 'POST' && !requestId) throw new ToolkitError('paypal_request_id_required', null, `${method} needs a PayPal-Request-Id`);
    const base = await this.baseUrl();
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.client.accessToken(attempt > 1);
      const injected = {
        getBaseUrl: () => base,
        getHeaders: async () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) })
      };
      // A fresh API object per call: the request id is per call, and construction costs ~4 ms.
      const api = new PayPalAPI(injected as unknown as ToolkitClient, { sandbox: true });
      const started = Date.now();
      const result = parseResult(await api.run(method, args));
      const failure = failureOf(result);
      this.logger?.[failure ? 'warn' : 'info']('paypal_toolkit_call', { method, request_id: requestId ?? null, status: failure?.status ?? 200, latency_ms: Date.now() - started });
      // An expired cached token: fetch a new one once and replay the same request id.
      if (failure?.status === 401 && attempt === 1) continue;
      if (failure) throw failure;
      return result as T;
    }
  }
}

/**
 * Mock mode: a loopback HTTP server that forwards the toolkit's requests to
 * MockPayPal.fetch. Bound to 127.0.0.1, served under a random path prefix,
 * and unref'd so it never keeps the process alive.
 */
export async function startMockToolkitBridge(mock: MockPayPal): Promise<{ readonly url: string; close(): Promise<void> }> {
  const prefix = `/${randomBytes(12).toString('hex')}`;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const url = req.url ?? '';
        if (!url.startsWith(`${prefix}/`)) {
          res.writeHead(404, { connection: 'close' }).end();
          return;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined;
        try {
          const out = await mock.fetch(`${MOCK_BASE_URL}${url.slice(prefix.length)}`, { method: req.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
          const text = await out.text();
          // connection: close, so an idle keep-alive socket never holds the process open.
          res.writeHead(out.status, { 'content-type': 'application/json', connection: 'close' }).end(text);
        } catch {
          res.writeHead(502, { connection: 'close' }).end();
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/**
 * The toolkit's HTTP client (axios) honours HTTP_PROXY. The mock bridge is on
 * loopback and must never be sent through a proxy, so loopback is added to
 * NO_PROXY when a proxy is configured (mock mode only).
 */
export function exemptLoopbackFromProxy(env: Record<string, string | undefined> = process.env): void {
  if (!env.http_proxy && !env.HTTP_PROXY) return;
  for (const key of ['no_proxy', 'NO_PROXY']) {
    const list = (env[key] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    if (!list.includes('127.0.0.1')) env[key] = [...list, '127.0.0.1'].join(',');
  }
}

/** The runner for this PayPal runtime: the sandbox REST base URL, or the mock bridge (started on first use). */
export function createToolkitRunner(runtime: PayPalRuntime, logger?: PayPalLogger): PayPalToolkitRunner {
  let bridge: Promise<{ url: string }> | null = null;
  const mock = runtime.mock;
  if (mock) exemptLoopbackFromProxy();
  const baseUrl = mock
    ? () => (bridge ??= startMockToolkitBridge(mock)).then((b) => b.url)
    : async () => runtime.client.baseUrl;
  return new PayPalToolkitRunner(runtime.client, baseUrl, logger);
}
