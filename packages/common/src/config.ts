import type { RuntimeEnvironment, TelegramConfig, TelegramMode } from './types.js';

export interface BaseConfig {
  readonly nodeEnv: RuntimeEnvironment;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly port: number;
  readonly host: string;
}

export interface GatewayConfig extends BaseConfig {
  readonly telegram: TelegramConfig;
}

export interface DatabaseConfig {
  readonly dbAppUrl: string;
  readonly dbAdminUrl: string;
  readonly dbStatementTimeoutMs: number;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parsePort(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${field} must be a valid TCP port, received: ${value}`);
  }

  return parsed;
}

function parseEnv(value: string | undefined): RuntimeEnvironment {
  const env = value ?? 'development';
  if (env === 'development' || env === 'test' || env === 'production') {
    return env;
  }

  throw new Error(`NODE_ENV must be one of development|test|production, received: ${env}`);
}

function parseLogLevel(value: string | undefined): BaseConfig['logLevel'] {
  const level = value ?? 'info';
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
    return level;
  }

  throw new Error(`LOG_LEVEL must be one of debug|info|warn|error, received: ${level}`);
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value === 'true';
}

function parsePositiveInt(value: string | undefined, field: string, fallback: number): number {
  const resolved = value ?? String(fallback);
  const parsed = Number(resolved);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer, received: ${resolved}`);
  }
  return parsed;
}

function parseTelegramMode(value: string | undefined): TelegramMode {
  const mode = value ?? 'polling';
  if (mode === 'polling' || mode === 'webhook') {
    return mode;
  }

  throw new Error(`TELEGRAM_MODE must be one of polling|webhook, received: ${mode}`);
}

function parseDbUrl(value: string, field: 'DB_APP_URL' | 'DB_ADMIN_URL'): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${field} must use postgres:// or postgresql:// protocol`);
  }

  return value;
}

export function loadDatabaseConfig(envInput?: Record<string, string | undefined>): DatabaseConfig {
  const env = envInput ?? process.env;
  const dbAppUrl = parseDbUrl(required('DB_APP_URL', env.DB_APP_URL), 'DB_APP_URL');
  const dbAdminUrl = parseDbUrl(required('DB_ADMIN_URL', env.DB_ADMIN_URL), 'DB_ADMIN_URL');

  return {
    dbAppUrl,
    dbAdminUrl,
    dbStatementTimeoutMs: parsePositiveInt(env.DB_STATEMENT_TIMEOUT_MS, 'DB_STATEMENT_TIMEOUT_MS', 5000)
  };
}

export function loadBaseConfig(opts: {
  readonly serviceName: 'gateway' | 'admin' | 'worker';
  readonly env?: Record<string, string | undefined>;
  readonly defaultPort: number;
  readonly defaultHost: string;
}): BaseConfig {
  const env = opts.env ?? process.env;

  const portVar = `${opts.serviceName.toUpperCase()}_PORT`;
  const hostVar = `${opts.serviceName.toUpperCase()}_HOST`;

  const port = parsePort(env[portVar] ?? String(opts.defaultPort), portVar);
  const host = env[hostVar] ?? opts.defaultHost;
  required(hostVar, host);

  return {
    nodeEnv: parseEnv(env.NODE_ENV),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    port,
    host
  };
}

export function loadGatewayConfig(envInput?: Record<string, string | undefined>): GatewayConfig {
  const env = envInput ?? process.env;
  const base = loadBaseConfig({
    serviceName: 'gateway',
    defaultHost: '0.0.0.0',
    defaultPort: 3000,
    env
  });

  const botToken = env.TELEGRAM_BOT_TOKEN ?? '';
  const mode = parseTelegramMode(env.TELEGRAM_MODE);

  return {
    ...base,
    telegram: {
      botToken,
      mode,
      ...(env.TELEGRAM_WEBHOOK_SECRET ? { webhookSecret: env.TELEGRAM_WEBHOOK_SECRET } : {}),
      ...(env.TELEGRAM_WEBHOOK_URL ? { webhookUrl: env.TELEGRAM_WEBHOOK_URL } : {})
    }
  };
}
