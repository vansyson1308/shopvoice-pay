// OAuth 2.1 authorization server for the ShopVoice MCP connector.
// Routes: /.well-known/oauth-protected-resource[/mcp], /.well-known/oauth-authorization-server,
// /oauth/{register,authorize,token,revoke}, /account. Raw node:http.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryTokenBucketRateLimiter } from '../../../../packages/common/dist/index.js';
import type { Logger } from '../../../../packages/common/dist/index.js';
import { CimdError, CimdResolver, isCimdClientId } from './cimd.js';
import {
  burnPasswordCheck, hashPassword, isValidCodeChallenge, isValidCodeVerifier, randomToken, safeEqual, sha256Hex,
  signCookieValue, verifyCookieValue, verifyPassword, verifyPkce
} from './crypto.js';
import { authorizationServerMetadata, oauthUrls, parseScopeParam, protectedResourceMetadata } from './metadata.js';
import type { OAuthUrls } from './metadata.js';
import { pickLocale, renderAccountPage, renderAuthPage, renderConsentPage, renderErrorPage } from './pages.js';
import type { HiddenFields, Locale, MessageKey } from './pages.js';
import { isLoopbackRedirect, redirectHost, redirectUriMatches, validateRegisteredRedirectUri } from './redirect.js';
import { clientIpFrom } from '../client-ip.js';
import { AccountExistsError } from './store.js';
import type { OAuthClient, OAuthStore, WebAccount } from './store.js';

export interface OAuthConfig {
  readonly publicBaseUrl: string;
  readonly mcpPath: string;
  readonly cookieSecret: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
  readonly codeTtlSeconds: number;
  readonly dcrPerHour: number;
  readonly loginPerMinute: number;
  readonly dcrIdleDays: number;
  readonly trustProxy: boolean | number;
  readonly supportEmail: string;
}

export interface OAuthPrincipal {
  readonly tenantId: string;
  readonly accountId: string;
  readonly clientId: string;
  readonly scopes: ReadonlySet<string>;
  readonly isSandbox: boolean;
}

export interface OAuthServerDeps {
  readonly store: OAuthStore;
  readonly config: OAuthConfig;
  readonly logger: Logger;
  readonly cimd?: CimdResolver;
  readonly now?: () => number;
}

export interface OAuthServer {
  readonly urls: OAuthUrls;
  /** Handles OAuth/account routes; returns false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  resolveAccessToken(token: string): Promise<OAuthPrincipal | null>;
  ensureSandboxFresh(tenantId: string): Promise<void>;
  cleanup(): Promise<number>;
}

const SESSION_COOKIE = 'sv_session';
const CSRF_COOKIE = 'sv_csrf';
const SESSION_TTL_MS = 12 * 3600_000;
/** Privacy policy: tool-call audit entries are kept 90 days. */
export const AUDIT_RETENTION_DAYS = 90;
const MAX_FORM_BYTES = 16 * 1024;
const SANDBOX_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const AUTHZ_FIELDS = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource', 'ui_locales'] as const;

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
  'access-control-max-age': '600'
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface ResolvedClient {
  readonly client: OAuthClient;
  readonly clientHost: string | null;
}

interface AuthzRequest {
  readonly client: ResolvedClient;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  readonly scopes: string[];
  readonly resource: string;
  readonly hidden: Record<string, string>;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function parseCookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header(req, 'cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > max) throw new HttpError(413, 'request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function mediaType(req: IncomingMessage): string {
  return (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    ...extra
  });
  res.end(JSON.stringify(body));
}

function oauthError(res: ServerResponse, status: number, error: string, description: string): void {
  sendJson(res, status, { error, error_description: description }, CORS);
}

export function createOAuthServer(deps: OAuthServerDeps): OAuthServer {
  const { store, config, logger } = deps;
  const now = deps.now ?? Date.now;
  const urls = oauthUrls(config.publicBaseUrl, config.mcpPath);
  const cimd = deps.cimd ?? new CimdResolver();
  const secure = urls.issuer.startsWith('https://');
  const dcrLimiter = new InMemoryTokenBucketRateLimiter(config.dcrPerHour, config.dcrPerHour / 60);
  // Claude registers from Anthropic's shared egress range, so one per-IP
  // bucket there would throttle every Claude user; they share a larger one.
  const anthropicDcrLimiter = new InMemoryTokenBucketRateLimiter(config.dcrPerHour * 100, (config.dcrPerHour * 100) / 60);
  const loginLimiter = new InMemoryTokenBucketRateLimiter(config.loginPerMinute, config.loginPerMinute);
  const sandboxChecked = new Map<string, string>();

  const clientIp = (req: IncomingMessage): string => clientIpFrom(req, config.trustProxy);

  function cookie(name: string, value: string, maxAgeSeconds: number): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
  }

  function csrfFor(req: IncomingMessage, res: ServerResponse): string {
    const existing = parseCookies(req).get(CSRF_COOKIE);
    if (existing && /^[A-Za-z0-9_-]{32,64}$/.test(existing)) return existing;
    const fresh = randomBytes(24).toString('base64url');
    appendCookie(res, cookie(CSRF_COOKIE, fresh, 86_400));
    return fresh;
  }

  function appendCookie(res: ServerResponse, value: string): void {
    const prev = res.getHeader('set-cookie');
    const list = Array.isArray(prev) ? prev : typeof prev === 'string' ? [prev] : [];
    res.setHeader('set-cookie', [...list, value]);
  }

  function csrfValid(req: IncomingMessage, form: URLSearchParams): boolean {
    const c = parseCookies(req).get(CSRF_COOKIE);
    const f = form.get('csrf');
    return !!c && !!f && safeEqual(c, f);
  }

  async function sessionAccount(req: IncomingMessage): Promise<WebAccount | null> {
    const raw = parseCookies(req).get(SESSION_COOKIE);
    if (!raw) return null;
    const accountId = verifyCookieValue(raw, config.cookieSecret, now());
    if (!accountId) return null;
    const account = await store.getAccount(accountId);
    return account && account.status === 'active' ? account : null;
  }

  function startSession(res: ServerResponse, accountId: string): void {
    appendCookie(res, cookie(SESSION_COOKIE, signCookieValue(accountId, config.cookieSecret, now() + SESSION_TTL_MS), SESSION_TTL_MS / 1000));
  }

  function endSession(res: ServerResponse): void {
    appendCookie(res, cookie(SESSION_COOKIE, '', 0));
  }

  function sendHtml(res: ServerResponse, status: number, html: string, formAction: readonly string[] = []): void {
    const actions = ["'self'", ...formAction].join(' ');
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action ${actions}; frame-ancestors 'none'; base-uri 'none'`
    });
    res.end(html);
  }

  function errorPage(res: ServerResponse, locale: Locale, message: string, status = 400): void {
    sendHtml(res, status, renderErrorPage(locale, message, config.supportEmail));
  }

  function redirectWith(res: ServerResponse, redirectUri: string, params: Record<string, string>): void {
    const target = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v) target.searchParams.set(k, v);
    target.searchParams.set('iss', urls.issuer);
    res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
  }

  // ---- clients ------------------------------------------------------------
  async function resolveClient(clientId: string): Promise<ResolvedClient | null> {
    if (!clientId || clientId.length > 512) return null;
    if (isCimdClientId(clientId)) {
      try {
        const doc = await cimd.resolve(clientId);
        const client: OAuthClient = {
          clientId, clientName: doc.clientName, redirectUris: doc.redirectUris,
          tokenEndpointAuthMethod: 'none', clientSecretHash: null, registrationType: 'cimd'
        };
        return { client, clientHost: new URL(clientId).host };
      } catch (error) {
        logger.warn('oauth_cimd_rejected', { client_host: safeHost(clientId), reason: error instanceof CimdError ? error.message : 'error' });
        return null;
      }
    }
    const client = await store.getClient(clientId);
    return client && client.registrationType === 'dcr' ? { client, clientHost: null } : null;
  }

  async function authenticateClient(form: URLSearchParams): Promise<OAuthClient> {
    const clientId = form.get('client_id') ?? '';
    const client = clientId ? await store.getClient(clientId) : null;
    if (!client) throw new HttpError(401, 'invalid_client');
    if (client.tokenEndpointAuthMethod === 'client_secret_post') {
      const secret = form.get('client_secret') ?? '';
      if (!secret || !client.clientSecretHash || !safeEqual(sha256Hex(secret), client.clientSecretHash)) throw new HttpError(401, 'invalid_client');
    }
    return client;
  }

  // ---- /oauth/authorize -----------------------------------------------------
  async function parseAuthzRequest(params: URLSearchParams, res: ServerResponse, locale: Locale): Promise<AuthzRequest | null> {
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const client = await resolveClient(clientId);
    if (!client) {
      errorPage(res, locale, 'Unknown or invalid client_id. The app that sent you here is not registered with ShopVoice, or its client metadata document could not be verified.');
      return null;
    }
    if (!redirectUri || !redirectUriMatches(redirectUri, client.client.redirectUris)) {
      errorPage(res, locale, 'The redirect_uri does not match any redirect URI registered for this app, so ShopVoice will not send you there.');
      return null;
    }
    const state = params.get('state') ?? '';
    const fail = (error: string, description: string) => {
      redirectWith(res, redirectUri, { error, error_description: description, state });
      return null;
    };
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    const challenge = params.get('code_challenge') ?? '';
    if (params.get('code_challenge_method') !== 'S256' || !isValidCodeChallenge(challenge)) {
      return fail('invalid_request', 'PKCE is required: send code_challenge (43 base64url characters) with code_challenge_method=S256.');
    }
    const scopes = parseScopeParam(params.get('scope') ?? undefined);
    if (!scopes) return fail('invalid_scope', 'Supported scopes are shop.read, shop.write and offline_access.');
    const resource = params.get('resource') ?? urls.resource;
    if (resource.replace(/\/+$/, '') !== urls.resource) return fail('invalid_target', `This server only issues tokens for ${urls.resource}.`);
    const hidden: Record<string, string> = {};
    for (const k of AUTHZ_FIELDS) {
      const v = params.get(k);
      if (v !== null) hidden[k] = v;
    }
    return { client, redirectUri, state, codeChallenge: challenge, scopes, resource: urls.resource, hidden };
  }

  function langSwitchHref(path: string, hidden: Record<string, string>, locale: Locale): string {
    const q = new URLSearchParams(hidden);
    q.set('ui_locales', locale === 'vi' ? 'en' : 'vi');
    return `${path}?${q.toString()}`;
  }

  function showAuth(req: IncomingMessage, res: ServerResponse, locale: Locale, authz: AuthzRequest, error: MessageKey | null, email = '', status = 200): void {
    const csrf = csrfFor(req, res);
    const hidden: HiddenFields = { ...authz.hidden, csrf };
    const label = authz.client.clientHost ?? (authz.client.client.clientName || redirectHost(authz.redirectUri));
    sendHtml(res, status, renderAuthPage({ locale, action: '/oauth/authorize', hidden, clientLabel: label, error, email, supportEmail: config.supportEmail, langSwitchHref: langSwitchHref('/oauth/authorize', authz.hidden, locale) }));
  }

  function showConsent(req: IncomingMessage, res: ServerResponse, locale: Locale, authz: AuthzRequest, account: WebAccount): void {
    const csrf = csrfFor(req, res);
    const loopbackOnly = authz.client.client.redirectUris.every((u) => isLoopbackRedirect(u));
    sendHtml(res, 200, renderConsentPage({
      locale,
      hidden: { ...authz.hidden, csrf },
      account,
      clientName: authz.client.client.clientName,
      clientHost: authz.client.clientHost,
      redirectHost: redirectHost(authz.redirectUri),
      loopbackOnly,
      scopes: authz.scopes,
      supportEmail: config.supportEmail
    }), [new URL(authz.redirectUri).origin]);
  }

  async function login(req: IncomingMessage, form: URLSearchParams): Promise<{ account: WebAccount | null; error: MessageKey | null; email: string }> {
    const email = (form.get('email') ?? '').trim().toLowerCase().slice(0, 254);
    const password = form.get('password') ?? '';
    if (!loginLimiter.consume(clientIp(req)).allowed) return { account: null, error: 'errRate', email };
    const creds = email ? await store.findCredentials(email) : null;
    if (!creds || creds.status !== 'active' || (creds.lockedUntilMs !== null && creds.lockedUntilMs > now())) {
      await burnPasswordCheck(password);
      return { account: null, error: 'errBadLogin', email };
    }
    const ok = await verifyPassword(password, creds.passwordHash);
    await store.recordLogin(creds.accountId, ok);
    if (!ok) {
      logger.info('oauth_login_failed', { account_id: creds.accountId });
      return { account: null, error: 'errBadLogin', email };
    }
    return { account: await store.getAccount(creds.accountId), error: null, email };
  }

  async function signup(req: IncomingMessage, form: URLSearchParams): Promise<{ account: WebAccount | null; error: MessageKey | null; email: string }> {
    const email = (form.get('email') ?? '').trim().toLowerCase();
    const password = form.get('password') ?? '';
    const locale: Locale = form.get('locale') === 'vi' ? 'vi' : 'en';
    if (!loginLimiter.consume(clientIp(req)).allowed) return { account: null, error: 'errRate', email };
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { account: null, error: 'errEmail', email };
    if (password.length < 10 || password.length > 200 || password !== (form.get('password_confirm') ?? '')) return { account: null, error: 'errPassword', email };
    if (form.get('accept_terms') !== 'on') return { account: null, error: 'errTerms', email };
    try {
      const account = await store.createAccount({ email, passwordHash: await hashPassword(password), locale });
      logger.info('oauth_account_created', { account_id: account.accountId, tenant_id: account.tenantId, locale });
      return { account, error: null, email };
    } catch (error) {
      if (error instanceof AccountExistsError) return { account: null, error: 'errEmailTaken', email };
      throw error;
    }
  }

  async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === 'GET') {
      const locale = pickLocale(url.searchParams.get('ui_locales'), header(req, 'accept-language'));
      const authz = await parseAuthzRequest(url.searchParams, res, locale);
      if (!authz) return;
      const account = await sessionAccount(req);
      if (account) showConsent(req, res, pickLocale(url.searchParams.get('ui_locales'), account.locale), authz, account);
      else showAuth(req, res, locale, authz, null);
      return;
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    if (mediaType(req) !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'form expected');
    const form = new URLSearchParams(await readBody(req, MAX_FORM_BYTES));
    const locale = pickLocale(form.get('ui_locales') ?? form.get('locale'), header(req, 'accept-language'));
    if (!csrfValid(req, form)) {
      errorPage(res, locale, strings403(locale), 403);
      return;
    }
    const authz = await parseAuthzRequest(form, res, locale);
    if (!authz) return;
    const action = form.get('action') ?? '';

    if (action === 'login' || action === 'signup') {
      const result = action === 'login' ? await login(req, form) : await signup(req, form);
      if (!result.account) {
        showAuth(req, res, locale, authz, result.error, result.email, result.error === 'errRate' ? 429 : result.error === 'errBadLogin' ? 401 : 400);
        return;
      }
      startSession(res, result.account.accountId);
      showConsent(req, res, pickLocale(form.get('ui_locales'), result.account.locale), authz, result.account);
      return;
    }
    if (action === 'switch') {
      endSession(res);
      showAuth(req, res, locale, authz, null);
      return;
    }
    const account = await sessionAccount(req);
    if (!account) {
      showAuth(req, res, locale, authz, null);
      return;
    }
    if (action === 'deny') {
      logger.info('oauth_consent_denied', { account_id: account.accountId, client: authz.client.client.clientId.slice(0, 80) });
      redirectWith(res, authz.redirectUri, { error: 'access_denied', error_description: 'The user denied access.', state: authz.state });
      return;
    }
    if (action !== 'allow') throw new HttpError(400, 'unknown action');
    const granted = authz.scopes.filter((s) => s !== 'shop.write' || form.get('grant_write') === '1');
    if (authz.client.client.registrationType === 'cimd') await store.registerClient(authz.client.client);
    const code = randomToken('svac');
    await store.createCode(sha256Hex(code), {
      clientId: authz.client.client.clientId,
      accountId: account.accountId,
      redirectUri: authz.redirectUri,
      codeChallenge: authz.codeChallenge,
      scopes: granted,
      resource: authz.resource
    }, config.codeTtlSeconds);
    logger.info('oauth_consent_granted', { account_id: account.accountId, scopes: granted.join(' '), registration: authz.client.client.registrationType });
    redirectWith(res, authz.redirectUri, { code, state: authz.state });
  }

  function strings403(locale: Locale): string {
    return locale === 'vi' ? 'Biểu mẫu đã hết hạn. Quay lại, tải lại trang rồi thử lại.' : 'This form expired. Go back, reload the page and try again.';
  }

  // ---- /oauth/token ---------------------------------------------------------
  async function issue(res: ServerResponse, familyId: string, grant: { clientId: string; accountId: string; scopes: readonly string[]; resource: string }, preissued?: { access: string; refresh: string | null }): Promise<void> {
    const access = preissued?.access ?? randomToken('svat');
    const refresh = preissued ? preissued.refresh : grant.scopes.includes('offline_access') ? randomToken('svrt') : null;
    if (!preissued) {
      await store.issueTokens(familyId, grant, {
        accessHash: sha256Hex(access), accessTtlSeconds: config.accessTtlSeconds,
        refreshHash: refresh ? sha256Hex(refresh) : null, refreshTtlSeconds: config.refreshTtlSeconds
      });
    }
    const body: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: config.accessTtlSeconds, scope: grant.scopes.join(' ') };
    if (refresh) body.refresh_token = refresh;
    sendJson(res, 200, body, CORS);
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    if (mediaType(req) !== 'application/x-www-form-urlencoded') {
      oauthError(res, 400, 'invalid_request', 'The token endpoint accepts application/x-www-form-urlencoded bodies only.');
      return;
    }
    const form = new URLSearchParams(await readBody(req, MAX_FORM_BYTES));
    const grantType = form.get('grant_type');
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      oauthError(res, 400, 'unsupported_grant_type', 'Supported grant types are authorization_code and refresh_token.');
      return;
    }
    let client: OAuthClient;
    try {
      client = await authenticateClient(form);
    } catch {
      oauthError(res, 401, 'invalid_client', 'Unknown client_id or wrong client credentials.');
      return;
    }
    const resource = form.get('resource');
    if (resource !== null && resource.replace(/\/+$/, '') !== urls.resource) {
      oauthError(res, 400, 'invalid_target', `This server only issues tokens for ${urls.resource}.`);
      return;
    }

    if (grantType === 'authorization_code') {
      const code = form.get('code') ?? '';
      const redirectUri = form.get('redirect_uri') ?? '';
      const verifier = form.get('code_verifier') ?? '';
      if (!code || !redirectUri || !verifier) {
        oauthError(res, 400, 'invalid_request', 'code, redirect_uri and code_verifier are required.');
        return;
      }
      if (!isValidCodeVerifier(verifier)) {
        oauthError(res, 400, 'invalid_grant', 'The code_verifier is malformed.');
        return;
      }
      const consumed = await store.consumeCode(sha256Hex(code));
      if (consumed.outcome !== 'ok') {
        if (consumed.outcome === 'reused') logger.warn('oauth_code_reused', { client: client.clientId.slice(0, 80) });
        oauthError(res, 400, 'invalid_grant', 'The authorization code is invalid, expired or already used.');
        return;
      }
      const c = consumed.code;
      if (c.clientId !== client.clientId || c.redirectUri !== redirectUri || !verifyPkce(verifier, c.codeChallenge)) {
        oauthError(res, 400, 'invalid_grant', 'The code was issued to a different client or redirect_uri, or the PKCE verifier does not match.');
        return;
      }
      await issue(res, c.familyId, { clientId: c.clientId, accountId: c.accountId, scopes: c.scopes, resource: c.resource });
      return;
    }

    const refresh = form.get('refresh_token') ?? '';
    if (!refresh) {
      oauthError(res, 400, 'invalid_request', 'refresh_token is required.');
      return;
    }
    const access = randomToken('svat');
    const nextRefresh = randomToken('svrt');
    const rotated = await store.rotateRefreshToken(sha256Hex(refresh), client.clientId, {
      accessHash: sha256Hex(access), accessTtlSeconds: config.accessTtlSeconds,
      refreshHash: sha256Hex(nextRefresh), refreshTtlSeconds: config.refreshTtlSeconds
    });
    if (rotated.outcome !== 'ok') {
      if (rotated.outcome === 'reuse') logger.warn('oauth_refresh_reuse_detected', { client: client.clientId.slice(0, 80) });
      oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid, expired, revoked or was already used.');
      return;
    }
    await issue(res, '', { clientId: client.clientId, accountId: rotated.accountId, scopes: rotated.scopes, resource: rotated.resource }, { access, refresh: nextRefresh });
  }

  // ---- /oauth/revoke ----------------------------------------------------------
  async function handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    if (mediaType(req) !== 'application/x-www-form-urlencoded') {
      oauthError(res, 400, 'invalid_request', 'The revocation endpoint accepts application/x-www-form-urlencoded bodies only.');
      return;
    }
    const form = new URLSearchParams(await readBody(req, MAX_FORM_BYTES));
    let client: OAuthClient;
    try {
      client = await authenticateClient(form);
    } catch {
      oauthError(res, 401, 'invalid_client', 'Unknown client_id or wrong client credentials.');
      return;
    }
    const token = form.get('token') ?? '';
    if (token) await store.revokeToken(sha256Hex(token), client.clientId);
    res.writeHead(200, { ...CORS, 'cache-control': 'no-store' });
    res.end();
  }

  // ---- /oauth/register (RFC 7591) ---------------------------------------------
  async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    const ip = clientIp(req);
    const limited = isAnthropicEgress(ip) ? !anthropicDcrLimiter.consume('anthropic').allowed : !dcrLimiter.consume(ip).allowed;
    if (limited) {
      sendJson(res, 429, { error: 'too_many_requests', error_description: 'Too many client registrations from this address; try again later.' }, { ...CORS, 'retry-after': '600' });
      return;
    }
    if (mediaType(req) !== 'application/json') {
      oauthError(res, 400, 'invalid_client_metadata', 'Send the client metadata as application/json.');
      return;
    }
    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readBody(req, MAX_FORM_BYTES)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      meta = parsed as Record<string, unknown>;
    } catch {
      oauthError(res, 400, 'invalid_client_metadata', 'The body must be a JSON object.');
      return;
    }
    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string' && validateRegisteredRedirectUri(u))) {
      oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must list 1-10 https URIs or http loopback URIs, without fragments.');
      return;
    }
    const method = meta.token_endpoint_auth_method ?? 'none';
    if (method !== 'none' && method !== 'client_secret_post') {
      oauthError(res, 400, 'invalid_client_metadata', 'token_endpoint_auth_method must be none or client_secret_post.');
      return;
    }
    const grantTypes = meta.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grantTypes) || !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
      oauthError(res, 400, 'invalid_client_metadata', 'grant_types may only contain authorization_code and refresh_token.');
      return;
    }
    const responseTypes = meta.response_types ?? ['code'];
    if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === 'code')) {
      oauthError(res, 400, 'invalid_client_metadata', 'response_types may only contain code.');
      return;
    }
    const name = typeof meta.client_name === 'string' ? meta.client_name.trim().slice(0, 100) : '';
    const clientId = randomToken('svc', 18);
    const secret = method === 'client_secret_post' ? randomToken('svcs') : null;
    await store.registerClient({
      clientId, clientName: name, redirectUris: uris as string[], tokenEndpointAuthMethod: method,
      clientSecretHash: secret ? sha256Hex(secret) : null, registrationType: 'dcr'
    });
    logger.info('oauth_client_registered', { client_name: name.slice(0, 60), auth_method: method });
    const body: Record<string, unknown> = {
      client_id: clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: method
    };
    if (secret) {
      body.client_secret = secret;
      body.client_secret_expires_at = 0;
    }
    sendJson(res, 201, body, CORS);
  }

  // ---- /account -----------------------------------------------------------------
  async function showAccount(req: IncomingMessage, res: ServerResponse, account: WebAccount, notice: MessageKey | null, error: MessageKey | null, status = 200): Promise<void> {
    const csrf = csrfFor(req, res);
    const grants = await store.listGrants(account.accountId);
    sendHtml(res, status, renderAccountPage({ locale: account.locale, account, grants, csrf, notice, error, supportEmail: config.supportEmail }));
  }

  function showAccountLogin(req: IncomingMessage, res: ServerResponse, locale: Locale, error: MessageKey | null, email = '', status = 200): void {
    const csrf = csrfFor(req, res);
    sendHtml(res, status, renderAuthPage({ locale, action: '/account', hidden: { csrf }, clientLabel: null, error, email, supportEmail: config.supportEmail, langSwitchHref: `/account?ui_locales=${locale === 'vi' ? 'en' : 'vi'}` }));
  }

  function seeOther(res: ServerResponse, location: string): void {
    res.writeHead(303, { location, 'cache-control': 'no-store' });
    res.end();
  }

  async function handleAccount(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const locale = pickLocale(url.searchParams.get('ui_locales'), header(req, 'accept-language'));
    if (req.method === 'GET') {
      const account = await sessionAccount(req);
      const notice = url.searchParams.get('done');
      if (account) await showAccount(req, res, account, notice === 'linked' ? 'linked' : notice === 'revoked' ? 'revoked' : null, null);
      else showAccountLogin(req, res, locale, notice === 'deleted' ? 'deleted' : null);
      return;
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    if (mediaType(req) !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'form expected');
    const form = new URLSearchParams(await readBody(req, MAX_FORM_BYTES));
    if (!csrfValid(req, form)) {
      errorPage(res, locale, strings403(locale), 403);
      return;
    }
    const action = form.get('action') ?? '';
    if (action === 'login' || action === 'signup') {
      const result = action === 'login' ? await login(req, form) : await signup(req, form);
      if (!result.account) {
        showAccountLogin(req, res, locale, result.error, result.email, result.error === 'errRate' ? 429 : result.error === 'errBadLogin' ? 401 : 400);
        return;
      }
      startSession(res, result.account.accountId);
      seeOther(res, '/account');
      return;
    }
    const account = await sessionAccount(req);
    if (!account) {
      showAccountLogin(req, res, locale, null, '', 401);
      return;
    }
    if (action === 'logout') {
      endSession(res);
      seeOther(res, '/account');
      return;
    }
    if (action === 'revoke') {
      await store.revokeGrant(account.accountId, form.get('client_id') ?? '');
      logger.info('oauth_grant_revoked', { account_id: account.accountId });
      seeOther(res, '/account?done=revoked');
      return;
    }
    if (action === 'delete') {
      if ((form.get('confirm_email') ?? '').trim().toLowerCase() !== account.email) {
        await showAccount(req, res, account, null, 'errDeleteConfirm', 400);
        return;
      }
      await store.deleteAccount(account.accountId);
      endSession(res);
      logger.info('oauth_account_deleted', { account_id: account.accountId });
      seeOther(res, '/account?done=deleted');
      return;
    }
    if (action === 'link') {
      const code = (form.get('invite_code') ?? '').trim().slice(0, 40);
      if (!loginLimiter.consume(`link:${account.accountId}`).allowed) {
        await showAccount(req, res, account, null, 'errRate', 429);
        return;
      }
      const result = await store.linkInvite(account.accountId, code);
      if (!result.ok) {
        await showAccount(req, res, account, null, 'errInvite', 400);
        return;
      }
      logger.info('oauth_account_linked', { account_id: account.accountId, tenant_id: result.tenantId });
      seeOther(res, '/account?done=linked');
      return;
    }
    throw new HttpError(400, 'unknown action');
  }

  return {
    urls,
    async handle(req, res, url) {
      const path = url.pathname;
      const isMeta = path === '/.well-known/oauth-protected-resource' || path === `/.well-known/oauth-protected-resource${config.mcpPath}`
        || path === '/.well-known/oauth-authorization-server';
      const isApi = path === '/oauth/token' || path === '/oauth/register' || path === '/oauth/revoke';
      if (!isMeta && !isApi && path !== '/oauth/authorize' && path !== '/account') return false;
      try {
        if ((isMeta || isApi) && req.method === 'OPTIONS') {
          res.writeHead(204, CORS);
          res.end();
          return true;
        }
        if (isMeta) {
          if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
          const doc = path === '/.well-known/oauth-authorization-server' ? authorizationServerMetadata(urls) : protectedResourceMetadata(urls);
          sendJson(res, 200, doc, { ...CORS, 'cache-control': 'public, max-age=300' });
          return true;
        }
        if (path === '/oauth/token') await handleToken(req, res);
        else if (path === '/oauth/register') await handleRegister(req, res);
        else if (path === '/oauth/revoke') await handleRevoke(req, res);
        else if (path === '/oauth/authorize') await handleAuthorize(req, res, url);
        else await handleAccount(req, res, url);
      } catch (error) {
        if (res.headersSent) return true;
        if (error instanceof HttpError) {
          if (isApi) oauthError(res, error.status, error.status === 413 ? 'invalid_request' : 'invalid_request', error.message);
          else errorPage(res, pickLocale(null, header(req, 'accept-language')), `Request rejected: ${error.message}.`, error.status);
        } else {
          logger.error('oauth_handler_error', { path, error: error instanceof Error ? error.message : 'unknown' });
          if (isApi) oauthError(res, 500, 'server_error', 'The authorization server hit an internal error; please retry.');
          else errorPage(res, 'en', 'Something went wrong on our side. Please try again in a minute.', 500);
        }
      }
      return true;
    },
    async resolveAccessToken(token) {
      if (!token.startsWith('svat_')) return null;
      const grant = await store.resolveAccessToken(sha256Hex(token));
      if (!grant || grant.expiresAtMs <= now() || grant.resource !== urls.resource) return null;
      return { tenantId: grant.tenantId, accountId: grant.accountId, clientId: grant.clientId, scopes: new Set(grant.scopes), isSandbox: grant.isSandbox };
    },
    async ensureSandboxFresh(tenantId) {
      const day = SANDBOX_DAY.format(new Date(now())); // the sample shop's own day (America/New_York)
      if (sandboxChecked.get(tenantId) === day) return;
      if (await store.refreshSandbox(tenantId)) logger.info('sandbox_reseeded', { tenant_id: tenantId });
      sandboxChecked.set(tenantId, day);
      if (sandboxChecked.size > 50_000) sandboxChecked.clear();
    },
    async cleanup() {
      const removed = await store.cleanup(config.dcrIdleDays);
      await store.purgeAuditLog(AUDIT_RETENTION_DAYS);
      return removed;
    }
  };
}

/** Anthropic's published egress range for connector traffic: 160.79.104.0/21. */
export function isAnthropicEgress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const m = /^160\.79\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return false;
  const third = Number(m[1]);
  return third >= 104 && third <= 111 && Number(m[2]) <= 255;
}

function safeHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return 'invalid';
  }
}

