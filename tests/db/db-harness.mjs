// Shared helpers for the Postgres tests (not a test file itself).
import { readFileSync } from 'node:fs';
import { todayInTimezone } from '../../scripts/gen_demo_seed.mjs';

/** Pool whose connections run as the RLS-bound runtime role. */
export function runtimePool(pool) {
  const asRuntime = async () => {
    const c = await pool.connect();
    await c.query('SET ROLE groceryclaw_app_runtime');
    return {
      query: (text, params) => c.query(text, params),
      release: () => {
        c.query('RESET ROLE').finally(() => c.release());
      }
    };
  };
  return {
    connect: asRuntime,
    async query(text, params) {
      const c = await asRuntime();
      try {
        return await c.query(text, params);
      } finally {
        c.release();
      }
    },
    end: () => Promise.resolve()
  };
}

/** (Re)applies db/seed/002 for today in the demo timezone; also resets the demo ledger. */
export async function applyDemoSeed(admin) {
  const seed = readFileSync('db/seed/002_demo_shop_seed.sql', 'utf8');
  const c = await admin.connect();
  try {
    await c.query(`SET demo.anchor_date = '${todayInTimezone()}';\n${seed}`);
  } finally {
    c.release();
  }
}
