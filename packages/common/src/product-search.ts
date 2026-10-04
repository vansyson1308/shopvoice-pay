export interface SearchDeps {
  readonly queryMany: (sql: string, params?: readonly unknown[]) => Promise<string[]>;
}

export interface ProductResult {
  sku: string;
  product_name: string;
  barcode: string | null;
  unit: string | null;
  base_price: number | null;
}

function parseProductRow(row: string): ProductResult | null {
  try {
    return JSON.parse(row) as ProductResult;
  } catch {
    return null;
  }
}

export async function searchProducts(deps: SearchDeps, query: string, limit: number): Promise<ProductResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const clampedLimit = Math.max(1, Math.min(limit || 10, 20));

  const rows = await deps.queryMany(`
    SELECT json_build_object(
      'sku', sku,
      'product_name', product_name,
      'barcode', barcode,
      'unit', unit,
      'base_price', base_price
    )::text
    FROM product_cache
    WHERE tenant_id = _rls_tenant_id()
      AND active = true
      AND product_name % $1
    ORDER BY similarity(product_name, $1) DESC
    LIMIT $2;
  `, [trimmed, clampedLimit]);

  return rows
    .map((r) => parseProductRow(r.trim()))
    .filter((p): p is ProductResult => p !== null);
}

export async function findByBarcode(deps: SearchDeps, barcode: string): Promise<ProductResult | null> {
  const trimmed = barcode.trim();
  if (!trimmed) return null;

  const rows = await deps.queryMany(`
    SELECT json_build_object(
      'sku', sku,
      'product_name', product_name,
      'barcode', barcode,
      'unit', unit,
      'base_price', base_price
    )::text
    FROM product_cache
    WHERE tenant_id = _rls_tenant_id()
      AND active = true
      AND barcode = $1
    LIMIT 1;
  `, [trimmed]);

  if (rows.length === 0) return null;
  return parseProductRow(rows[0]!.trim());
}

export interface VoiceProductMatch extends ProductResult {
  score: number;
}

/**
 * Voice-oriented variant of searchProducts: spoken queries are short ("milk",
 * "eggs"), so word_similarity is used alongside similarity, and exact barcode
 * or substring hits rank first. Same tenant scoping via _rls_tenant_id().
 */
export async function searchProductsForVoice(deps: SearchDeps, query: string, limit: number): Promise<VoiceProductMatch[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const clampedLimit = Math.max(1, Math.min(limit || 5, 20));

  const rows = await deps.queryMany(`
    SELECT json_build_object(
      'sku', sku,
      'product_name', product_name,
      'barcode', barcode,
      'unit', unit,
      'base_price', base_price,
      'score', CASE
        WHEN barcode = $1 THEN 2
        ELSE greatest(similarity(product_name, $1), word_similarity($1, product_name))
      END
    )::text
    FROM product_cache
    WHERE tenant_id = _rls_tenant_id()
      AND active = true
      AND (
        barcode = $1
        OR product_name % $1
        OR word_similarity($1, product_name) >= 0.5
        OR product_name ILIKE '%' || $1 || '%'
      )
    ORDER BY (barcode = $1) DESC NULLS LAST,
      greatest(similarity(product_name, $1), word_similarity($1, product_name)) DESC,
      product_name ASC
    LIMIT $2;
  `, [trimmed, clampedLimit]);

  return rows
    .map((r) => {
      try {
        return JSON.parse(r.trim()) as VoiceProductMatch;
      } catch {
        return null;
      }
    })
    .filter((p): p is VoiceProductMatch => p !== null);
}
