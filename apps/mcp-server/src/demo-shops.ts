// "Try the demo": a private sample shop per console visitor, plus reset and
// cleanup. Sample shops only: Postgres refuses to reset or delete a real shop
// (migration 023), and the memory backend only knows sample data.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PgPoolLike } from '../../../packages/common/dist/index.js';
import type { MemoryShopStore, MemoryTenantData } from './memory-store.js';
import type { PaymentsSetup } from './payments-setup.js';
import { connectMockPayPal } from './payments-setup.js';

export interface DemoShops {
  /** A new visitor shop and its bearer token (returned once; only the hash is stored). */
  create(): Promise<{ token: string; tenantId: string }>;
  /** Back to the starting sample data. False when the tenant is not a sample shop. */
  reset(tenantId: string): Promise<boolean>;
  /** Removes visitor shops idle longer than `idleDays`. */
  cleanup(idleDays: number): Promise<number>;
}

export function newVisitorToken(): string {
  return `sv_demo_${randomBytes(32).toString('base64url')}`;
}

const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

export class MemoryDemoShops implements DemoShops {
  private readonly visitors = new Map<string, number>();

  constructor(
    private readonly store: MemoryShopStore,
    private readonly sampleData: (tenantId: string) => MemoryTenantData,
    private readonly payments: PaymentsSetup,
    private readonly sampleTenants: ReadonlySet<string>,
    private readonly now: () => number = Date.now
  ) {}

  async create(): Promise<{ token: string; tenantId: string }> {
    const tenantId = randomUUID();
    const token = newVisitorToken();
    this.store.addTenant(tenantId, this.sampleData(tenantId));
    this.store.addTokenHash(sha256(token), tenantId);
    this.visitors.set(tenantId, this.now());
    await connectMockPayPal(this.payments, this.store, tenantId);
    return { token, tenantId };
  }

  async reset(tenantId: string): Promise<boolean> {
    if (!this.visitors.has(tenantId) && !this.sampleTenants.has(tenantId)) return false;
    this.store.resetTenant(tenantId, this.sampleData(tenantId));
    await connectMockPayPal(this.payments, this.store, tenantId);
    return true;
  }

  async cleanup(idleDays: number): Promise<number> {
    const cutoff = this.now() - Math.max(1, idleDays) * 86_400_000;
    let removed = 0;
    for (const [tenantId, createdMs] of this.visitors) {
      if (createdMs < cutoff) {
        this.store.removeTenant(tenantId);
        this.visitors.delete(tenantId);
        removed += 1;
      }
    }
    return removed;
  }
}

export class PgDemoShops implements DemoShops {
  constructor(
    private readonly pool: PgPoolLike,
    private readonly catalogueJson: string,
    private readonly payments: PaymentsSetup,
    private readonly connect: (tenantId: string) => Promise<boolean>
  ) {}

  async create(): Promise<{ token: string; tenantId: string }> {
    const token = newVisitorToken();
    const { rows } = await this.pool.query('SELECT demo_shop_create($1, $2::jsonb) AS tenant_id', [sha256(token), this.catalogueJson]);
    const tenantId = String(rows[0]?.tenant_id ?? '');
    if (this.payments.runtime.mock) await this.connect(tenantId);
    return { token, tenantId };
  }

  async reset(tenantId: string): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT sandbox_reset($1::uuid, $2::jsonb) AS ok', [tenantId, this.catalogueJson]);
    return rows[0]?.ok === true;
  }

  async cleanup(idleDays: number): Promise<number> {
    const { rows } = await this.pool.query('SELECT demo_shops_cleanup($1) AS n', [idleDays]);
    return Number(rows[0]?.n ?? 0);
  }
}
