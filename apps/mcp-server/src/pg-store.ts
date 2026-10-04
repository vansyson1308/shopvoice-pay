import type { PgClientLike, PgPoolLike } from '../../../packages/common/dist/index.js';
import { dbPing, runTenantScopedTransaction, searchProductsForVoice } from '../../../packages/common/dist/index.js';
import type {
  AuditEntry, DraftLine, DraftRow, InvoiceRow, NewDraft, ProductMatch, SalesTotals, ShopProfile,
  ShopRepository, ShopStore, SkuSales, StockRow, Supplier
} from './store.js';
import { ShopDataError } from './store.js';

type Queryable = Pick<PgClientLike, 'query'>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

class PgShopRepository implements ShopRepository {
  private profile: ShopProfile | null = null;
  private todayValue: string | null = null;

  constructor(private readonly client: Queryable, private readonly tenantId: string) {}

  async getProfile(): Promise<ShopProfile> {
    if (this.profile) return this.profile;
    const { rows } = await this.client.query(
      `SELECT shop_name, display_currency, vnd_per_display_unit, timezone, locale
         FROM shop_profiles WHERE tenant_id = _rls_tenant_id()`
    );
    const row = rows[0];
    if (!row) throw new ShopDataError('profile_missing');
    this.profile = {
      tenantId: this.tenantId,
      shopName: str(row.shop_name),
      displayCurrency: str(row.display_currency),
      vndPerDisplayUnit: num(row.vnd_per_display_unit),
      timezone: str(row.timezone),
      locale: str(row.locale)
    };
    return this.profile;
  }

  async today(): Promise<string> {
    if (this.todayValue) return this.todayValue;
    const profile = await this.getProfile();
    const { rows } = await this.client.query(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [profile.timezone]);
    this.todayValue = str(rows[0]?.d);
    return this.todayValue;
  }

  async listStock(): Promise<StockRow[]> {
    const today = await this.today();
    const { rows } = await this.client.query(
      `SELECT p.sku, p.product_name, COALESCE(s.unit, p.unit) AS unit, p.barcode,
              COALESCE(s.on_hand_qty, 0) AS on_hand,
              COALESCE(r.min_qty, 0) AS min_qty, COALESCE(r.reorder_qty, 0) AS reorder_qty,
              COALESCE(r.pack_size, 1) AS pack_size, COALESCE(r.unit_cost_vnd, 0) AS unit_cost_vnd,
              r.preferred_supplier_code, COALESCE(r.lead_time_days, 2) AS lead_time_days,
              COALESCE(sd.units, 0) / 14.0 AS avg_daily
         FROM product_cache p
         LEFT JOIN stock_levels s ON s.tenant_id = p.tenant_id AND s.sku = p.sku
         LEFT JOIN reorder_rules r ON r.tenant_id = p.tenant_id AND r.sku = p.sku
         LEFT JOIN (
           SELECT sku, sum(qty_sold) AS units FROM sales_daily
            WHERE tenant_id = _rls_tenant_id()
              AND sale_date >= $1::date - 14 AND sale_date < $1::date
            GROUP BY sku
         ) sd ON sd.sku = p.sku
        WHERE p.tenant_id = _rls_tenant_id() AND p.active = true
        ORDER BY p.product_name`,
      [today]
    );
    return rows.map((r) => ({
      sku: str(r.sku),
      name: str(r.product_name),
      unit: strOrNull(r.unit),
      barcode: strOrNull(r.barcode),
      onHand: num(r.on_hand),
      minQty: num(r.min_qty),
      reorderQty: num(r.reorder_qty),
      packSize: num(r.pack_size) || 1,
      unitCostVnd: num(r.unit_cost_vnd),
      supplierCode: strOrNull(r.preferred_supplier_code),
      leadTimeDays: num(r.lead_time_days),
      avgDaily14d: num(r.avg_daily)
    }));
  }

  async searchProducts(query: string, limit: number): Promise<ProductMatch[]> {
    const matches = await searchProductsForVoice({
      queryMany: async (sql, params) => {
        const { rows } = await this.client.query(sql, params);
        return rows.map((r) => Object.values(r).join(''));
      }
    }, query, limit);
    return matches.map((m) => ({ sku: m.sku, name: m.product_name, unit: m.unit, barcode: m.barcode, score: Number(m.score) }));
  }

  async salesTotals(startDate: string, endDate: string): Promise<SalesTotals> {
    const { rows } = await this.client.query(
      `SELECT COALESCE(sum(revenue_vnd), 0) AS revenue, COALESCE(sum(qty_sold), 0) AS units,
              count(DISTINCT sale_date) AS days
         FROM sales_daily
        WHERE tenant_id = _rls_tenant_id() AND sale_date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
    );
    const r = rows[0] ?? {};
    return { revenueVnd: num(r.revenue), units: num(r.units), daysWithSales: num(r.days) };
  }

  async salesBySku(startDate: string, endDate: string): Promise<SkuSales[]> {
    const { rows } = await this.client.query(
      `SELECT sd.sku, COALESCE(p.product_name, sd.sku) AS name, p.unit,
              sum(sd.qty_sold) AS units, sum(sd.revenue_vnd) AS revenue
         FROM sales_daily sd
         LEFT JOIN product_cache p ON p.tenant_id = sd.tenant_id AND p.sku = sd.sku
        WHERE sd.tenant_id = _rls_tenant_id() AND sd.sale_date BETWEEN $1::date AND $2::date
        GROUP BY sd.sku, p.product_name, p.unit`,
      [startDate, endDate]
    );
    return rows.map((r) => ({ sku: str(r.sku), name: str(r.name), unit: strOrNull(r.unit), units: num(r.units), revenueVnd: num(r.revenue) }));
  }

  async listSuppliers(): Promise<Supplier[]> {
    const { rows } = await this.client.query(
      `SELECT supplier_code, name, default_lead_time_days FROM suppliers
        WHERE tenant_id = _rls_tenant_id() ORDER BY name`
    );
    return rows.map((r) => ({ code: str(r.supplier_code), name: str(r.name), leadTimeDays: num(r.default_lead_time_days) }));
  }

  async listRecentInvoices(limit: number): Promise<InvoiceRow[]> {
    const { rows } = await this.client.query(
      `SELECT ci.id, ci.invoice_number, ci.supplier_code, s.name AS supplier_name,
              to_char(ci.invoice_date, 'YYYY-MM-DD') AS invoice_date, ci.created_at, ci.total,
              (SELECT count(*) FROM canonical_invoice_items i WHERE i.canonical_invoice_id = ci.id) AS line_count,
              (SELECT count(*) FROM resolved_invoice_items r
                WHERE r.canonical_invoice_id = ci.id AND r.status IN ('resolved', 'skipped')) AS resolved_count,
              EXISTS (SELECT 1 FROM sync_results sr
                WHERE sr.canonical_invoice_id = ci.id AND sr.status = 'success') AS synced,
              ARRAY(SELECT i.product_name FROM canonical_invoice_items i
                WHERE i.canonical_invoice_id = ci.id ORDER BY i.line_no) AS product_names
         FROM canonical_invoices ci
         LEFT JOIN suppliers s ON s.tenant_id = ci.tenant_id AND s.supplier_code = ci.supplier_code
        WHERE ci.tenant_id = _rls_tenant_id()
        ORDER BY ci.invoice_date DESC, ci.created_at DESC
        LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({
      id: str(r.id),
      invoiceNumber: str(r.invoice_number),
      supplierCode: strOrNull(r.supplier_code),
      supplierName: strOrNull(r.supplier_name),
      invoiceDate: str(r.invoice_date),
      receivedAt: r.created_at instanceof Date ? r.created_at.toISOString() : str(r.created_at),
      totalVnd: num(r.total),
      lineCount: num(r.line_count),
      resolvedCount: num(r.resolved_count),
      synced: r.synced === true,
      productNames: Array.isArray(r.product_names) ? r.product_names.map((n: unknown) => str(n)) : []
    }));
  }

  async createDrafts(drafts: readonly NewDraft[], tokenHash: string, ttlSeconds: number): Promise<{ ids: string[]; expiresAt: string }> {
    const ids: string[] = [];
    let expiresAt = '';
    for (const draft of drafts) {
      const { rows } = await this.client.query(
        `INSERT INTO purchase_order_drafts
           (tenant_id, supplier_code, lines, total_vnd, status, created_via, confirmation_token_hash, expires_at)
         VALUES (_rls_tenant_id(), $1, $2::jsonb, $3, 'draft', 'voice', $4, now() + make_interval(secs => $5))
         RETURNING id, expires_at`,
        [draft.supplierCode, JSON.stringify(draft.lines), draft.totalVnd, tokenHash, ttlSeconds]
      );
      ids.push(str(rows[0]?.id));
      const exp = rows[0]?.expires_at;
      expiresAt = exp instanceof Date ? exp.toISOString() : str(exp);
    }
    return { ids, expiresAt };
  }

  async findDraftsByTokenHash(tokenHash: string): Promise<DraftRow[]> {
    const { rows } = await this.client.query(
      `SELECT id, supplier_code, lines, total_vnd, status, expires_at, expires_at <= now() AS expired
         FROM purchase_order_drafts
        WHERE tenant_id = _rls_tenant_id() AND confirmation_token_hash = $1
        ORDER BY created_at, supplier_code
        FOR UPDATE`,
      [tokenHash]
    );
    return rows.map((r) => ({
      id: str(r.id),
      supplierCode: str(r.supplier_code),
      lines: (Array.isArray(r.lines) ? r.lines : []) as DraftLine[],
      totalVnd: num(r.total_vnd),
      status: str(r.status) as DraftRow['status'],
      expiresAt: r.expires_at instanceof Date ? r.expires_at.toISOString() : str(r.expires_at),
      expired: r.expired === true
    }));
  }

  async confirmDrafts(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { rows } = await this.client.query(
      `UPDATE purchase_order_drafts
          SET status = 'confirmed', confirmed_at = now(), updated_at = now()
        WHERE tenant_id = _rls_tenant_id() AND id = ANY($1::uuid[]) AND status = 'draft' AND expires_at > now()
        RETURNING id`,
      [ids]
    );
    return rows.length;
  }

  async audit(entry: AuditEntry): Promise<void> {
    await this.client.query(
      `INSERT INTO voice_audit_log (tenant_id, tool_name, args_redacted, result_summary, outcome, latency_ms)
       VALUES (_rls_tenant_id(), $1, $2::jsonb, $3, $4, $5)`,
      [entry.toolName, JSON.stringify(entry.argsRedacted), entry.resultSummary.slice(0, 500), entry.outcome, Math.round(entry.latencyMs)]
    );
  }
}

export class PgShopStore implements ShopStore {
  constructor(private readonly pool: PgPoolLike) {}

  async withTenant<T>(tenantId: string, work: (repo: ShopRepository) => Promise<T>): Promise<T> {
    return runTenantScopedTransaction({
      pool: this.pool,
      tenantId,
      applicationName: 'mcp-server',
      work: (client) => work(new PgShopRepository(client, tenantId))
    });
  }

  async resolveTokenHash(tokenHash: string): Promise<{ tenantId: string; tokenId: string } | null> {
    const { rows } = await this.pool.query('SELECT tenant_id, token_id FROM resolve_mcp_access_token($1)', [tokenHash]);
    const row = rows[0];
    if (!row) return null;
    return { tenantId: str(row.tenant_id), tokenId: str(row.token_id) };
  }

  ping(): Promise<boolean> {
    return dbPing(this.pool);
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
