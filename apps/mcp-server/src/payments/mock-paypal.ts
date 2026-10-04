// In-process fake of the PayPal REST endpoints ShopVoice Pay uses, exposed as
// a fetch implementation so PayPalClient runs unchanged (PAYPAL_MODE=mock).
//
// It models the state machines the payment code depends on (order approval,
// authorization capture/void/expiry, refunds, vault tokens) and honours
// PayPal-Request-Id: a repeated key returns the stored response without
// moving money again. Behaviour that the sandbox spike confirmed or corrected
// is noted inline with "SPIKE §n" (docs/paypal/SPIKE.md).
import { createHmac, randomBytes } from 'node:crypto';
import type { FetchInitLike, FetchLike, FetchResponseLike } from './paypal-client.js';
import { fromPayPalValue, toPayPalValue } from './money.js';
import type { AuthorizationStatus, CaptureStatus, OrderStatus, PayPalLink } from './types.js';

export const MOCK_BASE_URL = 'https://paypal.mock';
const DAY_MS = 86_400_000;
/** Authorizations stay capturable for 29 days; the first 3 are the honor period. SPIKE §2. */
export const AUTHORIZATION_VALIDITY_DAYS = 29;
export const HONOR_PERIOD_DAYS = 3;

export interface MockCall {
  readonly method: string;
  readonly path: string;
  readonly requestId: string | null;
  readonly status: number;
  readonly replayed: boolean;
}

export interface MockPayPalOptions {
  readonly now?: () => number;
  /** Where payer-action / approve links point (the console's simulated approval page). */
  readonly approveBaseUrl?: string;
  /** How the fake treats a vaulted order with a third-party payee. SPIKE §3 decides the real answer. */
  readonly vaultThirdPartyPayee?: 'allowed' | 'rejected';
  readonly webhookSecret?: string;
}

interface MockAuthorization {
  id: string;
  orderId: string;
  status: AuthorizationStatus;
  currency: string;
  authorizedMinor: number;
  capturedMinor: number;
  createdAt: number;
  expiresAt: number;
  captureIds: string[];
  invoiceId?: string;
  customId?: string;
}

interface MockCapture {
  id: string;
  authorizationId: string | null;
  status: CaptureStatus;
  currency: string;
  amountMinor: number;
  refundedMinor: number;
  finalCapture: boolean;
  createdAt: number;
}

interface MockOrder {
  id: string;
  status: OrderStatus;
  intent: 'CAPTURE' | 'AUTHORIZE';
  currency: string;
  amountMinor: number;
  purchaseUnit: Record<string, unknown>;
  vaultId: string | null;
  authorizationIds: string[];
  captureIds: string[];
}

interface MockSetupToken {
  id: string;
  status: 'PAYER_ACTION_REQUIRED' | 'APPROVED' | 'VAULTED';
  customerId: string;
}

interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.name));
  }
}

function unprocessable(issue: string, description: string): HttpError {
  return new HttpError(422, {
    name: 'UNPROCESSABLE_ENTITY',
    message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
    debug_id: `mock${randomBytes(6).toString('hex')}`,
    details: [{ issue, description }]
  });
}

function notFound(): HttpError {
  return new HttpError(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.', details: [{ issue: 'INVALID_RESOURCE_ID', description: 'Specified resource ID does not exist.' }] });
}

function badRequest(issue: string, description: string): HttpError {
  return new HttpError(400, { name: 'INVALID_REQUEST', message: 'Request is not well-formed, syntactically incorrect, or violates schema.', details: [{ issue, description }] });
}

function id(prefix: string, length = 17): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(length);
  let out = prefix;
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

function amountOf(raw: unknown, fallbackCurrency: string): { minor: number; currency: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const currency = typeof rec.currency_code === 'string' ? rec.currency_code : typeof rec.currency === 'string' ? rec.currency : fallbackCurrency;
  if (typeof rec.value !== 'string') throw badRequest('MISSING_REQUIRED_PARAMETER', 'amount.value is required');
  try {
    return { minor: fromPayPalValue(rec.value, currency), currency };
  } catch {
    throw badRequest('INVALID_PARAMETER_VALUE', 'amount.value is not a valid decimal');
  }
}

function money(minor: number, currency: string): { currency_code: string; value: string } {
  return { currency_code: currency, value: toPayPalValue(minor, currency) };
}

/** Pulls the verbatim webhook_event text out of a verify request built by verifyWebhookSignature. */
function extractRawEvent(rawBody: string): string | null {
  const marker = '"webhook_event":';
  const start = rawBody.indexOf(marker);
  if (start === -1 || !rawBody.endsWith('}')) return null;
  return rawBody.slice(start + marker.length, -1);
}

export class MockPayPal {
  readonly calls: MockCall[] = [];
  private readonly now: () => number;
  private readonly approveBaseUrl: string;
  private readonly vaultThirdPartyPayee: 'allowed' | 'rejected';
  readonly webhookSecret: string;
  private readonly orders = new Map<string, MockOrder>();
  private readonly authorizations = new Map<string, MockAuthorization>();
  private readonly captures = new Map<string, MockCapture>();
  private readonly refunds = new Map<string, { id: string; captureId: string; amountMinor: number; currency: string }>();
  private readonly setupTokens = new Map<string, MockSetupToken>();
  private readonly paymentTokens = new Map<string, { id: string; customerId: string; email: string }>();
  private readonly payouts = new Map<string, Record<string, unknown>>();
  private readonly idempotency = new Map<string, StoredResponse>();
  private readonly faults: { status: number | 'network' | 'drop_response'; remaining: number; path?: RegExp }[] = [];

  constructor(options: MockPayPalOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.approveBaseUrl = (options.approveBaseUrl ?? 'https://paypal.mock').replace(/\/+$/, '');
    this.vaultThirdPartyPayee = options.vaultThirdPartyPayee ?? 'allowed';
    this.webhookSecret = options.webhookSecret ?? randomBytes(16).toString('hex');
  }

  /** fetch-compatible entry point for PayPalClient. */
  readonly fetch: FetchLike = async (url: string, init: FetchInitLike): Promise<FetchResponseLike> => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const requestId = init.headers['paypal-request-id'] ?? null;
    const fault = this.takeFault(path);
    if (fault === 'network') throw new Error('mock_network_error');

    const key = requestId && init.method === 'POST' ? `${path}#${requestId}` : null;
    const stored = key ? this.idempotency.get(key) : undefined;
    let result: StoredResponse;
    let replayed = false;
    if (fault !== null && fault !== 'drop_response') {
      result = { status: fault, body: { name: 'INTERNAL_SERVER_ERROR', message: 'An internal server error has occurred.' } };
    } else if (stored) {
      result = stored;
      replayed = true;
    } else {
      result = this.dispatch(init.method, path, init.body, init.headers);
      if (key && result.status < 500) this.idempotency.set(key, result);
    }
    this.calls.push({ method: init.method, path, requestId, status: result.status, replayed });
    // The money moved but the caller never hears back: only a retry with the same key is safe.
    if (fault === 'drop_response') throw new Error('mock_response_lost');
    const text = result.body === null ? '' : JSON.stringify(result.body);
    const debugId = `mock${randomBytes(6).toString('hex')}`;
    return {
      status: result.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'paypal-debug-id' ? debugId : null) },
      text: async () => text
    };
  };

  /** Makes the next `times` calls (optionally only matching `path`) fail. */
  injectFault(status: number | 'network' | 'drop_response', times = 1, path?: RegExp): void {
    this.faults.push({ status, remaining: times, ...(path ? { path } : {}) });
  }

  /** The buyer clicks "Continue" on the PayPal approval page. */
  approveOrder(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`mock_order_not_found:${orderId}`);
    if (order.status === 'PAYER_ACTION_REQUIRED' || order.status === 'CREATED') order.status = 'APPROVED';
  }

  approveSetupToken(setupTokenId: string): void {
    const token = this.setupTokens.get(setupTokenId);
    if (!token) throw new Error(`mock_setup_token_not_found:${setupTokenId}`);
    if (token.status === 'PAYER_ACTION_REQUIRED') token.status = 'APPROVED';
  }

  /** Signs a raw event body the way the mock verify endpoint expects (stands in for PayPal's RSA cert chain). */
  signWebhook(rawEvent: string, webhookId: string, transmissionId = id('TX', 12)): Record<string, string> {
    const time = new Date(this.now()).toISOString();
    const sig = this.webhookSig(transmissionId, time, webhookId, rawEvent);
    return {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': `${MOCK_BASE_URL}/v1/notifications/certs/mock`,
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-sig': sig,
      'paypal-transmission-time': time
    };
  }

  authorizationSnapshot(authorizationId: string): Readonly<MockAuthorization> | null {
    const auth = this.authorizations.get(authorizationId);
    return auth ? { ...auth, captureIds: [...auth.captureIds] } : null;
  }

  private webhookSig(transmissionId: string, time: string, webhookId: string, body: string): string {
    return createHmac('sha256', this.webhookSecret).update(`${transmissionId}|${time}|${webhookId}|${body}`).digest('base64');
  }

  private takeFault(path: string): number | 'network' | 'drop_response' | null {
    const fault = this.faults.find((f) => f.remaining > 0 && (!f.path || f.path.test(path)));
    if (!fault) return null;
    fault.remaining -= 1;
    return fault.status;
  }

  private dispatch(method: string, path: string, rawBody: string | undefined, headers: Record<string, string>): StoredResponse {
    try {
      const body = this.parseBody(rawBody, headers);
      return this.route(method, path, body, headers, rawBody ?? '');
    } catch (error) {
      if (error instanceof HttpError) return { status: error.status, body: error.body };
      throw error;
    }
  }

  private parseBody(rawBody: string | undefined, headers: Record<string, string>): Record<string, unknown> {
    if (!rawBody) return {};
    if (headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(rawBody));
    try {
      const value: unknown = JSON.parse(rawBody);
      return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    } catch {
      throw badRequest('MALFORMED_REQUEST_JSON', 'The request JSON is not well formed.');
    }
  }

  private route(method: string, path: string, body: Record<string, unknown>, headers: Record<string, string>, rawBody: string): StoredResponse {
    if (method === 'POST' && path === '/v1/oauth2/token') {
      if (!headers.authorization?.startsWith('Basic ')) return { status: 401, body: { error: 'invalid_client', error_description: 'Client Authentication failed' } };
      return { status: 200, body: { scope: 'https://uri.paypal.com/services/payments/payment', access_token: `A21AA${randomBytes(24).toString('hex')}`, token_type: 'Bearer', app_id: 'APP-MOCK', expires_in: 32400, nonce: randomBytes(8).toString('hex') } };
    }
    if (!headers.authorization?.startsWith('Bearer ')) return { status: 401, body: { error: 'invalid_token', error_description: 'Token signature verification failed' } };

    let m: RegExpExecArray | null;
    if (method === 'POST' && path === '/v2/checkout/orders') return this.createOrder(body);
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path)) && method === 'GET') return { status: 200, body: this.orderJson(this.order(m[1]!)) };
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)\/authorize$/.exec(path)) && method === 'POST') return this.authorizeOrder(m[1]!);
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path)) && method === 'POST') return this.captureOrder(m[1]!);
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)$/.exec(path)) && method === 'GET') return { status: 200, body: this.authorizationJson(this.authorization(m[1]!)) };
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)\/capture$/.exec(path)) && method === 'POST') return this.captureAuthorization(m[1]!, body);
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)\/void$/.exec(path)) && method === 'POST') return this.voidAuthorization(m[1]!);
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)\/reauthorize$/.exec(path)) && method === 'POST') return this.reauthorize(m[1]!, body);
    if ((m = /^\/v2\/payments\/captures\/([^/]+)$/.exec(path)) && method === 'GET') return { status: 200, body: this.captureJson(this.capture(m[1]!)) };
    if ((m = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path)) && method === 'POST') return this.refundCapture(m[1]!, body);
    if ((m = /^\/v2\/payments\/refunds\/([^/]+)$/.exec(path)) && method === 'GET') {
      const refund = this.refunds.get(m[1]!);
      if (!refund) throw notFound();
      return { status: 200, body: { id: refund.id, status: 'COMPLETED', amount: money(refund.amountMinor, refund.currency) } };
    }
    if (method === 'POST' && path === '/v3/vault/setup-tokens') return this.createSetupToken(body);
    if ((m = /^\/v3\/vault\/setup-tokens\/([^/]+)$/.exec(path)) && method === 'GET') {
      const token = this.setupTokens.get(m[1]!);
      if (!token) throw notFound();
      return { status: 200, body: { id: token.id, status: token.status, customer: { id: token.customerId } } };
    }
    if (method === 'POST' && path === '/v3/vault/payment-tokens') return this.createPaymentToken(body);
    if ((m = /^\/v3\/vault\/payment-tokens\/([^/]+)$/.exec(path))) {
      const token = this.paymentTokens.get(m[1]!);
      if (!token) throw notFound();
      if (method === 'DELETE') {
        this.paymentTokens.delete(token.id);
        return { status: 204, body: null };
      }
      return { status: 200, body: { id: token.id, customer: { id: token.customerId }, payment_source: { paypal: { email_address: token.email } } } };
    }
    if (method === 'POST' && path === '/v1/payments/payouts') return this.createPayout(body);
    if ((m = /^\/v1\/payments\/payouts\/([^/]+)$/.exec(path)) && method === 'GET') {
      const batch = this.payouts.get(m[1]!);
      if (!batch) throw notFound();
      return { status: 200, body: batch };
    }
    if (method === 'POST' && path === '/v1/notifications/verify-webhook-signature') return this.verifyWebhook(body, rawBody);
    if (method === 'POST' && path === '/v1/notifications/webhooks') {
      return { status: 201, body: { id: id('WH-', 17), url: body.url, event_types: body.event_types } };
    }
    if (method === 'GET' && path === '/v1/notifications/webhooks') return { status: 200, body: { webhooks: [] } };
    throw notFound();
  }

  private order(orderId: string): MockOrder {
    const order = this.orders.get(orderId);
    if (!order) throw notFound();
    return order;
  }

  private authorization(authorizationId: string): MockAuthorization {
    const auth = this.authorizations.get(authorizationId);
    if (!auth) throw notFound();
    if (auth.status !== 'VOIDED' && auth.status !== 'CAPTURED' && this.now() > auth.expiresAt) auth.status = 'EXPIRED';
    return auth;
  }

  private capture(captureId: string): MockCapture {
    const capture = this.captures.get(captureId);
    if (!capture) throw notFound();
    return capture;
  }

  private createOrder(body: Record<string, unknown>): StoredResponse {
    const intent = body.intent;
    if (intent !== 'AUTHORIZE' && intent !== 'CAPTURE') throw badRequest('INVALID_PARAMETER_VALUE', 'intent must be CAPTURE or AUTHORIZE');
    const units = Array.isArray(body.purchase_units) ? body.purchase_units : [];
    const unit = units[0] as Record<string, unknown> | undefined;
    if (!unit || units.length !== 1) throw badRequest('INVALID_ARRAY_LENGTH', 'exactly one purchase unit is supported by ShopVoice Pay');
    const amount = amountOf(unit.amount, 'USD');
    if (!amount || amount.minor <= 0) throw unprocessable('AMOUNT_MISMATCH', 'amount must be positive');
    const source = (body.payment_source as Record<string, unknown> | undefined)?.paypal as Record<string, unknown> | undefined;
    const vaultId = typeof source?.vault_id === 'string' ? source.vault_id : null;
    if (vaultId && !this.paymentTokens.has(vaultId)) throw unprocessable('INVALID_RESOURCE_ID', 'vault_id is not a known payment token');
    if (vaultId && unit.payee && this.vaultThirdPartyPayee === 'rejected') {
      throw unprocessable('PAYEE_NOT_CONSENTED', 'Payee does not have appropriate consent to allow the API caller to process this type of transaction on their behalf.');
    }
    const order: MockOrder = {
      id: id('', 17),
      status: vaultId ? 'APPROVED' : source ? 'PAYER_ACTION_REQUIRED' : 'CREATED',
      intent,
      currency: amount.currency,
      amountMinor: amount.minor,
      purchaseUnit: unit,
      vaultId,
      authorizationIds: [],
      captureIds: []
    };
    this.orders.set(order.id, order);
    // A vaulted (merchant-initiated) order completes in the create call. SPIKE §3.
    if (vaultId) {
      if (intent === 'AUTHORIZE') this.doAuthorize(order);
      else this.doOrderCapture(order);
    }
    return { status: 201, body: this.orderJson(order) };
  }

  private authorizeOrder(orderId: string): StoredResponse {
    const order = this.order(orderId);
    if (order.intent !== 'AUTHORIZE') throw unprocessable('ACTION_DOES_NOT_MATCH_INTENT', 'Order was created with an intent to CAPTURE.');
    if (order.status === 'COMPLETED') throw unprocessable('ORDER_ALREADY_AUTHORIZED', 'Order already authorized.');
    if (order.status !== 'APPROVED') throw unprocessable('ORDER_NOT_APPROVED', 'Payer has not yet approved the Order for payment.');
    this.doAuthorize(order);
    return { status: 201, body: this.orderJson(order) };
  }

  private captureOrder(orderId: string): StoredResponse {
    const order = this.order(orderId);
    if (order.intent !== 'CAPTURE') throw unprocessable('ACTION_DOES_NOT_MATCH_INTENT', 'Order was created with an intent to AUTHORIZE.');
    if (order.status === 'COMPLETED') throw unprocessable('ORDER_ALREADY_CAPTURED', 'Order already captured.');
    if (order.status !== 'APPROVED') throw unprocessable('ORDER_NOT_APPROVED', 'Payer has not yet approved the Order for payment.');
    this.doOrderCapture(order);
    return { status: 201, body: this.orderJson(order) };
  }

  private doAuthorize(order: MockOrder): void {
    const created = this.now();
    const auth: MockAuthorization = {
      id: id('', 17),
      orderId: order.id,
      status: 'CREATED',
      currency: order.currency,
      authorizedMinor: order.amountMinor,
      capturedMinor: 0,
      createdAt: created,
      expiresAt: created + AUTHORIZATION_VALIDITY_DAYS * DAY_MS,
      captureIds: [],
      ...(typeof order.purchaseUnit.invoice_id === 'string' ? { invoiceId: order.purchaseUnit.invoice_id } : {}),
      ...(typeof order.purchaseUnit.custom_id === 'string' ? { customId: order.purchaseUnit.custom_id } : {})
    };
    this.authorizations.set(auth.id, auth);
    order.authorizationIds.push(auth.id);
    order.status = 'COMPLETED';
  }

  private doOrderCapture(order: MockOrder): void {
    const capture: MockCapture = { id: id('', 17), authorizationId: null, status: 'COMPLETED', currency: order.currency, amountMinor: order.amountMinor, refundedMinor: 0, finalCapture: true, createdAt: this.now() };
    this.captures.set(capture.id, capture);
    order.captureIds.push(capture.id);
    order.status = 'COMPLETED';
  }

  private captureAuthorization(authorizationId: string, body: Record<string, unknown>): StoredResponse {
    const auth = this.authorization(authorizationId);
    if (auth.status === 'VOIDED') throw unprocessable('AUTHORIZATION_VOIDED', 'A voided authorization cannot be captured.');
    if (auth.status === 'CAPTURED') throw unprocessable('AUTHORIZATION_ALREADY_CAPTURED', 'Authorization has already been captured.');
    if (auth.status === 'EXPIRED') throw unprocessable('AUTHORIZATION_EXPIRED', 'An expired authorization cannot be captured.');
    const remaining = auth.authorizedMinor - auth.capturedMinor;
    const requested = body.amount === undefined ? { minor: remaining, currency: auth.currency } : amountOf(body.amount, auth.currency);
    if (!requested || requested.minor <= 0) throw unprocessable('INVALID_PARAMETER_VALUE', 'capture amount must be positive');
    if (requested.currency !== auth.currency) throw unprocessable('CURRENCY_MISMATCH', 'Currency of capture must be the same as currency of authorization.');
    // PayPal allows over-capture up to 115% in some cases; ShopVoice Pay never asks for it, so the fake refuses.
    if (requested.minor > remaining) throw unprocessable('MAX_CAPTURE_AMOUNT_EXCEEDED', 'Capture amount exceeds allowable limit.');
    const finalCapture = body.final_capture === true;
    const capture: MockCapture = { id: id('', 17), authorizationId: auth.id, status: 'COMPLETED', currency: auth.currency, amountMinor: requested.minor, refundedMinor: 0, finalCapture, createdAt: this.now() };
    this.captures.set(capture.id, capture);
    auth.captureIds.push(capture.id);
    auth.capturedMinor += requested.minor;
    // final_capture releases whatever was not captured. SPIKE §2.
    auth.status = finalCapture || auth.capturedMinor === auth.authorizedMinor ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
    return { status: 201, body: this.captureJson(capture) };
  }

  private voidAuthorization(authorizationId: string): StoredResponse {
    const auth = this.authorization(authorizationId);
    if (auth.status === 'CAPTURED') throw unprocessable('AUTHORIZATION_ALREADY_CAPTURED', 'Authorization has been previously captured and hence cannot be voided.');
    if (auth.status === 'VOIDED') throw unprocessable('PREVIOUSLY_VOIDED', 'Authorization has been previously voided and hence cannot be voided again.');
    if (auth.status === 'EXPIRED') throw unprocessable('AUTHORIZATION_EXPIRED', 'An expired authorization cannot be voided.');
    auth.status = 'VOIDED';
    return { status: 200, body: this.authorizationJson(auth) };
  }

  private reauthorize(authorizationId: string, body: Record<string, unknown>): StoredResponse {
    const auth = this.authorization(authorizationId);
    if (auth.status !== 'CREATED') throw unprocessable('REAUTHORIZATION_NOT_SUPPORTED', 'Only a fully uncaptured authorization can be reauthorized.');
    const age = this.now() - auth.createdAt;
    if (age < HONOR_PERIOD_DAYS * DAY_MS) throw unprocessable('REAUTHORIZATION_TOO_SOON', 'A reauthorization cannot be made within the honor period.');
    const requested = body.amount === undefined ? { minor: auth.authorizedMinor, currency: auth.currency } : amountOf(body.amount, auth.currency);
    if (!requested || requested.minor > Math.floor(auth.authorizedMinor * 1.15)) throw unprocessable('MAX_AUTHORIZATION_AMOUNT_EXCEEDED', 'Reauthorization amount exceeds allowable limit.');
    const created = this.now();
    const fresh: MockAuthorization = { ...auth, id: id('', 17), status: 'CREATED', authorizedMinor: requested.minor, createdAt: created, expiresAt: auth.expiresAt, captureIds: [] };
    this.authorizations.set(fresh.id, fresh);
    return { status: 201, body: this.authorizationJson(fresh) };
  }

  private refundCapture(captureId: string, body: Record<string, unknown>): StoredResponse {
    const capture = this.capture(captureId);
    const remaining = capture.amountMinor - capture.refundedMinor;
    if (remaining <= 0) throw unprocessable('CAPTURE_FULLY_REFUNDED', 'The capture has already been fully refunded.');
    const requested = body.amount === undefined ? { minor: remaining, currency: capture.currency } : amountOf(body.amount, capture.currency);
    if (!requested || requested.minor <= 0) throw unprocessable('INVALID_PARAMETER_VALUE', 'refund amount must be positive');
    if (requested.minor > remaining) throw unprocessable('REFUND_AMOUNT_EXCEEDED', 'The refund amount must be less than or equal to the capture amount that has not yet been refunded.');
    capture.refundedMinor += requested.minor;
    capture.status = capture.refundedMinor === capture.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const refund = { id: id('', 17), captureId, amountMinor: requested.minor, currency: capture.currency };
    this.refunds.set(refund.id, refund);
    return { status: 201, body: { id: refund.id, status: 'COMPLETED', amount: money(refund.amountMinor, refund.currency), links: [] } };
  }

  private createSetupToken(body: Record<string, unknown>): StoredResponse {
    const paypal = (body.payment_source as Record<string, unknown> | undefined)?.paypal as Record<string, unknown> | undefined;
    if (!paypal) throw badRequest('MISSING_REQUIRED_PARAMETER', 'payment_source.paypal is required');
    if (paypal.usage_type !== 'MERCHANT') throw badRequest('INVALID_PARAMETER_VALUE', 'usage_type must be MERCHANT');
    const token: MockSetupToken = { id: id('', 17), status: 'PAYER_ACTION_REQUIRED', customerId: id('', 10) };
    this.setupTokens.set(token.id, token);
    const links: PayPalLink[] = [
      { href: `${this.approveBaseUrl}/agreements/approve?approval_session_id=${token.id}`, rel: 'approve', method: 'GET' },
      { href: `${MOCK_BASE_URL}/v3/vault/setup-tokens/${token.id}`, rel: 'self', method: 'GET' }
    ];
    return { status: 201, body: { id: token.id, customer: { id: token.customerId }, status: token.status, payment_source: { paypal: {} }, links } };
  }

  private createPaymentToken(body: Record<string, unknown>): StoredResponse {
    const tokenRef = (body.payment_source as Record<string, unknown> | undefined)?.token as Record<string, unknown> | undefined;
    if (!tokenRef || tokenRef.type !== 'SETUP_TOKEN' || typeof tokenRef.id !== 'string') throw badRequest('MISSING_REQUIRED_PARAMETER', 'payment_source.token is required');
    const setup = this.setupTokens.get(tokenRef.id);
    if (!setup) throw notFound();
    if (setup.status !== 'APPROVED') throw unprocessable('SETUP_TOKEN_NOT_APPROVED', 'The setup token has not been approved by the payer.');
    setup.status = 'VAULTED';
    const token = { id: id('', 7), customerId: setup.customerId, email: 'shop-owner@personal.example.com' };
    this.paymentTokens.set(token.id, token);
    return { status: 201, body: { id: token.id, customer: { id: token.customerId }, payment_source: { paypal: { email_address: token.email } } } };
  }

  private createPayout(body: Record<string, unknown>): StoredResponse {
    const header = body.sender_batch_header as Record<string, unknown> | undefined;
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    if (!header || typeof header.sender_batch_id !== 'string' || items.length === 0) throw badRequest('VALIDATION_ERROR', 'sender_batch_header and items are required');
    for (const batch of this.payouts.values()) {
      const existing = (batch.batch_header as Record<string, unknown>).sender_batch_header as Record<string, unknown>;
      if (existing.sender_batch_id === header.sender_batch_id) {
        throw new HttpError(400, { name: 'USER_BUSINESS_ERROR', message: 'Batch with given sender_batch_id already exists', details: [{ issue: 'DUPLICATE_SENDER_BATCH_ID', description: 'sender_batch_id already used' }] });
      }
    }
    const batchId = id('', 13);
    const batch = {
      batch_header: { payout_batch_id: batchId, batch_status: 'SUCCESS', sender_batch_header: { sender_batch_id: header.sender_batch_id } },
      items: items.map((item) => ({
        payout_item_id: id('', 13),
        transaction_status: 'SUCCESS',
        payout_item: { receiver: item.receiver, amount: item.amount, sender_item_id: item.sender_item_id }
      }))
    };
    this.payouts.set(batchId, batch);
    return { status: 201, body: { batch_header: { payout_batch_id: batchId, batch_status: 'PENDING', sender_batch_header: { sender_batch_id: header.sender_batch_id } } } };
  }

  private verifyWebhook(body: Record<string, unknown>, rawBody: string): StoredResponse {
    const fields = ['transmission_id', 'transmission_time', 'transmission_sig', 'webhook_id'] as const;
    for (const field of fields) if (typeof body[field] !== 'string') throw badRequest('MISSING_REQUIRED_PARAMETER', `${field} is required`);
    // PayPal checks the event exactly as it was sent; so does the fake.
    const eventText = extractRawEvent(rawBody) ?? JSON.stringify(body.webhook_event);
    const expected = this.webhookSig(String(body.transmission_id), String(body.transmission_time), String(body.webhook_id), eventText);
    return { status: 200, body: { verification_status: expected === body.transmission_sig ? 'SUCCESS' : 'FAILURE' } };
  }

  private orderJson(order: MockOrder): Record<string, unknown> {
    const links: PayPalLink[] = [{ href: `${MOCK_BASE_URL}/v2/checkout/orders/${order.id}`, rel: 'self', method: 'GET' }];
    if (order.status === 'PAYER_ACTION_REQUIRED') links.push({ href: `${this.approveBaseUrl}/checkoutnow?token=${order.id}`, rel: 'payer-action', method: 'GET' });
    if (order.status === 'CREATED') links.push({ href: `${this.approveBaseUrl}/checkoutnow?token=${order.id}`, rel: 'approve', method: 'GET' });
    const payments = order.authorizationIds.length || order.captureIds.length
      ? {
        payments: {
          ...(order.authorizationIds.length ? { authorizations: order.authorizationIds.map((aid) => this.authorizationJson(this.authorization(aid))) } : {}),
          ...(order.captureIds.length ? { captures: order.captureIds.map((cid) => this.captureJson(this.capture(cid))) } : {})
        }
      }
      : {};
    return {
      id: order.id,
      intent: order.intent,
      status: order.status,
      ...(order.vaultId ? { payment_source: { paypal: { attributes: { vault: { id: order.vaultId, status: 'VAULTED' } } } } } : {}),
      purchase_units: [{ ...order.purchaseUnit, ...payments }],
      links
    };
  }

  private authorizationJson(auth: MockAuthorization): Record<string, unknown> {
    return {
      id: auth.id,
      status: auth.status,
      amount: money(auth.authorizedMinor, auth.currency),
      ...(auth.invoiceId ? { invoice_id: auth.invoiceId } : {}),
      ...(auth.customId ? { custom_id: auth.customId } : {}),
      create_time: new Date(auth.createdAt).toISOString(),
      expiration_time: new Date(auth.expiresAt).toISOString(),
      links: [{ href: `${MOCK_BASE_URL}/v2/payments/authorizations/${auth.id}`, rel: 'self', method: 'GET' }]
    };
  }

  private captureJson(capture: MockCapture): Record<string, unknown> {
    return {
      id: capture.id,
      status: capture.status,
      amount: money(capture.amountMinor, capture.currency),
      final_capture: capture.finalCapture,
      create_time: new Date(capture.createdAt).toISOString(),
      links: [{ href: `${MOCK_BASE_URL}/v2/payments/captures/${capture.id}`, rel: 'self', method: 'GET' }]
    };
  }
}
