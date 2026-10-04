import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { InMemoryTokenBucketRateLimiter } from '../../../packages/common/dist/index.js';
import type { Logger } from '../../../packages/common/dist/index.js';
import type { ShopStore } from './store.js';
import { createShopVoiceServer } from './mcp.js';
import type { ClientProfile } from './mcp.js';
import type { McpServerConfig } from './config.js';
import { ALL_TOOLS } from './tool-catalog.js';
import type { PaymentsService } from './payments/service.js';
import type { OwnerApi } from './owner-api.js';
import type { DemoShops } from './demo-shops.js';
import { createOAuthServer } from './oauth/server.js';
import type { OAuthServer } from './oauth/server.js';
import type { OAuthStore } from './oauth/store.js';
import type { CimdResolver } from './oauth/cimd.js';
import { CHALLENGE_SCOPE, WRITE_SCOPE, wwwAuthenticate } from './oauth/metadata.js';
import { createSite } from './site.js';
import { clientIpFrom } from './client-ip.js';

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  readonly tenantId: string;
  /** Who opened the session: auth kind + tenant (+ account for OAuth). Every request must match it. */
  readonly principalKey: string;
  lastSeenMs: number;
}

interface Principal {
  readonly kind: 'oauth' | 'static';
  readonly tenantId: string;
  readonly key: string;
  readonly scopes: ReadonlySet<string>;
  readonly isSandbox: boolean;
}

/** Tools that change shop data; an OAuth token needs shop.write to call them. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(ALL_TOOLS.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.name));
const STATIC_SCOPES: ReadonlySet<string> = new Set(['shop.read', 'shop.write']);

function callsWriteTool(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => {
    if (!m || typeof m !== 'object') return false;
    const msg = m as { method?: unknown; params?: { name?: unknown } };
    return msg.method === 'tools/call' && typeof msg.params?.name === 'string' && WRITE_TOOL_NAMES.has(msg.params.name);
  });
}

interface CachedToken {
  readonly tenantId: string | null;
  readonly expiresMs: number;
}

export interface McpHttpDeps {
  readonly store: ShopStore;
  readonly config: McpServerConfig;
  readonly logger: Logger;
  readonly now?: () => number;
  /** OAuth authorization server; active when config.publicBaseUrl is set. */
  readonly oauth?: { readonly store: OAuthStore; readonly cimd?: CimdResolver };
  /** Supplier payments; without it, payment tools report that payments are not set up. */
  readonly payments?: PaymentsService;
  /** Console owner API (/owner/api/*, static tokens only) and the PayPal webhook (/webhooks/paypal). */
  readonly owner?: OwnerApi;
  /** "Try the demo" visitor shops, created by the console (POST /owner/demo-shops). */
  readonly demoShops?: DemoShops;
}

/**
 * A client that can answer elicitation needs server-to-client requests in the
 * middle of a tool call, which only a streamed (SSE) response can carry.
 * Everyone else keeps the configured mode (plain JSON by default).
 */
export function wantsStreamedResponses(initialize: unknown): boolean {
  const caps = (initialize as { params?: { capabilities?: { elicitation?: unknown } } } | null)?.params?.capabilities;
  return !!caps && typeof caps.elicitation === 'object' && caps.elicitation !== null;
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store'
};

/** Constant-time check of the X-Origin-Verify header that CloudFront adds (empty secret = disabled). */
export function originVerified(value: string | undefined, secret: string): boolean {
  if (!secret) return true;
  if (!value) return false;
  const a = createHash('sha256').update(value).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export function hashBearerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Origin validation (MCP Streamable HTTP security requirement against DNS
 * rebinding). Requests without an Origin header (server-to-server clients
 * such as Alexa+ or the Bedrock agent) are allowed; browser origins must be on
 * the allow-list, or be loopback when MCP_ALLOW_LOCALHOST_ORIGINS=true.
 */
export function isOriginAllowed(origin: string | undefined, allowList: readonly string[], allowLocalhost: boolean): boolean {
  if (!origin) return true;
  if (allowList.includes(origin)) return true;
  if (allowLocalhost) {
    try {
      const url = new URL(origin);
      return (url.protocol === 'http:' || url.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, extra: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, extra);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > maxBytes) throw new Error('body_too_large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new Error('invalid_json');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('invalid_json');
  }
}

export interface McpHttpHandler {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  sessionCount(): number;
  sweepIdleSessions(): Promise<number>;
  /** OAuth housekeeping (idle DCR clients, dead codes/tokens); 0 when OAuth is off. */
  oauthCleanup(): Promise<number>;
  close(): Promise<void>;
}

export function createMcpHttpHandler(deps: McpHttpDeps): McpHttpHandler {
  const { store, config, logger } = deps;
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const tokenCache = new Map<string, CachedToken>();
  const tenantLimiter = new InMemoryTokenBucketRateLimiter(config.rateLimitPerMinute, config.rateLimitPerMinute);
  const authFailLimiter = new InMemoryTokenBucketRateLimiter(config.authFailuresPerMinute, config.authFailuresPerMinute);
  // At most ~120 new visitor shops an hour across all visitors.
  const demoShopLimiter = new InMemoryTokenBucketRateLimiter(30, 2);
  const oauth: OAuthServer | null = config.publicBaseUrl && deps.oauth
    ? createOAuthServer({
      store: deps.oauth.store,
      ...(deps.oauth.cimd ? { cimd: deps.oauth.cimd } : {}),
      logger,
      now,
      config: {
        publicBaseUrl: config.publicBaseUrl,
        mcpPath: config.mcpPath,
        cookieSecret: config.oauthCookieSecret,
        accessTtlSeconds: config.oauthAccessTtlSeconds,
        refreshTtlSeconds: config.oauthRefreshTtlSeconds,
        codeTtlSeconds: config.oauthCodeTtlSeconds,
        dcrPerHour: config.oauthDcrPerHour,
        loginPerMinute: config.oauthLoginPerMinute,
        dcrIdleDays: config.oauthDcrIdleDays,
        trustProxy: config.trustProxy,
        supportEmail: config.supportEmail
      }
    })
    : null;

  const site = createSite({ baseUrl: config.publicBaseUrl, mcpPath: config.mcpPath, supportEmail: config.supportEmail });

  async function resolvePrincipal(token: string): Promise<Principal | null> {
    if (oauth && token.startsWith('svat_')) {
      const p = await oauth.resolveAccessToken(token);
      return p ? { kind: 'oauth', tenantId: p.tenantId, key: `oauth:${p.tenantId}:${p.accountId}`, scopes: p.scopes, isSandbox: p.isSandbox } : null;
    }
    const tenantId = await resolveTenant(token);
    return tenantId ? { kind: 'static', tenantId, key: `static:${tenantId}`, scopes: STATIC_SCOPES, isSandbox: false } : null;
  }

  function unauthorized(res: ServerResponse, tokenPresented: boolean): void {
    const challenge = oauth
      ? wwwAuthenticate(oauth.urls, tokenPresented ? { error: 'invalid_token', description: 'The access token is missing, expired or revoked' } : {})
      : 'Bearer realm="shopvoice", error="invalid_token"';
    jsonRpcError(res, 401, -32001, oauth
      ? 'Unauthorized: connect ShopVoice with OAuth (sign in at the authorization server) or send a valid bearer token.'
      : 'Unauthorized: send Authorization: Bearer <your ShopVoice token>.', { 'www-authenticate': challenge });
  }

  /** 403 + insufficient_scope so OAuth clients run step-up authorization (MCP 2025-11-25). */
  function insufficientScope(res: ServerResponse): void {
    const challenge = oauth
      ? wwwAuthenticate(oauth.urls, { error: 'insufficient_scope', scope: CHALLENGE_SCOPE, description: 'Creating or confirming reorders needs the shop.write scope' })
      : `Bearer realm="shopvoice", error="insufficient_scope", scope="${CHALLENGE_SCOPE}"`;
    jsonRpcError(res, 403, -32003, 'Forbidden: this connection is read-only. Reconnect ShopVoice and allow "create and confirm purchase-order drafts" (scope shop.write).', { 'www-authenticate': challenge });
  }

  async function resolveTenant(token: string): Promise<string | null> {
    const hash = hashBearerToken(token);
    const cached = tokenCache.get(hash);
    if (cached && cached.expiresMs > now()) return cached.tenantId;
    const resolved = await store.resolveTokenHash(hash);
    const tenantId = resolved?.tenantId ?? null;
    tokenCache.set(hash, { tenantId, expiresMs: now() + config.tokenCacheSeconds * 1000 });
    if (tokenCache.size > 10_000) tokenCache.clear();
    return tenantId;
  }

  function corsHeaders(origin: string | undefined): Record<string, string> {
    if (!origin) return {};
    return {
      'access-control-allow-origin': origin,
      vary: 'Origin',
      'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version'
    };
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = header(req, 'origin');
    if (!isOriginAllowed(origin, config.allowedOrigins, config.allowLocalhostOrigins)) {
      logger.warn('mcp_origin_rejected', { origin });
      jsonRpcError(res, 403, -32000, 'Forbidden: this browser Origin is not allowed to call ShopVoice. Server-to-server clients should send no Origin header.');
      return;
    }
    const cors = corsHeaders(origin);
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const ip = clientIpFrom(req, config.trustProxy);
    const auth = header(req, 'authorization') ?? '';
    const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,256})$/i.exec(auth.trim());
    const token = match?.[1] ?? '';
    const principal = token ? await resolvePrincipal(token) : null;
    if (!principal) {
      // Guessing is only plausible for static tokens: OAuth access tokens are
      // 256-bit random, and a missing token is the normal start of sign-in.
      // Claude's requests all come from Anthropic's shared egress range, so
      // counting those per IP would throttle every Claude user at once.
      if (token && !token.startsWith('svat_') && !authFailLimiter.consume(ip).allowed) {
        jsonRpcError(res, 429, -32000, 'Too many failed sign-in attempts from this address; retry after 60 seconds.', { 'retry-after': '60' });
        return;
      }
      unauthorized(res, !!token);
      return;
    }
    const tenantId = principal.tenantId;
    if (principal.isSandbox && oauth) await oauth.ensureSandboxFresh(tenantId);

    if (!tenantLimiter.consume(tenantId).allowed) {
      logger.warn('mcp_rate_limited', { tenant_id: tenantId });
      jsonRpcError(res, 429, -32000, `Rate limit reached for this shop (${config.rateLimitPerMinute} requests per minute); retry after 10 seconds.`, { 'retry-after': '10' });
      return;
    }

    const sessionId = header(req, 'mcp-session-id');
    if (sessionId) {
      const session = sessions.get(sessionId);
      // A session is bound to the principal that created it; another
      // tenant's (or account's) token gets the same answer as an unknown session.
      if (!session || session.principalKey !== principal.key) {
        jsonRpcError(res, 404, -32001, 'Session not found: it expired or belongs to another sign-in. Start a new MCP session with initialize.');
        return;
      }
      session.lastSeenMs = now();
      let body: unknown;
      if (req.method === 'POST') {
        try {
          body = await readJsonBody(req, config.maxBodyBytes);
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === 'body_too_large';
          jsonRpcError(res, tooLarge ? 413 : 400, -32700, tooLarge ? `Request body too large (limit ${config.maxBodyBytes} bytes)` : 'Parse error: the request body is not valid JSON.');
          return;
        }
        if (!principal.scopes.has(WRITE_SCOPE) && callsWriteTool(body)) {
          insufficientScope(res);
          return;
        }
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== 'POST') {
      jsonRpcError(res, 400, -32000, 'Bad Request: send the Mcp-Session-Id header returned by initialize (or POST an initialize request first).');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req, config.maxBodyBytes);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'body_too_large';
      jsonRpcError(res, tooLarge ? 413 : 400, -32700, tooLarge ? `Request body too large (limit ${config.maxBodyBytes} bytes)` : 'Parse error: the request body is not valid JSON.');
      return;
    }
    if (!isInitializeRequest(body)) {
      jsonRpcError(res, 400, -32000, 'Bad Request: no MCP session. POST an initialize request first, then send its Mcp-Session-Id header.');
      return;
    }
    if (sessions.size >= config.maxSessions) {
      await sweepIdleSessions();
      if (sessions.size >= config.maxSessions) {
        jsonRpcError(res, 503, -32000, 'ShopVoice is at its session limit right now; retry after 30 seconds.', { 'retry-after': '30' });
        return;
      }
    }

    const profile: ClientProfile = principal.kind === 'oauth' ? 'chat' : 'voice';
    const server = createShopVoiceServer({
      store, tenantId, logger, confirmTtlSeconds: config.confirmTtlSeconds, profile,
      payments: deps.payments ?? null, elicitationTimeoutMs: config.elicitationTimeoutMs
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: config.jsonResponses && !wantsStreamedResponses(body),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, tenantId, principalKey: principal.key, lastSeenMs: now() });
        logger.info('mcp_session_started', { tenant_id: tenantId, session_id: id });
      }
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) logger.info('mcp_session_closed', { session_id: id });
    };
    // The SDK's transport getters are not declared `| undefined`, which trips
    // exactOptionalPropertyTypes; the runtime contract is identical.
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, body);
  }

  /**
   * The console's own API. Only static bearer tokens (the console's
   * server-side credential) are accepted: OAuth tokens belong to third-party
   * AI clients, which must go through MCP tools and the owner's approval.
   */
  async function handleOwner(req: IncomingMessage, res: ServerResponse, url: URL, owner: OwnerApi): Promise<void> {
    if (header(req, 'origin')) {
      sendJson(res, 403, { error: 'forbidden', message: 'The owner API is server-to-server only.' });
      return;
    }
    const ip = clientIpFrom(req, config.trustProxy);
    const auth = header(req, 'authorization') ?? '';
    const token = /^Bearer\s+([A-Za-z0-9._~+/=-]{16,256})$/i.exec(auth.trim())?.[1] ?? '';
    if (token.startsWith('svat_')) {
      sendJson(res, 403, { error: 'forbidden', message: 'OAuth connections cannot use the owner API.' });
      return;
    }
    const tenantId = token ? await resolveTenant(token) : null;
    if (!tenantId) {
      if (token && !authFailLimiter.consume(ip).allowed) {
        sendJson(res, 429, { error: 'rate_limited' }, { 'retry-after': '60' });
        return;
      }
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (!tenantLimiter.consume(tenantId).allowed) {
      sendJson(res, 429, { error: 'rate_limited' }, { 'retry-after': '10' });
      return;
    }
    await owner.handle(req, res, url, tenantId);
  }

  /**
   * The console asks for a private sample shop for a new visitor. Gated by a
   * secret shared with the console (server-to-server) and a global cap; the
   * console also limits per visitor IP.
   */
  async function handleDemoShop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const given = header(req, 'x-demo-provision-secret') ?? '';
    if (!deps.demoShops || !config.demoProvisionSecret || !originVerified(given, config.demoProvisionSecret) || header(req, 'origin')) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (!demoShopLimiter.consume('global').allowed) {
      sendJson(res, 429, { error: 'rate_limited' }, { 'retry-after': '60' });
      return;
    }
    const shop = await deps.demoShops.create();
    logger.info('demo_shop_created', { tenant_id: shop.tenantId });
    sendJson(res, 201, { token: shop.token });
  }

  async function sweepIdleSessions(): Promise<number> {
    const cutoff = now() - config.sessionIdleSeconds * 1000;
    let closed = 0;
    for (const [id, session] of sessions) {
      if (session.lastSeenMs < cutoff) {
        sessions.delete(id);
        await session.transport.close().catch(() => {});
        await session.server.close().catch(() => {});
        closed += 1;
      }
    }
    return closed;
  }

  return {
    async handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        if (url.pathname === '/healthz' && req.method === 'GET') {
          sendJson(res, 200, { status: 'ok', service: 'mcp-server' });
          return;
        }
        if (!originVerified(header(req, 'x-origin-verify'), config.originVerifySecret)) {
          sendJson(res, 403, { error: 'forbidden' });
          return;
        }
        if (oauth && await oauth.handle(req, res, url)) return;
        if (site?.handle(req, res, url)) return;
        if (url.pathname === '/readyz' && req.method === 'GET') {
          const ok = await store.ping();
          sendJson(res, ok ? 200 : 503, { status: ok ? 'ready' : 'not_ready', checks: { database: ok ? 'ok' : 'fail' } });
          return;
        }
        if (url.pathname === config.mcpPath) {
          await handleMcp(req, res);
          return;
        }
        if (deps.owner && url.pathname === '/webhooks/paypal' && req.method === 'POST') {
          await deps.owner.handleWebhook(req, res);
          return;
        }
        if (url.pathname === '/owner/demo-shops' && req.method === 'POST') {
          await handleDemoShop(req, res);
          return;
        }
        if (deps.owner && url.pathname.startsWith('/owner/api/')) {
          await handleOwner(req, res, url, deps.owner);
          return;
        }
        sendJson(res, 404, { error: 'not_found' });
      } catch (error) {
        logger.error('mcp_http_error', { path: url.pathname, error: error instanceof Error ? error.message : 'unknown' });
        jsonRpcError(res, 500, -32603, 'ShopVoice hit an unexpected server error while handling this request. Retry in a few seconds; if it keeps failing, contact support (see /support).');
      }
    },
    sessionCount: () => sessions.size,
    sweepIdleSessions,
    oauthCleanup: async () => (oauth ? oauth.cleanup() : 0),
    async close() {
      for (const session of sessions.values()) {
        await session.transport.close().catch(() => {});
        await session.server.close().catch(() => {});
      }
      sessions.clear();
    }
  };
}
