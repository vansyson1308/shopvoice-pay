import pg from 'pg';

export interface PgClientLike {
  query: (text: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
}

export interface PgPoolLike {
  query: (text: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  connect: () => Promise<PgClientLike>;
  end: () => Promise<void>;
}

export interface CreatePgPoolOptions {
  readonly connectionString: string;
  readonly applicationName: string;
  readonly statementTimeoutMs?: number;
}

type PgPoolConstructorConfig = {
  connectionString: string;
  application_name: string;
  statement_timeout: number;
  query_timeout: number;
};

type PgPoolConstructor = new (config: PgPoolConstructorConfig) => PgPoolLike;

type PgModuleShape = {
  Pool?: PgPoolConstructor;
  default?: {
    Pool?: PgPoolConstructor;
  };
};

const CONNECTION_SEGMENT_PATTERN = /(postgres(?:ql)?:\/\/)([^\s@/]+)@/gi;

function redactText(value: string): string {
  return value.replace(CONNECTION_SEGMENT_PATTERN, '$1[REDACTED]@');
}

function assertPgPoolInitialized(pool: PgPoolLike | null | undefined): asserts pool is PgPoolLike {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new Error('db_pool_not_initialized');
  }
}

export function redactDbErrorMessage(message: string): string {
  return redactText(message);
}

export function sanitizeDbError(error: unknown): Error {
  const message = error instanceof Error ? error.message : 'unknown_db_error';
  return new Error(redactDbErrorMessage(message));
}

export async function createPgPool(options: CreatePgPoolOptions): Promise<PgPoolLike> {
  const statementTimeoutMs = options.statementTimeoutMs ?? 5000;
  const pgModule = (await import('pg')) as PgModuleShape;

  // Handle both direct ESM access and CommonJS default-export interop.
  const Pool = pgModule.Pool ?? pgModule.default?.Pool;
  if (!Pool) {
    throw new Error('pg_pool_constructor_unavailable');
  }

  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs
  });

  return pool;
}

export async function query(
  pool: Pick<PgPoolLike, 'query'>,
  text: string,
  params: readonly unknown[] = []
): Promise<{ rows: Record<string, unknown>[] }> {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('db_pool_not_initialized');
  }

  try {
    return await pool.query(text, params);
  } catch (error) {
    throw sanitizeDbError(error);
  }
}

export async function closePool(pool: Pick<PgPoolLike, 'end'>): Promise<void> {
  if (!pool || typeof pool.end !== 'function') {
    throw new Error('db_pool_not_initialized');
  }
  await pool.end();
}

export async function dbPing(pool: Pick<PgPoolLike, 'query'>, timeoutMs = 500): Promise<boolean> {
  try {
    const timed = await Promise.race([
      query(pool, 'SELECT 1 AS ok'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('db_ping_timeout')), timeoutMs))
    ]);
    return (timed.rows[0]?.ok as number | undefined) === 1;
  } catch {
    return false;
  }
}

export async function runTenantScopedTransaction<T>(opts: {
  readonly pool: PgPoolLike;
  readonly tenantId: string;
  readonly applicationName?: string;
  readonly work: (client: Pick<PgClientLike, 'query'>) => Promise<T>;
}): Promise<T> {
  assertPgPoolInitialized(opts.pool);

  const client = await opts.pool.connect();
  try {
    await query(client, 'BEGIN');
    await query(client, "SELECT set_config('app.current_tenant', $1, true)", [opts.tenantId]);

    if (opts.applicationName) {
      await query(client, "SELECT set_config('application_name', $1, true)", [opts.applicationName]);
    }

    const result = await opts.work(client);
    await query(client, 'COMMIT');
    return result;
  } catch (error) {
    try {
      await query(client, 'ROLLBACK');
    } catch {
      // keep original error
    }
    throw sanitizeDbError(error);
  } finally {
    client.release();
  }
}
