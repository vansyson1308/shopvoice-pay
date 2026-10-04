import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, InMemoryTokenBucketRateLimiter } from '../../../packages/common/dist/index.js';
import type { LogLevel, Logger } from '../../../packages/common/dist/index.js';
import { BedrockBrain, RulesBrain } from './brain.js';
import type { Brain } from './brain.js';
import { BrowserSpeech, PollySpeech } from './speech.js';
import type { SpeechClient } from './speech.js';
import { McpToolbox } from './toolbox.js';
import type { Toolbox } from './toolbox.js';
import { newConversation, runTurn } from './agent.js';
import type { Conversation } from './agent.js';

export interface SimConfig {
  readonly host: string;
  readonly port: number;
  readonly mcpUrl: string;
  readonly mcpToken: string;
  readonly brain: 'bedrock' | 'rules';
  readonly bedrockModelId: string;
  readonly awsRegion: string;
  readonly tts: 'polly' | 'browser';
  readonly pollyVoice: string;
  readonly pollyEngine: string;
  readonly accessCode: string;
  readonly turnsPerMinute: number;
  readonly anchorDate: string;
  readonly shopTimezone: string;
  readonly originVerifySecret: string;
}

export function loadSimConfig(env: Record<string, string | undefined>): SimConfig {
  return {
    host: env.SIM_HOST ?? '0.0.0.0',
    port: Number.parseInt(env.SIM_PORT ?? '8091', 10),
    mcpUrl: env.SIM_MCP_URL ?? 'http://127.0.0.1:8090/mcp',
    mcpToken: env.SIM_MCP_TOKEN ?? env.MCP_DEMO_TOKEN ?? '',
    brain: env.SIM_BRAIN === 'bedrock' ? 'bedrock' : 'rules',
    bedrockModelId: env.BEDROCK_MODEL_ID ?? 'us.amazon.nova-2-lite-v1:0',
    awsRegion: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1',
    tts: env.SIM_TTS === 'polly' ? 'polly' : 'browser',
    pollyVoice: env.POLLY_VOICE_ID ?? 'Joanna',
    pollyEngine: env.POLLY_ENGINE ?? 'neural',
    accessCode: env.SIM_ACCESS_CODE ?? '',
    turnsPerMinute: Number.parseInt(env.SIM_TURNS_PER_MINUTE ?? '30', 10) || 30,
    anchorDate: env.DEMO_ANCHOR_DATE ?? '',
    shopTimezone: env.SIM_SHOP_TIMEZONE ?? 'Asia/Ho_Chi_Minh',
    originVerifySecret: env.ORIGIN_VERIFY_SECRET ?? ''
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
}

export function createSimHandler(deps: SimDeps) {
  const { config, logger, toolbox, speech } = deps;
  const conversations = new Map<string, Conversation>();
  const limiter = new InMemoryTokenBucketRateLimiter(config.turnsPerMinute, config.turnsPerMinute);

  function authorized(req: IncomingMessage): boolean {
    if (!config.accessCode) return true;
    return req.headers['x-sim-access'] === config.accessCode;
  }

  function conversationFor(id: unknown): Conversation {
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

  async function serveStatic(res: ServerResponse, path: string): Promise<void> {
    const rel = path === '/' ? 'index.html' : path.replace(/^\/static\//, '');
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

  async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const conversation = conversationFor(body.conversationId);
    const turn = { conversation, userText: text, toolbox, today: shopToday(config), now: Date.now };
    let result;
    let fallback = false;
    try {
      result = await runTurn({ ...turn, brain: deps.brain });
    } catch (error) {
      if (deps.brain.kind === 'rules') throw error;
      // Bedrock unavailable (credentials, throttling): keep the demo alive with the offline brain.
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
    conversations,
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        if (req.method === 'GET' && url.pathname === '/healthz') {
          send(res, 200, { status: 'ok', service: 'alexa-sim' });
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
            const tools = await toolbox.listTools();
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
          if (req.method === 'GET' && url.pathname === '/api/config') {
            send(res, 200, {
              brain: deps.brain.kind, model: deps.brain.model, tts: speech.kind, voice: speech.voice,
              mcpUrl: config.mcpUrl, protocolVersion: toolbox.protocolVersion() ?? null, today: shopToday(config),
              accessCodeRequired: Boolean(config.accessCode)
            });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/turn') return await handleTurn(req, res);
          if (req.method === 'POST' && url.pathname === '/api/tts') return await handleTts(req, res);
          if (req.method === 'POST' && url.pathname === '/api/reset') {
            const body = await readJson(req);
            if (typeof body.conversationId === 'string') conversations.delete(body.conversationId);
            send(res, 200, { ok: true });
            return;
          }
          send(res, 404, { error: 'not_found' });
          return;
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
  const logger = createLogger({ service: 'alexa-sim', level: (process.env.LOG_LEVEL ?? 'info') as LogLevel });
  const config = loadSimConfig(process.env);
  if (config.mcpToken.length < 16) throw new Error('SIM_MCP_TOKEN (the MCP bearer token for the demo tenant) is required');
  const fallbackBrain = new RulesBrain();
  const brain: Brain = config.brain === 'bedrock' ? new BedrockBrain(config.bedrockModelId, config.awsRegion) : fallbackBrain;
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
    console.error(JSON.stringify({ level: 'error', service: 'alexa-sim', message: 'sim_start_failed', error: error instanceof Error ? error.message : 'unknown' }));
    process.exit(1);
  });
}
