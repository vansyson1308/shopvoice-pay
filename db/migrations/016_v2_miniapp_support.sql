-- Migration 016: Mini App support — fuzzy search, barcode index, price columns

-- 1. Enable pg_trgm for fuzzy product search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Trigram GIN index on product_cache.product_name for fuzzy search
CREATE INDEX IF NOT EXISTS idx_product_cache_name_trgm
  ON product_cache USING GIN (product_name gin_trgm_ops);

-- 3. B-tree index on product_cache.barcode for barcode lookup
CREATE INDEX IF NOT EXISTS idx_product_cache_barcode
  ON product_cache (tenant_id, barcode)
  WHERE barcode IS NOT NULL AND barcode != '';

-- 4. Add base_price column to product_cache (sell price from KiotViet)
ALTER TABLE product_cache ADD COLUMN IF NOT EXISTS base_price NUMERIC(18,2);

-- 5. Add sell_price to resolved_invoice_items (user can edit sell price in Mini App)
ALTER TABLE resolved_invoice_items ADD COLUMN IF NOT EXISTS sell_price NUMERIC(18,2);

---- rollback
DROP INDEX IF EXISTS idx_product_cache_name_trgm;
DROP INDEX IF EXISTS idx_product_cache_barcode;
ALTER TABLE product_cache DROP COLUMN IF EXISTS base_price;
ALTER TABLE resolved_invoice_items DROP COLUMN IF EXISTS sell_price;
DROP EXTENSION IF EXISTS pg_trgm;
