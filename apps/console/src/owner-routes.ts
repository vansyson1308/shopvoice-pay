// Console side of the owner API: the browser talks to /api/owner/* here, and
// the console server forwards to the MCP server's /owner/api/* with its own
// server-side credential (the browser never holds it, and no model is in this
// path). Also the pages PayPal sends the owner back to, and, in mock mode
// only, a clearly labelled simulated PayPal approval page.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../../../packages/common/dist/index.js';

export interface OwnerRoutesConfig {
  /** e.g. http://127.0.0.1:8090/owner/api */
  readonly ownerApiUrl: string;
  readonly extraHeaders?: Record<string, string>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'none'; form-action 'self'; frame-ancestors 'none'"
};

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, ...SECURITY_HEADERS });
  res.end();
}

/** Only ever redirect within the console: keep the path and query of a URL, drop its origin. */
export function localPath(target: unknown, fallback = '/'): string {
  if (typeof target !== 'string' || !target) return fallback;
  try {
    const u = new URL(target, 'http://console.local');
    return u.pathname.startsWith('/') && !u.pathname.startsWith('//') ? `${u.pathname}${u.search}` : fallback;
  } catch {
    return fallback;
  }
}

async function readBody(req: IncomingMessage, max = 16_384): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) throw new Error('body_too_large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function money(minor: unknown, currency: unknown): string {
  if (typeof minor !== 'number') return '';
  const amount = (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'USD' ? `$${amount}` : `${amount} ${esc(currency)}`;
}

export function createOwnerRoutes(config: OwnerRoutesConfig, logger: Logger, fetchImpl: FetchLike = fetch as unknown as FetchLike) {
  const base = config.ownerApiUrl.replace(/\/+$/, '');

  async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { ...(config.extraHeaders ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { error: 'bad_upstream_response' };
    }
    return { status: res.status, json };
  }

  function page(res: ServerResponse, title: string, inner: string, status = 200): void {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/static/sim-paypal.css"></head><body><main class="sim">${inner}</main></body></html>`);
  }

  async function simulatedApprovalPage(token: string, res: ServerResponse, kind: 'order' | 'setup', id: string): Promise<void> {
    const info = await call(token, 'GET', `/mock-paypal/${kind}/${encodeURIComponent(id)}`);
    if (info.status !== 200) {
      page(res, 'Not found', '<h1>This approval link is no longer valid.</h1><p><a href="/">Back to ShopVoice</a></p>', 404);
      return;
    }
    const amount = kind === 'order' ? `<p class="amount">${money(info.json.amount_minor, info.json.currency)}</p>` : '';
    page(res, 'Simulated PayPal', `
<div class="banner" role="note"><strong>Simulated PayPal</strong> (mock mode). This is not PayPal and no money moves. With PAYPAL_MODE=sandbox, this step happens on sandbox.paypal.com.</div>
<h1>${kind === 'order' ? 'Approve this payment' : 'Save PayPal for supplier payments'}</h1>
<p>${esc(info.json.description)}</p>${amount}
<form method="post" action="/sim/paypal/decide">
<input type="hidden" name="kind" value="${esc(kind)}"><input type="hidden" name="id" value="${esc(id)}">
<button type="submit" name="action" value="approve" class="primary">Continue</button>
<button type="submit" name="action" value="cancel">Cancel and return</button>
</form>`);
  }

  return {
    /** Direct owner API call for host code (voice approvals). */
    api: call,

    /** /api/owner/<path> -> owner API <path>. Caller has already checked console access. */
    async proxy(token: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<number> {
      const method = req.method ?? 'GET';
      if (!['GET', 'POST', 'PUT'].includes(method)) {
        res.writeHead(405, { 'content-type': 'application/json', ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return 405;
      }
      const path = url.pathname.replace(/^\/api\/owner/, '') + url.search;
      const raw = method === 'GET' ? '' : await readBody(req);
      let body: unknown;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json', ...SECURITY_HEADERS });
          res.end(JSON.stringify({ error: 'invalid_json' }));
          return 400;
        }
      }
      const out = await call(token, method, path, method === 'GET' ? undefined : body ?? {});
      res.writeHead(out.status, { 'content-type': 'application/json', ...SECURITY_HEADERS });
      res.end(JSON.stringify(out.json));
      return out.status;
    },

    /** PayPal return pages and the simulated PayPal page. Returns false when the path is not ours. */
    isPublicPath(path: string): boolean {
      return path.startsWith('/paypal/') || path.startsWith('/sim/paypal/');
    },

    async handlePublic(token: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      const method = req.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/paypal/connected') {
        const out = await call(token, 'POST', '/paypal/complete', { method_id: url.searchParams.get('method') ?? '' });
        if (out.status !== 200) logger.warn('console_paypal_connect_failed', { status: out.status, error: String(out.json.error ?? '') });
        redirect(res, out.status === 200 ? '/?paypal=connected#policy' : '/?paypal=connect_failed#policy');
        return true;
      }
      if (method === 'GET' && url.pathname === '/paypal/approved') {
        const id = url.searchParams.get('payment') ?? '';
        const out = await call(token, 'POST', `/payments/${encodeURIComponent(id)}/sync`);
        const status = String((out.json.payment as Record<string, unknown> | undefined)?.status ?? '');
        redirect(res, out.status === 200 && status === 'authorized' ? '/?paypal=approved#approvals' : '/?paypal=not_approved#approvals');
        return true;
      }
      if (method === 'GET' && url.pathname === '/paypal/cancelled') {
        redirect(res, `/?paypal=cancelled${url.searchParams.has('method') ? '#policy' : '#approvals'}`);
        return true;
      }
      if (method === 'GET' && url.pathname === '/sim/paypal/checkoutnow') {
        await simulatedApprovalPage(token, res, 'order', url.searchParams.get('token') ?? '');
        return true;
      }
      if (method === 'GET' && url.pathname === '/sim/paypal/agreements/approve') {
        await simulatedApprovalPage(token, res, 'setup', url.searchParams.get('approval_session_id') ?? '');
        return true;
      }
      if (method === 'POST' && url.pathname === '/sim/paypal/decide') {
        const form = new URLSearchParams(await readBody(req, 2048));
        const kind = form.get('kind') === 'setup' ? 'setup' : 'order';
        const id = (form.get('id') ?? '').replace(/[^A-Za-z0-9]/g, '');
        const info = await call(token, 'GET', `/mock-paypal/${kind}/${id}`);
        if (info.status !== 200) {
          redirect(res, '/');
          return true;
        }
        if (form.get('action') !== 'approve') {
          redirect(res, localPath(info.json.cancel_url));
          return true;
        }
        const out = await call(token, 'POST', `/mock-paypal/${kind}/${id}/approve`);
        redirect(res, localPath(out.json.return_url));
        return true;
      }
      return false;
    }
  };
}
