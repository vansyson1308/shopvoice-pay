// In-memory ShopStore for unit tests, CI without Postgres, and offline demos.
// Data comes from a MemoryDataset (see scripts/v2/gen_demo_seed.mjs
// buildDemoDataset, which mirrors the SQL demo seed). Each tenant only ever
// sees its own dataset entry, mirroring RLS.
import { createHash, randomUUID } from 'node:crypto';
import type {
  AuditEntry, DraftRow, InvoiceRow, NewDraft, ProductMatch, SalesTotals, ShopProfile, ShopRepository,
  ShopStore, SkuSales, StockRow, Supplier
} from './store.js';
import { ShopDataError } from './store.js';
import { addDays } from './analytics.js';

export interface MemoryProduct {
  readonly sku: string;
  readonly name: string;
  readonly unit: string | null;
  readonly barcode: string | null;
  readonly onHand: number;
  readonly minQty: number;
  readonly reorderQty: number;
  readonly packSize: number;
  readonly unitCostVnd: number;
  readonly supplierCode: string | null;
  readonly leadTimeDays: number;
}

export interface MemorySale {
  readonly date: string;
  readonly sku: string;
  readonly qty: number;
  readonly revenueVnd: number;
}

export interface MemoryTenantData {
  readonly profile: Omit<ShopProfile, 'tenantId'>;
  readonly today: string;
  readonly products: readonly MemoryProduct[];
  readonly sales: readonly MemorySale[];
  readonly suppliers: readonly Supplier[];
  readonly invoices: readonly InvoiceRow[];
}

export interface MemoryDataset {
  readonly tenants: Record<string, MemoryTenantData>;
  /** token (plaintext) -> tenant id; hashed on load. */
  readonly tokens: Record<string, string>;
}

interface MutableDraft {
  id: string;
  tenantId: string;
  supplierCode: string;
  lines: NewDraft['lines'];
  totalVnd: number;
  status: DraftRow['status'];
  tokenHash: string;
  expiresAtMs: number;
}

// ---- pg_trgm-like similarity (lowercase, words padded "  w "). ----
function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  const common = overlap(ta, tb);
  const union = ta.size + tb.size - common;
  return union === 0 ? 0 : common / union;
}

function orderedTrigrams(text: string): string[] {
  const out: string[] = [];
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.push(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * pg_trgm word_similarity: the greatest similarity (common / union) between
 * the query's trigram set and any contiguous extent of the text's ordered
 * trigrams.
 */
export function wordSimilarity(query: string, text: string): number {
  const tq = trigrams(query);
  if (tq.size === 0) return 0;
  const ordered = orderedTrigrams(text);
  let best = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const extent = new Set<string>();
    for (let j = i; j < ordered.length && j - i < tq.size + 2; j += 1) {
      extent.add(ordered[j] ?? '');
      const common = overlap(tq, extent);
      best = Math.max(best, common / (tq.size + extent.size - common));
    }
  }
  return best;
}

class MemoryRepository implements ShopRepository {
  constructor(
    private readonly tenantId: string,
    private readonly data: MemoryTenantData,
    private readonly drafts: MutableDraft[],
    private readonly auditLog: (AuditEntry & { tenantId: string })[],
    private readonly now: () => number
  ) {}

  async getProfile(): Promise<ShopProfile> {
    return { tenantId: this.tenantId, ...this.data.profile };
  }

  async today(): Promise<string> {
    return this.data.today;
  }

  async listStock(): Promise<StockRow[]> {
    const from = addDays(this.data.today, -14);
    const units = new Map<string, number>();
    for (const s of this.data.sales) {
      if (s.date >= from && s.date < this.data.today) units.set(s.sku, (units.get(s.sku) ?? 0) + s.qty);
    }
    return [...this.data.products]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ ...p, avgDaily14d: (units.get(p.sku) ?? 0) / 14 }));
  }

  async searchProducts(query: string, limit: number): Promise<ProductMatch[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    return this.data.products
      .map((p) => {
        const substring = p.name.toLowerCase().includes(q.toLowerCase());
        const score = p.barcode === q ? 2 : Math.max(similarity(p.name, q), wordSimilarity(q, p.name), substring ? 0.5 : 0);
        return { sku: p.sku, name: p.name, unit: p.unit, barcode: p.barcode, score };
      })
      .filter((m) => m.score >= 0.3)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, Math.max(1, Math.min(limit, 20)))
      .map((m) => ({ ...m, score: Math.round(m.score * 100) / 100 }));
  }

  async salesTotals(startDate: string, endDate: string): Promise<SalesTotals> {
    let revenueVnd = 0;
    let units = 0;
    const days = new Set<string>();
    for (const s of this.data.sales) {
      if (s.date >= startDate && s.date <= endDate) {
        revenueVnd += s.revenueVnd;
        units += s.qty;
        days.add(s.date);
      }
    }
    return { revenueVnd, units, daysWithSales: days.size };
  }

  async salesBySku(startDate: string, endDate: string): Promise<SkuSales[]> {
    const names = new Map(this.data.products.map((p) => [p.sku, p]));
    const agg = new Map<string, SkuSales>();
    for (const s of this.data.sales) {
      if (s.date < startDate || s.date > endDate) continue;
      const prev = agg.get(s.sku);
      const p = names.get(s.sku);
      agg.set(s.sku, {
        sku: s.sku,
        name: p?.name ?? s.sku,
        unit: p?.unit ?? null,
        units: (prev?.units ?? 0) + s.qty,
        revenueVnd: (prev?.revenueVnd ?? 0) + s.revenueVnd
      });
    }
    return [...agg.values()];
  }

  async listSuppliers(): Promise<Supplier[]> {
    return [...this.data.suppliers];
  }

  async listRecentInvoices(limit: number): Promise<InvoiceRow[]> {
    return [...this.data.invoices]
      .sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate) || b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit);
  }

  async createDrafts(drafts: readonly NewDraft[], tokenHash: string, ttlSeconds: number): Promise<{ ids: string[]; expiresAt: string }> {
    const expiresAtMs = this.now() + ttlSeconds * 1000;
    const ids = drafts.map((d) => {
      const id = randomUUID();
      this.drafts.push({ id, tenantId: this.tenantId, supplierCode: d.supplierCode, lines: d.lines, totalVnd: d.totalVnd, status: 'draft', tokenHash, expiresAtMs });
      return id;
    });
    return { ids, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async findDraftsByTokenHash(tokenHash: string): Promise<DraftRow[]> {
    const now = this.now();
    return this.drafts
      .filter((d) => d.tenantId === this.tenantId && d.tokenHash === tokenHash)
      .map((d) => ({
        id: d.id, supplierCode: d.supplierCode, lines: d.lines, totalVnd: d.totalVnd, status: d.status,
        expiresAt: new Date(d.expiresAtMs).toISOString(), expired: d.expiresAtMs <= now
      }));
  }

  async confirmDrafts(ids: readonly string[]): Promise<number> {
    const now = this.now();
    let n = 0;
    for (const d of this.drafts) {
      if (d.tenantId === this.tenantId && ids.includes(d.id) && d.status === 'draft' && d.expiresAtMs > now) {
        d.status = 'confirmed';
        n += 1;
      }
    }
    return n;
  }

  async audit(entry: AuditEntry): Promise<void> {
    this.auditLog.push({ ...entry, tenantId: this.tenantId });
  }
}

export class MemoryShopStore implements ShopStore {
  readonly drafts: MutableDraft[] = [];
  readonly auditLog: (AuditEntry & { tenantId: string })[] = [];
  private readonly tokenHashes = new Map<string, string>();

  constructor(private readonly dataset: MemoryDataset, private readonly now: () => number = Date.now) {
    for (const [token, tenantId] of Object.entries(dataset.tokens)) {
      this.tokenHashes.set(createHash('sha256').update(token, 'utf8').digest('hex'), tenantId);
    }
  }

  /** Adds a tenant's dataset (sandbox shops created by OAuth sign-ups). */
  addTenant(tenantId: string, data: MemoryTenantData): void {
    (this.dataset.tenants as Record<string, MemoryTenantData>)[tenantId] = data;
  }

  removeTenant(tenantId: string): void {
    delete (this.dataset.tenants as Record<string, MemoryTenantData>)[tenantId];
  }

  async withTenant<T>(tenantId: string, work: (repo: ShopRepository) => Promise<T>): Promise<T> {
    const data = this.dataset.tenants[tenantId];
    if (!data) throw new ShopDataError('profile_missing');
    return work(new MemoryRepository(tenantId, data, this.drafts, this.auditLog, this.now));
  }

  async resolveTokenHash(tokenHash: string): Promise<{ tenantId: string; tokenId: string } | null> {
    const tenantId = this.tokenHashes.get(tokenHash);
    return tenantId ? { tenantId, tokenId: tokenHash.slice(0, 12) } : null;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}
