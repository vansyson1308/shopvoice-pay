import { spawnSync } from 'node:child_process';

export interface RedisConfig {
  readonly host: string;
  readonly port: number;
  readonly db: number;
  readonly password?: string;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('REDIS_PORT must be a valid TCP port');
  }
  return parsed;
}

function parseDb(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('REDIS_DB must be a non-negative integer');
  }
  return parsed;
}

export function parseRedisUrl(redisUrl: string): RedisConfig {
  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error('REDIS_URL must be a valid URL');
  }

  if (parsed.protocol !== 'redis:') {
    throw new Error('REDIS_URL must use redis:// scheme');
  }

  const host = parsed.hostname || '127.0.0.1';
  const port = parsed.port ? parsePort(parsed.port) : 6379;
  const dbPath = parsed.pathname.replace(/^\//, '');
  const db = dbPath ? parseDb(dbPath) : 0;
  const password = parsed.password || undefined;

  return { host, port, db, ...(password ? { password } : {}) };
}

export function loadRedisConfig(opts?: {
  readonly env?: Record<string, string | undefined>;
  readonly onWarning?: (message: string) => void;
}): RedisConfig {
  const env = opts?.env ?? process.env;

  if (env.REDIS_URL) {
    return parseRedisUrl(env.REDIS_URL);
  }

  const host = env.REDIS_HOST ?? 'redis';
  const port = parsePort(env.REDIS_PORT ?? '6379');
  const db = parseDb(env.REDIS_DB ?? '0');
  const password = env.REDIS_PASSWORD ?? '';

  opts?.onWarning?.('REDIS_URL is not set; using deprecated REDIS_HOST/REDIS_PORT/REDIS_PASSWORD fallback');
  return {
    host,
    port,
    db,
    ...(password ? { password } : {})
  };
}

export function redactRedisUrl(redisUrl: string): string {
  return redisUrl.replace(/(redis:\/\/)([^\s@/]+)@/gi, '$1[REDACTED]@');
}

export async function redisPing(config: RedisConfig, timeoutMs = 500): Promise<boolean> {
  const args = ['-h', config.host, '-p', String(config.port), '-n', String(config.db), '--raw'];
  if (config.password) args.push('-a', config.password);
  args.push('PING');

  const result = spawnSync('redis-cli', args, { encoding: 'utf8', timeout: timeoutMs });
  // redis-cli may return exit code 0 even on auth failures, so check output for
  // both PONG (success) and absence of auth errors before returning true.
  const combinedOutput = `${result.stderr || ''} ${result.stdout || ''}`.toUpperCase();
  if (combinedOutput.includes('NOAUTH') || combinedOutput.includes('WRONGPASS')) {
    return false;
  }
  return result.status === 0 && result.stdout.trim().toUpperCase().includes('PONG');
}
