// Thin PayPal REST client: OAuth client-credentials, PayPal-Request-Id on every
// POST, bounded retries that only ever replay the same idempotency key, and
// structured logs that never include request bodies, tokens or secrets.
//
// The same class serves PAYPAL_MODE=sandbox (real api-m.sandbox.paypal.com)
// and PAYPAL_MODE=mock (an in-process fake passed in as `fetch`), so tests
// exercise the exact code path the sandbox uses.
import { randomUUID } from 'node:crypto';

export type PayPalMode = 'sandbox' | 'mock';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchInitLike {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

export interface PayPalLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface PayPalClientOptions {
  readonly mode: PayPalMode;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly logger?: PayPalLogger;
  /** Attempts per call including the first (default 3). */
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Sent as PayPal-Partner-Attribution-Id when set. */
  readonly partnerAttributionId?: string;
}

export interface PayPalIssue {
  readonly issue: string;
  readonly description?: string;
  readonly field?: string;
}

/** A non-2xx PayPal response. `name`/`issues` come from PayPal's error body. */
export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    override readonly name: string,
    message: string,
    readonly debugId: string | null,
    readonly issues: readonly PayPalIssue[]
  ) {
    super(message);
  }

  /** First issue code (e.g. AUTHORIZATION_ALREADY_CAPTURED) or the error name. */
  get code(): string {
    return this.issues[0]?.issue ?? this.name;
  }
}

/** The call never got a usable answer (network failure or timeout on every attempt). */
export class PayPalTransportError extends Error {
  constructor(message: string, readonly requestId: string | null) {
    super(message);
  }
}

export interface PayPalRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  /** Pre-serialised JSON body, used when part of it must reach PayPal byte-for-byte (webhook verification). */
  readonly rawBody?: string;
  /** Required for POST. Reuse the same key to retry the same money movement. */
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly headers?: Record<string, string>;
  /** Ask PayPal for the full resource instead of a minimal body (default true). */
  readonly representation?: boolean;
}

export interface PayPalResponse<T> {
  readonly status: number;
  readonly data: T;
  readonly debugId: string | null;
  readonly requestId: string | null;
}

const LIVE_HOST = /(^|\.)paypal\.com$/;
const SANDBOX_HOST = /(^|\.)sandbox\.paypal\.com$/;
const LOCAL_HOST = new Set(['localhost', '127.0.0.1', 'paypal.mock']);

/** Refuses anything that could reach live PayPal. Sandbox only, or a local/mock host. */
export function assertNonLiveBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (SANDBOX_HOST.test(url.hostname)) return url.origin;
  if (LIVE_HOST.test(url.hostname)) throw new Error('live_paypal_refused: ShopVoice Pay only talks to the PayPal sandbox');
  if (LOCAL_HOST.has(url.hostname)) return url.origin;
  throw new Error(`paypal_base_url_not_allowed: ${url.hostname}`);
}

export function newRequestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

interface CachedToken {
  readonly value: string;
  readonly expiresAt: number;
}

export class PayPalClient {
  readonly mode: PayPalMode;
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private token: CachedToken | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(private readonly options: PayPalClientOptions) {
    if (!options.clientId || !options.clientSecret) throw new Error('paypal_credentials_missing');
    this.mode = options.mode;
    this.baseUrl = assertNonLiveBaseUrl(options.baseUrl ?? SANDBOX_BASE_URL);
    const fallbackFetch: FetchLike = (url, init) => fetch(url, init);
    this.fetchImpl = options.fetch ?? fallbackFetch;
    this.maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  /** OAuth 2.0 client-credentials token, cached until 60 s before expiry. */
  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > this.now()) return this.token.value;
    if (!force && this.tokenInFlight) return this.tokenInFlight;
    this.tokenInFlight = this.fetchToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64');
    const res = await this.send('POST', '/v1/oauth2/token', {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'paypal-request-id': newRequestId('oauth')
    }, 'grant_type=client_credentials', null);
    const parsed = parseJson(await res.text());
    if (res.status !== 200 || typeof parsed?.access_token !== 'string') {
      throw toApiError(res.status, parsed, res.headers.get('paypal-debug-id'));
    }
    const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 300;
    this.token = { value: parsed.access_token, expiresAt: this.now() + Math.max(0, expiresIn - 60) * 1000 };
    return parsed.access_token;
  }

  async request<T>(req: PayPalRequest): Promise<PayPalResponse<T>> {
    if (req.method === 'POST' && !req.requestId) throw new Error(`paypal_request_id_required: ${req.path}`);
    if (!req.path.startsWith('/')) throw new Error('paypal_path_must_be_absolute');
    const requestId = req.requestId ?? null;
    let refreshedToken = false;
    let lastTransport: unknown = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const token = await this.accessToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(req.body !== undefined || req.rawBody !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(requestId ? { 'paypal-request-id': requestId } : {}),
        ...(req.representation === false ? {} : { prefer: 'return=representation' }),
        ...(this.options.partnerAttributionId ? { 'paypal-partner-attribution-id': this.options.partnerAttributionId } : {}),
        ...req.headers
      };
      const started = this.now();
      let res: FetchResponseLike;
      try {
        res = await this.send(req.method, req.path, headers, req.rawBody ?? (req.body === undefined ? undefined : JSON.stringify(req.body)), req.correlationId ?? null);
      } catch (error) {
        lastTransport = error;
        this.log('warn', 'paypal_transport_error', req, { attempt, request_id: requestId, error: errorMessage(error) });
        if (attempt < this.maxAttempts) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        break;
      }
      const debugId = res.headers.get('paypal-debug-id');
      const text = await res.text();
      const parsed = parseJson(text);
      this.log(res.status >= 400 ? 'warn' : 'info', 'paypal_call', req, {
        attempt,
        status: res.status,
        debug_id: debugId,
        request_id: requestId,
        latency_ms: this.now() - started
      });
      if (res.status === 401 && !refreshedToken) {
        refreshedToken = true;
        await this.accessToken(true);
        attempt -= 1;
        continue;
      }
      if (res.status >= 200 && res.status < 300) {
        return { status: res.status, data: (parsed ?? {}) as T, debugId, requestId };
      }
      if (isRetryableStatus(res.status) && attempt < this.maxAttempts) {
        await this.sleep(backoffMs(attempt, res.headers.get('retry-after')));
        continue;
      }
      throw toApiError(res.status, parsed, debugId);
    }
    throw new PayPalTransportError(`paypal_unreachable: ${errorMessage(lastTransport)}`, requestId);
  }

  private async send(method: string, path: string, headers: Record<string, string>, body: string | undefined, correlationId: string | null): Promise<FetchResponseLike> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: correlationId ? { ...headers, 'x-correlation-id': correlationId } : headers,
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private log(level: 'info' | 'warn', message: string, req: PayPalRequest, extra: Record<string, unknown>): void {
    this.options.logger?.[level](message, {
      correlation_id: req.correlationId,
      paypal_mode: this.mode,
      method: req.method,
      path: redactPath(req.path),
      ...extra
    });
  }
}

/** Keeps the resource type but drops the ids from logs: /v2/payments/authorizations/{id}/capture. */
export function redactPath(path: string): string {
  return path.split('?')[0]!.replace(/\/([A-Za-z0-9-]{8,})(?=\/|$)/g, (match, segment: string) => {
    return /^[a-z-]+$/.test(segment) ? match : '/{id}';
  });
}

export function backoffMs(attempt: number, retryAfter?: string | null): number {
  const hinted = Number(retryAfter);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, 5000);
  return Math.min(250 * 2 ** (attempt - 1), 2000);
}

function parseJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toApiError(status: number, body: Record<string, unknown> | null, debugId: string | null): PayPalApiError {
  const name = typeof body?.name === 'string' ? body.name : typeof body?.error === 'string' ? body.error : `HTTP_${status}`;
  const message = typeof body?.message === 'string' ? body.message : typeof body?.error_description === 'string' ? body.error_description : name;
  const details = Array.isArray(body?.details) ? body.details : [];
  const issues: PayPalIssue[] = details.flatMap((d: unknown) => {
    if (!d || typeof d !== 'object') return [];
    const rec = d as Record<string, unknown>;
    if (typeof rec.issue !== 'string') return [];
    return [{
      issue: rec.issue,
      ...(typeof rec.description === 'string' ? { description: rec.description } : {}),
      ...(typeof rec.field === 'string' ? { field: rec.field } : {})
    }];
  });
  return new PayPalApiError(status, name, message, typeof body?.debug_id === 'string' ? body.debug_id : debugId, issues);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
