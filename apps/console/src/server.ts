import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import QRCode from 'qrcode';
import { createLogger, InMemoryTokenBucketRateLimiter } from '../../../packages/common/dist/index.js';
import type { LogLevel, Logger } from '../../../packages/common/dist/index.js';
import { RulesBrain } from './brain.js';
import { ClaudeBrain, claudeClientFromEnv } from './claude-brain.js';
import type { Brain } from './brain.js';
import { BrowserSpeech, PollySpeech } from './speech.js';
import type { SpeechClient } from './speech.js';
import { McpToolbox } from './toolbox.js';
import type { Toolbox } from './toolbox.js';
import { newConversation, runTurn } from './agent.js';
import { createOwnerRoutes } from './owner-routes.js';
import type { Conversation, VoiceApprover } from './agent.js';

export interface SimConfig {
  readonly host: string;
  readonly port: number;
  readonly mcpUrl: string;
  readonly mcpToken: string;
  /** rules (offline), claude-bedrock (Claude in Amazon Bedrock), claude-api (Anthropic API). */
  readonly brain: 'claude-bedrock' | 'claude-api' | 'rules';
  readonly awsRegion: string;
  readonly tts: 'polly' | 'browser';
  readonly pollyVoice: string;
  readonly pollyEngine: string;
  readonly accessCode: string;
  readonly turnsPerMinute: number;
  readonly anchorDate: string;
  readonly shopTimezone: string;
  readonly originVerifySecret: string;
  /** The MCP server's owner API (console screens, PayPal returns). Derived from mcpUrl when unset. */
  readonly ownerApiUrl: string;
  /**
   * When set, every visitor gets a private sample shop ("Try the demo"),
   * created on the MCP server with this shared secret. Unset: one shared shop
   * (SIM_MCP_TOKEN).
   */
  readonly demoProvisionSecret: string;
  readonly demoProvisionUrl: string;
  /** Mark the session cookie Secure (behind HTTPS). */
  readonly secureCookies: boolean;
}

function brainKind(value: string | undefined): SimConfig['brain'] {
  if (value === 'claude-api') return 'claude-api';
  if (value === 'claude-bedrock' || value === 'bedrock' || value === 'claude') return 'claude-bedrock';
  return 'rules';
}

export function loadSimConfig(env: Record<string, string | undefined>): SimConfig {
  return {
    host: env.SIM_HOST ?? '0.0.0.0',
    port: Number.parseInt(env.SIM_PORT ?? '8091', 10),
    mcpUrl: env.SIM_MCP_URL ?? 'http://127.0.0.1:8090/mcp',
    mcpToken: env.SIM_MCP_TOKEN ?? env.MCP_DEMO_TOKEN ?? '',
    brain: brainKind(env.BRAIN ?? env.SIM_BRAIN),
    awsRegion: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1',
    tts: env.SIM_TTS === 'polly' ? 'polly' : 'browser',
    pollyVoice: env.POLLY_VOICE_ID ?? 'Joanna',
    pollyEngine: env.POLLY_ENGINE ?? 'neural',
    accessCode: env.SIM_ACCESS_CODE ?? '',
    turnsPerMinute: Number.parseInt(env.SIM_TURNS_PER_MINUTE ?? '30', 10) || 30,
    anchorDate: env.DEMO_ANCHOR_DATE ?? '',
    shopTimezone: env.SIM_SHOP_TIMEZONE ?? 'America/New_York',
    originVerifySecret: env.ORIGIN_VERIFY_SECRET ?? '',
    ownerApiUrl: env.SIM_OWNER_API_URL ?? new URL('/owner/api', env.SIM_MCP_URL ?? 'http://127.0.0.1:8090/mcp').href,
    demoProvisionSecret: env.DEMO_PROVISION_SECRET ?? '',
    demoProvisionUrl: new URL('/owner/demo-shops', env.SIM_MCP_URL ?? 'http://127.0.0.1:8090/mcp').href,
    secureCookies: env.SIM_SECURE_COOKIES === 'true'
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'permissions-policy': 'microphone=(self)'
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

/**
 * The console page carries a fresh nonce: AG Grid injects its <style> elements
 * with it, so style elements stay strict. AG Grid's templates also carry
 * inline style attributes (sizes, CSS variables), which a nonce cannot cover;
 * only those are allowed. Scripts remain same-origin only.
 */
export function pageCsp(nonce: string): string {
  return `default-src 'self'; media-src 'self' blob:; img-src 'self' data:; style-src 'self' 'nonce-${nonce}'; style-src-elem 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`;
}

const requireFromHere = createRequire(import.meta.url);
/** AG Grid Community (MIT) browser bundle, served from our own origin. The noStyle build: the Theming API injects the theme CSS with our nonce; the legacy theme CSS in the default build would be injected without it. */
export function agGridBundlePath(): string {
  return join(dirname(requireFromHere.resolve('ag-grid-community')), '..', 'ag-grid-community.min.noStyle.js');
}

/** QR codes only for PayPal's approval pages, or the console's own simulated PayPal page. */
export function qrAllowed(target: string): boolean {
  try {
    const u = new URL(target, 'http://console.local');
    if (u.origin === 'http://console.local') return u.pathname.startsWith('/sim/paypal/');
    return u.protocol === 'https:' && (u.hostname === 'www.sandbox.paypal.com' || u.hostname === 'sandbox.paypal.com');
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage, max = 16_384): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) throw new Error('body_too_large');
    chunks.push(buf);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json');
  return parsed as Record<string, unknown>;
}

function shopToday(config: SimConfig): string {
  if (config.anchorDate) return config.anchorDate;
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.shopTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export interface SimDeps {
  readonly config: SimConfig;
  readonly logger: Logger;
  readonly toolbox: Toolbox;
  readonly brain: Brain;
  readonly fallbackBrain: Brain;
  readonly speech: SpeechClient;
  readonly staticDir: string;
  /** Test seam for the owner API calls. */
  readonly fetch?: Parameters<typeof createOwnerRoutes>[2];
  /** MCP connection for a visitor's shop token (visitor mode). */
  readonly toolboxFor?: (token: string) => Toolbox;
}

/** One shop as seen by one browser: its MCP credential and connection, and its conversations. */
interface ShopSession {
  readonly id: string;
  readonly token: string;
  readonly toolbox: Toolbox;
  readonly conversations: Map<string, Conversation>;
  lastSeenMs: number;
}

const SESSION_COOKIE = 'svc_sid';
const SESSION_IDLE_MS = 4 * 3600_000;
const MAX_VISITOR_SESSIONS = 1000;

function cookieValue(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function createSimHandler(deps: SimDeps) {
  const { config, logger, speech } = deps;
  const visitorMode = config.demoProvisionSecret.length > 0;
  const shared: ShopSession = { id: 'shared', token: config.mcpToken, toolbox: deps.toolbox, conversations: new Map(), lastSeenMs: Date.now() };
  const visitors = new Map<string, ShopSession>();
  const limiter = new InMemoryTokenBucketRateLimiter(config.turnsPerMinute, config.turnsPerMinute);
  // New visitor shops: a burst of 3 per IP, then one every 10 minutes.
  const newShopLimiter = new InMemoryTokenBucketRateLimiter(3, 0.1);
  const originHeaders: Record<string, string> = config.originVerifySecret ? { 'x-origin-verify': config.originVerifySecret } : {};
  const owner = createOwnerRoutes({ ownerApiUrl: config.ownerApiUrl, ...(config.originVerifySecret ? { extraHeaders: originHeaders } : {}) }, logger, deps.fetch);
  const toolboxFor = deps.toolboxFor ?? ((token: string) => new McpToolbox(config.mcpUrl, token, originHeaders));
  const fetchImpl = (deps.fetch ?? fetch) as NonNullable<SimDeps['fetch']>;

  function authorized(req: IncomingMessage): boolean {
    if (!config.accessCode) return true;
    return req.headers['x-sim-access'] === config.accessCode;
  }

  function sweepSessions(now: number): void {
    for (const [id, s] of visitors) {
      if (now - s.lastSeenMs > SESSION_IDLE_MS) {
        visitors.delete(id);
        void s.toolbox.close().catch(() => {});
      }
    }
  }

  /** The caller's shop: the shared one, or (visitor mode) the one bound to the session cookie. */
  function sessionFor(req: IncomingMessage): ShopSession | null {
    if (!visitorMode) return shared;
    const id = cookieValue(req, SESSION_COOKIE);
    const session = id ? visitors.get(id) : undefined;
    if (!session) return null;
    session.lastSeenMs = Date.now();
    return session;
  }

  async function startSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!visitorMode) {
      send(res, 200, { mode: 'shared', ready: true });
      return;
    }
    if (sessionFor(req)) {
      send(res, 200, { mode: 'visitor', ready: true });
      return;
    }
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!newShopLimiter.consume(ip).allowed) {
      send(res, 429, { error: 'rate_limited', message: 'Too many new demo shops from this address. Try again in a few minutes.' });
      return;
    }
    const now = Date.now();
    sweepSessions(now);
    if (visitors.size >= MAX_VISITOR_SESSIONS) {
      send(res, 503, { error: 'busy', message: 'The demo is busy right now. Try again shortly.' });
      return;
    }
    const upstream = await fetchImpl(config.demoProvisionUrl, {
      method: 'POST',
      headers: { ...originHeaders, 'x-demo-provision-secret': config.demoProvisionSecret, 'content-type': 'application/json' },
      body: '{}'
    });
    const body = JSON.parse((await upstream.text()) || '{}') as { token?: unknown };
    if (upstream.status !== 201 || typeof body.token !== 'string') {
      logger.warn('console_demo_shop_failed', { status: upstream.status });
      send(res, upstream.status === 429 ? 429 : 502, { error: 'demo_unavailable', message: 'Could not create your demo shop. Try again shortly.' });
      return;
    }
    const id = randomBytes(32).toString('base64url');
    visitors.set(id, { id, token: body.token, toolbox: toolboxFor(body.token), conversations: new Map(), lastSeenMs: now });
    const cookie = `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_IDLE_MS / 1000)}${config.secureCookies ? '; Secure' : ''}`;
    send(res, 201, { mode: 'visitor', ready: true }, { 'set-cookie': cookie });
  }

  function conversationFor(session: ShopSession, id: unknown): Conversation {
    const conversations = session.conversations;
    const now = Date.now();
    for (const [key, c] of conversations) if (now - c.lastSeenMs > 30 * 60_000) conversations.delete(key);
    if (typeof id === 'string' && conversations.has(id)) return conversations.get(id) as Conversation;
    if (conversations.size >= 200) {
      const oldest = [...conversations.values()].sort((a, b) => a.lastSeenMs - b.lastSeenMs)[0];
      if (oldest) conversations.delete(oldest.id);
    }
    const c = newConversation(randomUUID(), now);
    conversations.set(c.id, c);
    return c;
  }

  let gridBundle: Buffer | null = null;

  async function serveStatic(res: ServerResponse, path: string): Promise<void> {
    if (path === '/static/vendor/ag-grid-community.min.js') {
      gridBundle ??= await readFile(agGridBundlePath());
      res.writeHead(200, { 'content-type': MIME['.js'] ?? 'text/javascript', 'cache-control': 'public, max-age=86400', ...SECURITY_HEADERS });
      res.end(gridBundle);
      return;
    }
    if (path === '/') {
      const nonce = randomBytes(16).toString('base64');
      const html = (await readFile(join(deps.staticDir, 'index.html'), 'utf8')).replaceAll('__CSP_NONCE__', nonce);
      res.writeHead(200, { 'content-type': MIME['.html'] ?? 'text/html', 'cache-control': 'no-store', ...SECURITY_HEADERS, 'content-security-policy': pageCsp(nonce) });
      res.end(html);
      return;
    }
    const rel = path.replace(/^\/static\//, '');
    const file = normalize(join(deps.staticDir, rel));
    if (!file.startsWith(deps.staticDir) || rel.includes('\0')) {
      send(res, 404, { error: 'not_found' });
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      res.end(body);
    } catch {
      send(res, 404, { error: 'not_found' });
    }
  }

  async function handleTurn(session: ShopSession, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!limiter.consume(ip).allowed) {
      send(res, 429, { error: 'rate_limited', reply: 'One moment please, too many requests.' });
      return;
    }
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      send(res, 400, { error: 'text_required' });
      return;
    }
    const conversation = conversationFor(session, body.conversationId);
    const approver: VoiceApprover = {
      async approve(paymentId) {
        const r = await owner.api(session.token, 'POST', `/approvals/${encodeURIComponent(paymentId)}/approve`, { via: 'voice' });
        if (r.status !== 200) return { ok: false, speech: `I couldn't approve it: ${String(r.json.message ?? 'it is no longer waiting')}.`.replace(/\.\.$/, '.'), payment: null };
        return { ok: true, speech: String(r.json.speech ?? 'Approved.'), payment: (r.json.payment ?? null) as Record<string, unknown> | null };
      },
      async decline(paymentId) {
        const r = await owner.api(session.token, 'POST', `/approvals/${encodeURIComponent(paymentId)}/decline`, {});
        const payment = (r.json.payment ?? null) as Record<string, unknown> | null;
        if (r.status !== 200) return { ok: false, speech: `I couldn't change it: ${String(r.json.message ?? 'it is no longer waiting')}.`.replace(/\.\.$/, '.'), payment: null };
        return { ok: true, speech: `Okay, I left the ${String(payment?.supplier_name ?? 'supplier')} order unpaid. Nothing was charged.`, payment };
      }
    };
    const turn = { conversation, userText: text, toolbox: session.toolbox, today: shopToday(config), now: Date.now, approver };
    let result;
    let fallback = false;
    try {
      result = await runTurn({ ...turn, brain: deps.brain });
    } catch (error) {
      if (deps.brain.kind === 'rules') throw error;
      // Claude unavailable (credentials, throttling): keep the demo alive with the offline brain (labelled in the reply).
      logger.warn('sim_brain_fallback', { error: error instanceof Error ? error.name : 'unknown' });
      conversation.messages = [];
      result = await runTurn({ ...turn, brain: deps.fallbackBrain });
      fallback = true;
    }
    logger.info('sim_turn', {
      conversation_id: conversation.id,
      tools: result.toolCalls.map((t) => t.name),
      total_ms: result.totalLatencyMs,
      brain: result.brain.kind
    });
    send(res, 200, { conversationId: conversation.id, ...result, brainFallback: fallback });
  }

  async function handleTts(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
    if (!text) {
      send(res, 400, { error: 'text_required' });
      return;
    }
    try {
      const audio = await speech.synthesize(text);
      if (!audio) {
        send(res, 204, {});
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', ...SECURITY_HEADERS });
      res.end(Buffer.from(audio));
    } catch (error) {
      logger.warn('sim_tts_fallback', { error: error instanceof Error ? error.name : 'unknown' });
      send(res, 204, {});
    }
  }

  return {
    conversations: shared.conversations,
    visitorSessions: () => visitors.size,
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        if (req.method === 'GET' && url.pathname === '/healthz') {
          send(res, 200, { status: 'ok', service: 'console' });
          return;
        }
        if (config.originVerifySecret) {
          const given = req.headers['x-origin-verify'];
          const value = Array.isArray(given) ? given[0] ?? '' : given ?? '';
          const ok = timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(config.originVerifySecret).digest());
          if (!ok) {
            send(res, 403, { error: 'forbidden' });
            return;
          }
        }
        if (req.method === 'GET' && url.pathname === '/readyz') {
          try {
            if (visitorMode && !config.mcpToken) {
              const up = await fetchImpl(new URL('/healthz', config.mcpUrl).href, { method: 'GET', headers: originHeaders });
              if (up.status !== 200) throw new Error('mcp_unhealthy');
              send(res, 200, { status: 'ready', mode: 'visitor' });
              return;
            }
            const tools = await deps.toolbox.listTools();
            send(res, 200, { status: 'ready', tools: tools.length });
          } catch {
            send(res, 503, { status: 'not_ready', checks: { mcp: 'fail' } });
          }
          return;
        }
        if (url.pathname.startsWith('/api/')) {
          if (!authorized(req)) {
            send(res, 401, { error: 'access_code_required' });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/session') return await startSession(req, res);
          if (req.method === 'GET' && url.pathname === '/api/qr') {
            const target = url.searchParams.get('url') ?? '';
            if (!qrAllowed(target) || target.length > 2000) {
              send(res, 400, { error: 'unsupported_url' });
              return;
            }
            const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
            res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', ...SECURITY_HEADERS });
            res.end(svg);
            return;
          }
          const session = sessionFor(req);
          if (req.method === 'GET' && url.pathname === '/api/config') {
            send(res, 200, {
              brain: deps.brain.kind, model: deps.brain.model, tts: speech.kind, voice: speech.voice,
              mcpUrl: config.mcpUrl, protocolVersion: session?.toolbox.protocolVersion() ?? null, today: shopToday(config),
              accessCodeRequired: Boolean(config.accessCode), mode: visitorMode ? 'visitor' : 'shared', hasShop: !!session
            });
            return;
          }
          if (!session) {
            send(res, 401, { error: 'no_session', message: 'Start the demo first (Try the demo).' });
            return;
          }
          if (url.pathname.startsWith('/api/owner/')) {
            const status = await owner.proxy(session.token, req, res, url);
            // A reset shop starts a fresh conversation, too.
            if (status === 200 && url.pathname === '/api/owner/demo/reset') session.conversations.clear();
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/turn') return await handleTurn(session, req, res);
          if (req.method === 'POST' && url.pathname === '/api/tts') return await handleTts(req, res);
          if (req.method === 'POST' && url.pathname === '/api/reset') {
            const body = await readJson(req);
            if (typeof body.conversationId === 'string') session.conversations.delete(body.conversationId);
            send(res, 200, { ok: true });
            return;
          }
          send(res, 404, { error: 'not_found' });
          return;
        }
        if (owner.isPublicPath(url.pathname)) {
          const session = sessionFor(req);
          if (!session) {
            res.writeHead(303, { location: '/', ...SECURITY_HEADERS });
            res.end();
            return;
          }
          if (await owner.handlePublic(session.token, req, res, url)) return;
        }
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/static/'))) {
          await serveStatic(res, url.pathname);
          return;
        }
        send(res, 404, { error: 'not_found' });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown';
        if (message === 'body_too_large' || message === 'invalid_json' || error instanceof SyntaxError) {
          send(res, 400, { error: 'bad_request' });
          return;
        }
        logger.error('sim_request_failed', { path: url.pathname, error: message });
        send(res, 502, { error: 'upstream_failed', reply: "Sorry, I couldn't reach the shop just now. Please try again." });
      }
    }
  };
}

async function main(): Promise<void> {
  const logger = createLogger({ service: 'console', level: (process.env.LOG_LEVEL ?? 'info') as LogLevel });
  const config = loadSimConfig(process.env);
  if (config.mcpToken.length < 16 && !config.demoProvisionSecret) throw new Error('SIM_MCP_TOKEN (the MCP bearer token for the demo tenant) or DEMO_PROVISION_SECRET (a shop per visitor) is required');
  const fallbackBrain = new RulesBrain();
  let brain: Brain = fallbackBrain;
  if (config.brain !== 'rules') {
    const { client, config: claude } = claudeClientFromEnv({ ...process.env, BRAIN: config.brain });
    brain = new ClaudeBrain(client, claude);
  }
  const speech: SpeechClient = config.tts === 'polly' ? new PollySpeech(config.pollyVoice, config.awsRegion, config.pollyEngine) : new BrowserSpeech();
  const toolbox = new McpToolbox(config.mcpUrl, config.mcpToken, config.originVerifySecret ? { 'x-origin-verify': config.originVerifySecret } : {});
  const staticDir = fileURLToPath(new URL('../static/', import.meta.url));
  const handler = createSimHandler({ config, logger, toolbox, brain, fallbackBrain, speech, staticDir });
  const server = createServer((req, res) => {
    void handler.handle(req, res);
  });
  server.listen(config.port, config.host, () => {
    logger.info('sim_listening', { port: config.port, brain: brain.kind, model: brain.model, tts: speech.kind, mcp_url: config.mcpUrl });
  });
  const shutdown = () => {
    server.close();
    void toolbox.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'error', service: 'console', message: 'sim_start_failed', error: error instanceof Error ? error.message : 'unknown' }));
    process.exit(1);
  });
}
