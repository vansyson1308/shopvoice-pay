import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export interface RedisConnection {
  host: string;
  port: number;
  db?: number;
  password?: string;
}

type BackoffOption = number | { type?: 'fixed' | 'exponential'; delay?: number };

interface JobOptions {
  attempts?: number;
  backoff?: BackoffOption;
  removeOnComplete?: number | boolean;
  removeOnFail?: number | boolean;
}

interface StoredJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  attemptsMade: number;
  opts: {
    attempts: number;
    backoff?: BackoffOption;
  };
}

function redisArgs(connection: RedisConnection): string[] {
  const args = ['-h', connection.host, '-p', String(connection.port), '-n', String(connection.db ?? 0), '--raw'];
  if (connection.password) args.push('--pass', connection.password);
  args.push('--no-auth-warning');
  return args;
}

function runRedis(connection: RedisConnection, ...command: string[]): string {
  const result = spawnSync('redis-cli', [...redisArgs(connection), ...command], { encoding: 'utf8', stdio: 'pipe' });
  const combinedOutput = `${result.stderr || ''} ${result.stdout || ''}`.toUpperCase();
  if (combinedOutput.includes('NOAUTH') || combinedOutput.includes('WRONGPASS')) {
    throw new Error('queue_auth_error');
  }
  if (result.status !== 0) {
    throw new Error('queue_error');
  }
  return result.stdout;
}

function ensureStoredJob(payload: string): StoredJob {
  const parsed = JSON.parse(payload) as Partial<StoredJob> & { data?: Record<string, unknown> };
  const optsAttempts = parsed.opts?.attempts;
  return {
    id: typeof parsed.id === 'string' && parsed.id ? parsed.id : randomUUID(),
    name: typeof parsed.name === 'string' && parsed.name ? parsed.name : 'UNKNOWN_JOB',
    data: parsed.data ?? {},
    attemptsMade: Number.isInteger(parsed.attemptsMade) && (parsed.attemptsMade ?? 0) >= 0 ? (parsed.attemptsMade as number) : 0,
    opts: {
      attempts: Number.isInteger(optsAttempts) && (optsAttempts ?? 0) > 0 ? (optsAttempts as number) : 1,
      ...(parsed.opts?.backoff ? { backoff: parsed.opts.backoff } : {})
    }
  };
}

function computeBackoffMs(backoff: BackoffOption | undefined, attemptsMade: number): number {
  if (backoff === undefined) return 0;
  if (typeof backoff === 'number') return Math.max(0, backoff);

  const delay = Math.max(0, backoff.delay ?? 0);
  if ((backoff.type ?? 'fixed') === 'exponential') {
    const exponent = Math.max(0, attemptsMade - 1);
    return delay * (2 ** exponent);
  }
  return delay;
}

export class Queue {
  constructor(private readonly queueName: string, private readonly opts: { connection: RedisConnection }) {}

  async add(name: string, data: Record<string, unknown>, opts?: JobOptions): Promise<void> {
    const job: StoredJob = {
      id: randomUUID(),
      name,
      data,
      attemptsMade: 0,
      opts: {
        attempts: Math.max(1, Number(opts?.attempts ?? 1)),
        ...(opts?.backoff !== undefined ? { backoff: opts.backoff } : {})
      }
    };

    const payload = JSON.stringify(job);
    runRedis(this.opts.connection, 'RPUSH', `bull-${this.queueName}-wait`, payload);
  }
}

export class Worker {
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  private stopped = false;

  constructor(
    private readonly queueName: string,
    private readonly processor: (job: { data: unknown; attemptsMade?: number; opts?: { attempts?: number } }) => Promise<void>,
    private readonly opts: { connection: RedisConnection; concurrency?: number }
  ) {
    void this.loop();
  }

  on(event: 'failed' | 'error', handler: (...args: unknown[]) => void) {
    this.handlers[event] = this.handlers[event] ?? [];
    this.handlers[event]?.push(handler);
  }

  async waitUntilReady(): Promise<void> {
    const ping = spawnSync('redis-cli', [...redisArgs(this.opts.connection), 'PING'], { encoding: 'utf8' });
    const combinedOutput = `${ping.stderr || ''} ${ping.stdout || ''}`.toUpperCase();
    if (combinedOutput.includes('NOAUTH') || combinedOutput.includes('WRONGPASS')) {
      throw new Error('redis_auth_error');
    }
    if (ping.status !== 0) throw new Error('redis_unavailable');
  }

  private emit(event: 'failed' | 'error', ...args: unknown[]) {
    for (const handler of this.handlers[event] ?? []) {
      handler(...args);
    }
  }

  private promoteDelayedJobs(now: number): void {
    const delayedKey = `bull-${this.queueName}-delayed`;
    const waitKey = `bull-${this.queueName}-wait`;
    const dueRaw = runRedis(this.opts.connection, 'ZRANGEBYSCORE', delayedKey, '-inf', String(now));
    const due = dueRaw.split('\n').map((x) => x.trim()).filter(Boolean);
    for (const jobPayload of due) {
      runRedis(this.opts.connection, 'ZREM', delayedKey, jobPayload);
      runRedis(this.opts.connection, 'RPUSH', waitKey, jobPayload);
    }
  }

  private async loop() {
    while (!this.stopped) {
      try {
        this.promoteDelayedJobs(Date.now());

        const result = spawnSync('redis-cli', [...redisArgs(this.opts.connection), 'BRPOP', `bull-${this.queueName}-wait`, '1'], { encoding: 'utf8' });
        const loopOutput = `${result.stderr || ''} ${result.stdout || ''}`.toUpperCase();
        if (loopOutput.includes('NOAUTH') || loopOutput.includes('WRONGPASS')) {
          this.emit('error', new Error('worker_queue_auth_error'));
          continue;
        }
        if (result.status !== 0) {
          this.emit('error', new Error('worker_queue_error'));
          continue;
        }

        const lines = result.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
        const payload = lines.at(-1);
        if (!payload || payload === `bull-${this.queueName}-wait`) {
          continue;
        }

        const stored = ensureStoredJob(payload);

        try {
          await this.processor({ data: stored.data, attemptsMade: stored.attemptsMade, opts: { attempts: stored.opts.attempts } });
        } catch (error) {
          const nextAttemptsMade = stored.attemptsMade + 1;
          if (nextAttemptsMade < stored.opts.attempts) {
            const nextJob: StoredJob = {
              ...stored,
              attemptsMade: nextAttemptsMade
            };
            const nextPayload = JSON.stringify(nextJob);
            const delayMs = computeBackoffMs(stored.opts.backoff, nextAttemptsMade);
            if (delayMs > 0) {
              const runAt = Date.now() + delayMs;
              runRedis(this.opts.connection, 'ZADD', `bull-${this.queueName}-delayed`, String(runAt), nextPayload);
            } else {
              runRedis(this.opts.connection, 'RPUSH', `bull-${this.queueName}-wait`, nextPayload);
            }
          } else {
            this.emit('failed', { data: stored.data, attemptsMade: nextAttemptsMade, opts: stored.opts }, error);
          }
        }
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error('unknown'));
      }
    }
  }
}
