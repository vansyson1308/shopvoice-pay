// Generates db/v2/seed/002_demo_shop_seed.sql for the ShopVoice demo tenant.
//
// The output is deterministic: a fixed PRNG seed produces the same product
// catalogue, noise arrays and stock levels on every run. Dates are relative to
// an anchor date (default: today in Asia/Ho_Chi_Minh; override with the
// `demo.anchor_date` setting, which `db_v2_seed.mjs --demo` sets from
// DEMO_ANCHOR_DATE) so "today" questions always have data.
//
// Usage: node scripts/v2/gen_demo_seed.mjs > db/v2/seed/002_demo_shop_seed.sql

export const DEMO_TENANT_ID = 'c0ffee00-0000-4000-8000-000000000001';
export const DEMO_USER_ID = 'c0ffee00-0000-4000-8000-0000000000a1';
export const DEMO_TENANT_USER_ID = 'c0ffee00-0000-4000-8000-0000000000b1';
export const SALES_DAYS = 91; // 90 full days of history + today
export const TODAY_FRACTION = 0.7; // "today so far" (mid-afternoon)
export const WEEKDAY_MULTIPLIERS = [0.9, 0.85, 0.9, 0.95, 1.1, 1.45, 1.35]; // ISO Mon..Sun

export const SUPPLIERS = [
  { code: 'SUP-DAIRY', name: 'Green Valley Dairy & Eggs', phone: '+84 28 0000 0101', lead: 1 },
  { code: 'SUP-FRESH', name: 'Dawn Bakery & Farm', phone: '+84 28 0000 0102', lead: 1 },
  { code: 'SUP-BEV', name: 'Sunrise Beverages', phone: '+84 28 0000 0103', lead: 2 },
  { code: 'SUP-DRY', name: 'Mekong Dry Goods', phone: '+84 28 0000 0104', lead: 3 },
  { code: 'SUP-SNACK', name: 'Saigon Snacks & Sweets', phone: '+84 28 0000 0105', lead: 2 }
];

// [sku, name, unit, price VND, base daily units, pack size, supplier, low?]
export const PRODUCTS = [
  ['MILK-1L', 'Fresh Milk 1L', 'carton', 32000, 14, 12, 'SUP-DAIRY', true],
  ['MILK-180', 'Fresh Milk 180ml', 'box', 7000, 30, 48, 'SUP-DAIRY', false],
  ['YOG-4', 'Plain Yogurt 4-pack', 'pack', 26000, 8, 12, 'SUP-DAIRY', false],
  ['YOG-DRINK', 'Drinking Yogurt 110ml', 'bottle', 6000, 18, 48, 'SUP-DAIRY', false],
  ['CONDMILK', 'Sweetened Condensed Milk 380g', 'can', 24000, 5, 24, 'SUP-DAIRY', false],
  ['EGG-10', 'Chicken Eggs 10-pack', 'tray', 32000, 12, 10, 'SUP-DAIRY', true],
  ['EGG-DUCK', 'Duck Eggs 10-pack', 'tray', 38000, 3, 10, 'SUP-DAIRY', false],
  ['BUTTER', 'Butter 200g', 'block', 55000, 2, 12, 'SUP-DAIRY', false],
  ['CHEESE', 'Cheese Slices 10-pack', 'pack', 45000, 3, 12, 'SUP-DAIRY', false],
  ['SOYMILK-1L', 'Soy Milk 1L', 'carton', 25000, 6, 12, 'SUP-DAIRY', false],
  ['BREAD-WHITE', 'White Sandwich Bread', 'loaf', 35000, 10, 10, 'SUP-FRESH', true],
  ['BAGUETTE', 'Baguette', 'piece', 5000, 40, 20, 'SUP-FRESH', false],
  ['BUNS-6', 'Sweet Buns 6-pack', 'pack', 30000, 5, 10, 'SUP-FRESH', false],
  ['TOFU', 'Fresh Tofu 400g', 'block', 12000, 8, 10, 'SUP-FRESH', false],
  ['BANANA', 'Bananas', 'bunch', 25000, 6, 5, 'SUP-FRESH', false],
  ['TOMATO-1KG', 'Tomatoes 1kg', 'bag', 30000, 4, 5, 'SUP-FRESH', false],
  ['ONION-1KG', 'Onions 1kg', 'bag', 28000, 3, 5, 'SUP-FRESH', false],
  ['GARLIC-500', 'Garlic 500g', 'bag', 35000, 2, 5, 'SUP-FRESH', false],
  ['COLA-330', 'Cola 330ml Can', 'can', 10000, 36, 24, 'SUP-BEV', true],
  ['COLA-1500', 'Cola 1.5L Bottle', 'bottle', 22000, 8, 12, 'SUP-BEV', false],
  ['LEMON-330', 'Lemon Soda 330ml Can', 'can', 10000, 14, 24, 'SUP-BEV', false],
  ['ORANGE-330', 'Orange Soda 330ml Can', 'can', 10000, 12, 24, 'SUP-BEV', false],
  ['WATER-500', 'Mineral Water 500ml', 'bottle', 5000, 45, 24, 'SUP-BEV', false],
  ['WATER-1500', 'Mineral Water 1.5L', 'bottle', 10000, 12, 12, 'SUP-BEV', false],
  ['GREENTEA-450', 'Green Tea 450ml', 'bottle', 10000, 22, 24, 'SUP-BEV', false],
  ['ENERGY-250', 'Energy Drink 250ml', 'can', 12000, 16, 24, 'SUP-BEV', false],
  ['ICEDCOFFEE', 'Iced Coffee 235ml Can', 'can', 13000, 10, 24, 'SUP-BEV', false],
  ['BEER-330', 'Lager Beer 330ml Can', 'can', 16000, 30, 24, 'SUP-BEV', false],
  ['BEER-CASE', 'Lager Beer 24-Can Case', 'case', 360000, 2, 1, 'SUP-BEV', false],
  ['JUICE-1L', 'Orange Juice 1L', 'carton', 38000, 4, 12, 'SUP-BEV', false],
  ['NOODLE-SHRIMP', 'Shrimp Instant Noodles', 'pack', 4000, 60, 30, 'SUP-DRY', false],
  ['NOODLE-PHO', 'Beef Pho Instant Noodles', 'pack', 9000, 20, 30, 'SUP-DRY', false],
  ['NOODLE-CUP', 'Cup Noodles', 'cup', 12000, 14, 24, 'SUP-DRY', false],
  ['RICE-5KG', 'Jasmine Rice 5kg', 'bag', 140000, 3, 4, 'SUP-DRY', false],
  ['RICE-10KG', 'Fragrant Rice 10kg', 'bag', 260000, 1, 2, 'SUP-DRY', false],
  ['FISHSAUCE-500', 'Fish Sauce 500ml', 'bottle', 38000, 5, 12, 'SUP-DRY', false],
  ['SOYSAUCE-500', 'Soy Sauce 500ml', 'bottle', 22000, 4, 12, 'SUP-DRY', false],
  ['OIL-1L', 'Cooking Oil 1L', 'bottle', 52000, 5, 12, 'SUP-DRY', false],
  ['SUGAR-1KG', 'White Sugar 1kg', 'bag', 28000, 4, 10, 'SUP-DRY', false],
  ['SALT-500', 'Iodized Salt 500g', 'bag', 7000, 3, 20, 'SUP-DRY', false],
  ['SEASONING-400', 'Seasoning Powder 400g', 'bag', 30000, 3, 20, 'SUP-DRY', false],
  ['PEPPER-50', 'Ground Pepper 50g', 'jar', 15000, 2, 20, 'SUP-DRY', false],
  ['CHILI-250', 'Chili Sauce 250g', 'bottle', 14000, 4, 24, 'SUP-DRY', false],
  ['COFFEE-3IN1', '3-in-1 Coffee 20 Sachets', 'box', 55000, 4, 12, 'SUP-DRY', false],
  ['TEA-25', 'Tea Bags 25-pack', 'box', 30000, 2, 12, 'SUP-DRY', false],
  ['SARDINES', 'Canned Sardines 155g', 'can', 18000, 5, 24, 'SUP-DRY', false],
  ['LUNCHEON', 'Canned Pork Luncheon 200g', 'can', 35000, 3, 24, 'SUP-DRY', false],
  ['FLOUR-1KG', 'Wheat Flour 1kg', 'bag', 25000, 1, 10, 'SUP-DRY', false],
  ['TISSUE', 'Tissue Box', 'box', 20000, 3, 20, 'SUP-DRY', false],
  ['DISHSOAP', 'Dish Soap 750ml', 'bottle', 32000, 2, 12, 'SUP-DRY', false],
  ['CHIPS-POTATO', 'Potato Chips 52g', 'bag', 12000, 14, 24, 'SUP-SNACK', false],
  ['CHIPS-PRAWN', 'Prawn Crackers 60g', 'bag', 8000, 12, 24, 'SUP-SNACK', false],
  ['COOKIES', 'Butter Cookies 200g', 'box', 40000, 4, 12, 'SUP-SNACK', false],
  ['SPONGECAKE', 'Chocolate Sponge Cakes 12-pack', 'box', 55000, 4, 12, 'SUP-SNACK', false],
  ['CANDY', 'Fruit Candy 150g', 'bag', 15000, 5, 24, 'SUP-SNACK', false],
  ['GUM', 'Chewing Gum', 'pack', 10000, 6, 30, 'SUP-SNACK', false],
  ['PEANUTS', 'Roasted Peanuts 200g', 'bag', 20000, 4, 20, 'SUP-SNACK', false],
  ['DRIED-SQUID', 'Dried Squid Snack', 'bag', 30000, 2, 20, 'SUP-SNACK', false],
  ['WAFER', 'Wafer Rolls 150g', 'box', 18000, 4, 24, 'SUP-SNACK', false],
  ['ICECREAM', 'Ice Cream Cone', 'piece', 12000, 10, 24, 'SUP-SNACK', false]
];

// Three recent supplier invoices: synced (dry goods, 2 days ago),
// mapped but not synced (beverages, this morning), arrived only (snacks, yesterday).
export const INVOICES = [
  { id: 'c0ffee00-0000-4000-8000-00000000e001', ev: 'c0ffee00-0000-4000-8000-00000000d001', supplier: 'SUP-DRY', number: 'MDG-24817', daysAgo: 2, state: 'synced',
    items: [['NOODLE-SHRIMP', 300, 3100], ['FISHSAUCE-500', 24, 29600], ['OIL-1L', 24, 40600], ['RICE-5KG', 8, 109200]] },
  { id: 'c0ffee00-0000-4000-8000-00000000e002', ev: 'c0ffee00-0000-4000-8000-00000000d002', supplier: 'SUP-BEV', number: 'SRB-10442', daysAgo: 0, state: 'mapped',
    items: [['WATER-500', 96, 3900], ['GREENTEA-450', 48, 7800], ['BEER-330', 96, 12500], ['LEMON-330', 48, 7800]] },
  { id: 'c0ffee00-0000-4000-8000-00000000e003', ev: 'c0ffee00-0000-4000-8000-00000000d003', supplier: 'SUP-SNACK', number: 'SSS-3391', daysAgo: 1, state: 'arrived',
    items: [['CHIPS-POTATO', 48, 9400], ['CHIPS-PRAWN', 48, 6200], ['COOKIES', 12, 31200]] }
];

// mulberry32 — tiny deterministic PRNG.
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function roundUpTo(value, step) {
  return Math.ceil(value / step) * step;
}

export function buildCatalogue(seed = 20260901) {
  const rand = prng(seed);
  const leadBySupplier = new Map(SUPPLIERS.map((s) => [s.code, s.lead]));
  return PRODUCTS.map(([sku, name, unit, price, base, pack, supplier, low], i) => {
    const lead = leadBySupplier.get(supplier) ?? 2;
    const minQty = Math.ceil(base * (lead + 1));
    const reorderQty = roundUpTo(base * 7, pack);
    const onHand = low
      ? Math.max(1, Math.floor(minQty * (0.25 + rand() * 0.3)))
      : minQty + Math.ceil(base * (4 + rand() * 10));
    const noise = Array.from({ length: SALES_DAYS }, () => Math.round(80 + rand() * 40));
    const barcode = `893${String(1000000000 + i * 7919).slice(0, 10)}`;
    return {
      sku, name, unit, price, base, pack, supplier, low, lead,
      minQty, reorderQty, onHand, noise, barcode,
      unitCost: Math.round(price * 0.78 / 100) * 100
    };
  });
}

export function renderSeedSql(catalogue = buildCatalogue()) {
  const t = q(DEMO_TENANT_ID);
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('-- GENERATED by scripts/v2/gen_demo_seed.mjs — do not edit by hand.');
  push('-- ShopVoice demo tenant "Corner Mart Demo": 60 products, 5 suppliers,');
  push('-- 90 days of sales + today, 4 items below min_qty, 3 recent supplier invoices.');
  push('-- Deterministic for a given anchor date (demo.anchor_date setting, else today in Asia/Ho_Chi_Minh).');
  push('-- Requires a role that can write across RLS (the migration/superuser role).');
  push('BEGIN;');
  push();
  push(`SET LOCAL app.current_tenant = ${t};`);
  push();
  push('CREATE TEMP TABLE demo_anchor ON COMMIT DROP AS');
  push("SELECT COALESCE(NULLIF(current_setting('demo.anchor_date', true), '')::date,");
  push("                (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS d;");
  push();
  push('-- Reset demo tenant data (idempotent re-seed).');
  for (const table of [
    'sync_results', 'resolved_invoice_items', 'canonical_invoice_items', 'canonical_invoices',
    'inbound_events', 'voice_audit_log', 'purchase_order_drafts', 'sales_daily', 'reorder_rules',
    'stock_levels', 'suppliers', 'product_cache', 'shop_profiles'
  ]) {
    push(`DELETE FROM ${table} WHERE tenant_id = ${t};`);
  }
  push();
  push("INSERT INTO tenants (id, name, status, processing_mode)");
  push(`VALUES (${t}, 'Corner Mart Demo', 'active', 'v2')`);
  push("ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = 'active';");
  push();
  push("INSERT INTO platform_users (id, platform_user_id, display_name, platform)");
  push(`VALUES (${q(DEMO_USER_ID)}, 'shopvoice-demo-owner', 'Demo Owner', 'telegram')`);
  push('ON CONFLICT (id) DO NOTHING;');
  push();
  push('INSERT INTO tenant_users (id, tenant_id, user_id, role, status)');
  push(`VALUES (${q(DEMO_TENANT_USER_ID)}, ${t}, ${q(DEMO_USER_ID)}, 'owner', 'active')`);
  push('ON CONFLICT (tenant_id, user_id) DO NOTHING;');
  push();
  push('INSERT INTO shop_profiles (tenant_id, shop_name, display_currency, vnd_per_display_unit, timezone, locale)');
  push(`VALUES (${t}, 'Corner Mart Demo', 'USD', 25000, 'Asia/Ho_Chi_Minh', 'en-US');`);
  push();
  push('INSERT INTO suppliers (tenant_id, supplier_code, name, phone, default_lead_time_days) VALUES');
  push(SUPPLIERS.map((s) => `  (${t}, ${q(s.code)}, ${q(s.name)}, ${q(s.phone)}, ${s.lead})`).join(',\n') + ';');
  push();
  push('CREATE TEMP TABLE demo_products (');
  push('  sku TEXT, product_name TEXT, unit TEXT, barcode TEXT, price BIGINT, unit_cost BIGINT, base NUMERIC,');
  push('  pack NUMERIC, supplier TEXT, lead INT, min_qty NUMERIC, reorder_qty NUMERIC, on_hand NUMERIC, noise INT[]');
  push(') ON COMMIT DROP;');
  push('INSERT INTO demo_products VALUES');
  push(catalogue.map((p) => `  (${q(p.sku)}, ${q(p.name)}, ${q(p.unit)}, ${q(p.barcode)}, ${p.price}, ${p.unitCost}, ${p.base}, ${p.pack}, ${q(p.supplier)}, ${p.lead}, ${p.minQty}, ${p.reorderQty}, ${p.onHand},\n   ARRAY[${p.noise.join(',')}])`).join(',\n') + ';');
  push();
  push('INSERT INTO product_cache (tenant_id, sku, barcode, product_name, unit, active, base_price)');
  push(`SELECT ${t}, sku, barcode, product_name, unit, true, price FROM demo_products;`);
  push();
  push('INSERT INTO stock_levels (tenant_id, sku, on_hand_qty, unit, source, updated_at)');
  push(`SELECT ${t}, sku, on_hand, unit, 'seed', now() FROM demo_products;`);
  push();
  push('INSERT INTO reorder_rules (tenant_id, sku, min_qty, reorder_qty, pack_size, unit_cost_vnd, preferred_supplier_code, lead_time_days)');
  push(`SELECT ${t}, sku, min_qty, reorder_qty, pack, unit_cost, supplier, lead FROM demo_products;`);
  push();
  push('-- Sales: base demand x ISO-weekday multiplier (weekend spike) x per-day noise (80-120%).');
  push(`-- The last row (idx ${SALES_DAYS}) is "today so far" at ${Math.round(TODAY_FRACTION * 100)}% of a full day.`);
  push('INSERT INTO sales_daily (tenant_id, sale_date, sku, qty_sold, revenue_vnd, revenue_display)');
  push('SELECT tenant_id, sale_date, sku, qty, qty * price, round(qty * price / 25000.0, 2)');
  push('FROM (');
  push(`  SELECT ${t}::uuid AS tenant_id,`);
  push(`         (SELECT d FROM demo_anchor) - (${SALES_DAYS} - n.idx)::int AS sale_date,`);
  push('         p.sku, p.price,');
  push('         GREATEST(0, round(p.base');
  push(`           * (ARRAY[${WEEKDAY_MULTIPLIERS.join(', ')}])[extract(isodow FROM (SELECT d FROM demo_anchor) - (${SALES_DAYS} - n.idx)::int)::int]`);
  push('           * n.noise / 100.0');
  push(`           * CASE WHEN n.idx = ${SALES_DAYS} THEN ${TODAY_FRACTION} ELSE 1 END)) AS qty`);
  push('  FROM demo_products p');
  push('  CROSS JOIN LATERAL unnest(p.noise) WITH ORDINALITY AS n(noise, idx)');
  push(') s;');
  push();
  push('-- Three recent supplier invoices: synced (dry goods, 2 days ago),');
  push('-- mapped but not synced (beverages, this morning), arrived only (snacks, yesterday).');
  INVOICES.forEach((inv, invIndex) => {
    const total = inv.items.reduce((sum, [, qty, cost]) => sum + qty * cost, 0);
    push('INSERT INTO inbound_events (id, tenant_id, user_id, message_id, event_type, payload, status)');
    push(`VALUES (${q(inv.ev)}, ${t}, ${q(DEMO_USER_ID)}, ${q(`demo-${inv.number}`)}, 'image', '{"source":"demo_seed"}'::jsonb, 'completed')`);
    push('ON CONFLICT (id) DO NOTHING;');
    push('INSERT INTO canonical_invoices (id, tenant_id, inbound_event_id, invoice_fingerprint, supplier_code, invoice_number, invoice_date, currency, subtotal, total, created_at)');
    push(`VALUES (${q(inv.id)}, ${t}, ${q(inv.ev)}, ${q(`demo-${inv.number}`)}, ${q(inv.supplier)}, ${q(inv.number)},`);
    push(`        (SELECT d FROM demo_anchor) - ${inv.daysAgo}, 'VND', ${total}, ${total},`);
    push(`        ((SELECT d FROM demo_anchor) - ${inv.daysAgo} + time '08:30') AT TIME ZONE 'Asia/Ho_Chi_Minh');`);
    inv.items.forEach(([sku, qty, cost], i) => {
      const itemId = `c0ffee00-0000-4000-8000-00000000f${invIndex + 1}${String(i + 1).padStart(2, '0')}`;
      const name = PRODUCTS.find((p) => p[0] === sku)?.[1] ?? sku;
      push('INSERT INTO canonical_invoice_items (id, tenant_id, canonical_invoice_id, line_no, sku, product_name, quantity, unit_price, line_total)');
      push(`VALUES (${q(itemId)}, ${t}, ${q(inv.id)}, ${i + 1}, ${q(sku)}, ${q(name)}, ${qty}, ${cost}, ${qty * cost});`);
      if (inv.state !== 'arrived') {
        push('INSERT INTO resolved_invoice_items (tenant_id, canonical_invoice_id, canonical_item_id, status, resolved_sku, quantity)');
        push(`VALUES (${t}, ${q(inv.id)}, ${q(itemId)}, 'resolved', ${q(sku)}, ${qty});`);
      }
    });
    if (inv.state === 'synced') {
      push("INSERT INTO sync_results (tenant_id, canonical_invoice_id, external_system, external_reference_id, status)");
      push(`VALUES (${t}, ${q(inv.id)}, 'kiotviet', 'PN-DEMO-000123', 'success');`);
    }
  });
  push();
  push('COMMIT;');
  return `${lines.join('\n')}\n`;
}

export function todayInTimezone(timeZone = 'Asia/Ho_Chi_Minh', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

function isoDow(date) {
  const [y, m, d] = date.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/**
 * The same demo data as the SQL seed, as a plain object for the MCP server's
 * in-memory store (tests, CI without Postgres, offline demos). Quantities use
 * integer arithmetic so they match Postgres numeric rounding exactly.
 */
export function buildDemoDataset({ anchorDate, tokens = {} } = {}) {
  const today = anchorDate || todayInTimezone();
  const catalogue = buildCatalogue();
  const multipliers = WEEKDAY_MULTIPLIERS.map((m) => Math.round(m * 100));
  const todayTenths = Math.round(TODAY_FRACTION * 10);
  const sales = [];
  for (const p of catalogue) {
    p.noise.forEach((noise, i) => {
      const idx = i + 1;
      const date = shiftDate(today, -(SALES_DAYS - idx));
      const numer = p.base * multipliers[isoDow(date) - 1] * noise * (idx === SALES_DAYS ? todayTenths : 10);
      const qty = Math.max(0, Math.round(numer / 100_000));
      sales.push({ date, sku: p.sku, qty, revenueVnd: qty * p.price });
    });
  }
  const supplierNames = new Map(SUPPLIERS.map((s) => [s.code, s.name]));
  const productNames = new Map(PRODUCTS.map((p) => [p[0], p[1]]));
  const invoices = INVOICES.map((inv) => {
    const date = shiftDate(today, -inv.daysAgo);
    return {
      id: inv.id,
      invoiceNumber: inv.number,
      supplierCode: inv.supplier,
      supplierName: supplierNames.get(inv.supplier) ?? null,
      invoiceDate: date,
      receivedAt: new Date(`${date}T08:30:00+07:00`).toISOString(),
      totalVnd: inv.items.reduce((sum, [, qty, cost]) => sum + qty * cost, 0),
      lineCount: inv.items.length,
      resolvedCount: inv.state === 'arrived' ? 0 : inv.items.length,
      synced: inv.state === 'synced',
      productNames: inv.items.map(([sku]) => productNames.get(sku) ?? sku)
    };
  });
  return {
    tenants: {
      [DEMO_TENANT_ID]: {
        profile: { shopName: 'Corner Mart Demo', displayCurrency: 'USD', vndPerDisplayUnit: 25000, timezone: 'Asia/Ho_Chi_Minh', locale: 'en-US' },
        today,
        products: catalogue.map((p) => ({
          sku: p.sku, name: p.name, unit: p.unit, barcode: p.barcode, onHand: p.onHand, minQty: p.minQty,
          reorderQty: p.reorderQty, packSize: p.pack, unitCostVnd: p.unitCost, supplierCode: p.supplier, leadTimeDays: p.lead
        })),
        sales,
        suppliers: SUPPLIERS.map((s) => ({ code: s.code, name: s.name, leadTimeDays: s.lead })),
        invoices
      }
    },
    tokens
  };
}

// ---- Sandbox shops (Claude connector sign-ups) ----------------------------
// Every web sign-up gets its own copy of the demo catalogue, labelled as
// sample data. Postgres: the JSON below feeds seed_sandbox_shop() (migration
// 018). Memory backend: buildSandboxTenantData() gives the same numbers.
export const SANDBOX_PROFILES = {
  en: { shop_name: 'Demo shop (sample data)', display_currency: 'USD', vnd_per_display_unit: 25000, locale: 'en-US' },
  vi: { shop_name: 'Cửa hàng mẫu (dữ liệu mẫu)', display_currency: 'VND', vnd_per_display_unit: 1, locale: 'vi-VN' }
};

export function buildSandboxCatalogue() {
  return {
    profiles: SANDBOX_PROFILES,
    sales_days: SALES_DAYS,
    today_fraction: TODAY_FRACTION,
    weekday_multipliers: WEEKDAY_MULTIPLIERS,
    suppliers: SUPPLIERS.map((s) => ({ code: s.code, name: s.name, phone: s.phone, lead: s.lead })),
    products: buildCatalogue().map((p) => ({
      sku: p.sku, name: p.name, unit: p.unit, barcode: p.barcode, price: p.price, unit_cost: p.unitCost, base: p.base,
      pack: p.pack, supplier: p.supplier, lead: p.lead, min_qty: p.minQty, reorder_qty: p.reorderQty, on_hand: p.onHand,
      noise: p.noise
    })),
    invoices: INVOICES.map((inv) => ({ number: inv.number, supplier: inv.supplier, days_ago: inv.daysAgo, state: inv.state, items: inv.items }))
  };
}

export function buildSandboxTenantData(locale = 'en', anchorDate = todayInTimezone()) {
  const profile = SANDBOX_PROFILES[locale] ?? SANDBOX_PROFILES.en;
  const base = buildDemoDataset({ anchorDate }).tenants[DEMO_TENANT_ID];
  return {
    ...base,
    profile: {
      shopName: profile.shop_name,
      displayCurrency: profile.display_currency,
      vndPerDisplayUnit: profile.vnd_per_display_unit,
      timezone: 'Asia/Ho_Chi_Minh',
      locale: profile.locale
    }
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  process.stdout.write(renderSeedSql());
}
