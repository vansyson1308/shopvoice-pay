import { trustedProxyHops } from '../../../packages/common/dist/index.js';

export interface McpServerConfig {
  readonly host: string;
  readonly port: number;
  readonly mcpPath: string;
  readonly databaseUrl: string;
  readonly dataBackend: 'postgres' | 'memory';
  readonly allowedOrigins: readonly string[];
  readonly allowLocalhostOrigins: boolean;
  /** X-Forwarded-For entry (from the right) that is the viewer; 0 = ignore the header. */
  readonly trustProxy: number;
  readonly rateLimitPerMinute: number;
  readonly authFailuresPerMinute: number;
  readonly confirmTtlSeconds: number;
  readonly sessionIdleSeconds: number;
  readonly maxSessions: number;
  readonly maxBodyBytes: number;
  readonly tokenCacheSeconds: number;
  readonly jsonResponses: boolean;
  /** How long a tool waits for the owner's answer in an MCP client's confirmation form. */
  readonly elicitationTimeoutMs: number;
  /** Shared with the console: lets it create "Try the demo" visitor shops. Empty = disabled. */
  readonly demoProvisionSecret: string;
  /** When set, every request except /healthz must carry X-Origin-Verify with this value (added by CloudFront). */
  readonly originVerifySecret: string;
  /** Public origin (https://host) that serves /mcp, /.well-known/* and /oauth/*; empty disables OAuth. */
  readonly publicBaseUrl: string;
  readonly oauthCookieSecret: string;
  readonly oauthAccessTtlSeconds: number;
  readonly oauthRefreshTtlSeconds: number;
  readonly oauthCodeTtlSeconds: number;
  readonly oauthDcrPerHour: number;
  readonly oauthLoginPerMinute: number;
  readonly oauthDcrIdleDays: number;
  /** Base64 invite pepper, shared with the gateway; enables linking a web account to a real shop. */
  readonly invitePepperB64: string;
  readonly supportEmail: string;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

/**
 * Hosts that hand out the database address and password separately (a Render
 * blueprint) set MCP_DB_HOST, MCP_DB_PORT, MCP_DB_NAME, MCP_DB_USER and MCP_DB_PASSWORD.
 */
export function databaseUrlFromParts(env: Record<string, string | undefined>): string {
  const host = env.MCP_DB_HOST ?? '';
  const user = env.MCP_DB_USER ?? '';
  if (!host || !user) return '';
  const port = env.MCP_DB_PORT || '5432';
  const name = env.MCP_DB_NAME || 'shopvoice';
  const password = env.MCP_DB_PASSWORD ? `:${encodeURIComponent(env.MCP_DB_PASSWORD)}` : '';
  return `postgresql://${encodeURIComponent(user)}${password}@${host}:${port}/${encodeURIComponent(name)}`;
}

export function loadMcpServerConfig(env: Record<string, string | undefined>): McpServerConfig {
  const backend = env.MCP_DATA_BACKEND === 'memory' ? 'memory' : 'postgres';
  const databaseUrl = env.MCP_DB_URL || env.DB_APP_URL || env.DATABASE_URL || databaseUrlFromParts(env);
  if (backend === 'postgres' && !databaseUrl) {
    throw new Error('MCP_DB_URL (or DB_APP_URL / DATABASE_URL, or MCP_DB_HOST + MCP_DB_USER + MCP_DB_PASSWORD) is required when MCP_DATA_BACKEND=postgres');
  }
  const production = env.NODE_ENV === 'production';
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (publicBaseUrl) {
    let url: URL;
    try {
      url = new URL(publicBaseUrl);
    } catch {
      throw new Error('PUBLIC_BASE_URL must be an absolute URL such as https://shopvoice.example.com');
    }
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !production)) {
      throw new Error('PUBLIC_BASE_URL must use https (http is allowed only for localhost outside production)');
    }
    if (url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_BASE_URL must be an origin without a path');
  }
  const cookieSecret = env.OAUTH_COOKIE_SECRET ?? '';
  if (publicBaseUrl && cookieSecret.length < 32) {
    throw new Error('OAUTH_COOKIE_SECRET (>= 32 random characters) is required when PUBLIC_BASE_URL is set');
  }
  return {
    host: env.MCP_HOST ?? '0.0.0.0',
    port: int(env.MCP_PORT, 8090, 1, 65535),
    mcpPath: '/mcp',
    databaseUrl,
    dataBackend: backend,
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    allowLocalhostOrigins: bool(env.MCP_ALLOW_LOCALHOST_ORIGINS, !production),
    trustProxy: trustedProxyHops(env.MCP_TRUST_PROXY),
    rateLimitPerMinute: int(env.MCP_RATE_LIMIT_PER_MINUTE, 120, 1, 100_000),
    authFailuresPerMinute: int(env.MCP_AUTH_FAILURES_PER_MINUTE, 20, 1, 10_000),
    confirmTtlSeconds: int(env.MCP_CONFIRM_TTL_SECONDS, 300, 10, 3600),
    sessionIdleSeconds: int(env.MCP_SESSION_IDLE_SECONDS, 1800, 30, 86_400),
    maxSessions: int(env.MCP_MAX_SESSIONS, 500, 1, 100_000),
    maxBodyBytes: int(env.MCP_MAX_BODY_BYTES, 262_144, 1024, 4_194_304),
    tokenCacheSeconds: int(env.MCP_TOKEN_CACHE_SECONDS, 30, 0, 3600),
    jsonResponses: bool(env.MCP_JSON_RESPONSES, true),
    elicitationTimeoutMs: int(env.MCP_ELICITATION_TIMEOUT_MS, 120_000, 5_000, 600_000),
    demoProvisionSecret: env.DEMO_PROVISION_SECRET ?? '',
    originVerifySecret: env.ORIGIN_VERIFY_SECRET ?? '',
    publicBaseUrl,
    oauthCookieSecret: cookieSecret,
    oauthAccessTtlSeconds: int(env.OAUTH_ACCESS_TTL_SECONDS, 3600, 300, 86_400),
    oauthRefreshTtlSeconds: int(env.OAUTH_REFRESH_TTL_DAYS, 30, 1, 90) * 86_400,
    oauthCodeTtlSeconds: 60,
    oauthDcrPerHour: int(env.OAUTH_DCR_PER_HOUR, 30, 1, 10_000),
    oauthLoginPerMinute: int(env.OAUTH_LOGIN_PER_MINUTE, 20, 1, 1000),
    oauthDcrIdleDays: 30,
    invitePepperB64: env.INVITE_PEPPER_B64 ?? '',
    supportEmail: env.SUPPORT_EMAIL ?? ''
  };
}
