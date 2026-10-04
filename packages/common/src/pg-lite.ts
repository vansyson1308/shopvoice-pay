import { spawnSync } from 'node:child_process';

export interface PoolOptions {
  connectionString: string;
}

export class Pool {
  constructor(private readonly options: PoolOptions) {}

  async query(sql: string): Promise<{ rows: Record<string, string>[] }> {
    const result = spawnSync('psql', [
      this.options.connectionString,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-t',
      '-A',
      '-F',
      '|',
      '-c',
      sql
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    if (result.status !== 0) {
      throw new Error('db_error');
    }

    const rows = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const cols = line.split('|');
        return Object.fromEntries(cols.map((value, idx) => [`c${idx}`, value]));
      });

    return { rows };
  }
}
