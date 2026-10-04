// ShopVoice Pay demo data: one fictional US corner store and four fictional
// suppliers, all in USD (integer cents). Deterministic: a fixed PRNG seed gives
// the same catalogue, sales noise and stock levels on every run. Dates are
// relative to an anchor date (default: today in America/New_York; override with
// DEMO_ANCHOR_DATE / the `demo.anchor_date` setting).
//
// The same catalogue feeds three places, so they always agree:
//   - Postgres: seed_sandbox_shop() (migration 020) for the demo tenant and for
//     every "Try the demo" sign-up; db/seed/002_demo_shop_seed.sql calls it.
//   - Memory backend: buildDemoDataset() / buildSandboxTenantData().
//   - Tests and the hero-story e2e.
//
// Hero story numbers (docs/paypal/DEMO_SCRIPT.md):
//   "Reorder milk and eggs" -> 12 crates of whole milk x $7.00 = $84 (auto-pay)
//                              10 cases of large eggs x $14.20 = $142 (step-up:
//                              the price is 31% above the 30-day average $10.85)
//   Harbor Wholesale is not on the approved supplier list (blocked).
//
// All names are generic and fictional. Usage:
//   node scripts/gen_demo_seed.mjs > db/seed/002_demo_shop_seed.sql

export const DEMO_TENANT_ID = 'c0ffee00-0000-4000-8000-000000000001';
export const DEMO_USER_ID = 'c0ffee00-0000-4000-8000-0000000000a1';
export const DEMO_TENANT_USER_ID = 'c0ffee00-0000-4000-8000-0000000000b1';
export const DEMO_TIMEZONE = 'America/New_York';
export const DEMO_SHOP_NAME = "Maria's Corner Market (demo)";
export const SALES_DAYS = 31; // 30 full days of history + today
export const TODAY_FRACTION = 0.7; // "today so far" (mid-afternoon)
export const WEEKDAY_MULTIPLIERS = [0.9, 0.85, 0.9, 0.95, 1.1, 1.45, 1.35]; // ISO Mon..Sun

export const SUPPLIERS = [
  { code: 'SUP-DAIRY', name: 'Northside Dairy', phone: '+1 718 555 0101', lead: 1, email: 'northside.dairy@business.example.com', allowListed: true },
  { code: 'SUP-EGGS', name: 'Valley Farm Eggs', phone: '+1 718 555 0102', lead: 2, email: 'valley.farm.eggs@business.example.com', allowListed: true },
  { code: 'SUP-BAKERY', name: 'Hillside Bakery', phone: '+1 718 555 0103', lead: 1, email: 'hillside.bakery@business.example.com', allowListed: true },
  { code: 'SUP-HARBOR', name: 'Harbor Wholesale', phone: '+1 718 555 0104', lead: 3, email: 'harbor.wholesale@business.example.com', allowListed: false }
];

// [sku, name, unit, shelf price ¢, unit cost ¢, base daily units x10, pack, supplier, low]
export const PRODUCTS = [
  ['MILK-WHOLE', 'Whole milk 1 gal (crate of 2)', 'crate', 899, 700, 12, 12, 'SUP-DAIRY', true],
  ['MILK-2PCT', 'Reduced-fat milk 1 gal', 'gallon', 449, 340, 30, 6, 'SUP-DAIRY', false],
  ['HALF-HALF', 'Half and half 1 qt', 'carton', 399, 280, 20, 6, 'SUP-DAIRY', false],
  ['YOGURT-CUPS', 'Fruit yogurt cups 4-pack', 'pack', 499, 360, 30, 12, 'SUP-DAIRY', false],
  ['YOGURT-GREEK', 'Plain Greek yogurt 32 oz', 'tub', 649, 470, 15, 6, 'SUP-DAIRY', false],
  ['BUTTER', 'Salted butter 1 lb', 'box', 599, 430, 15, 12, 'SUP-DAIRY', false],
  ['CHEESE-SLICES', 'American cheese slices 12 oz', 'pack', 449, 320, 20, 12, 'SUP-DAIRY', false],
  ['CREAM-CHEESE', 'Cream cheese 8 oz', 'box', 329, 230, 15, 12, 'SUP-DAIRY', false],
  ['OJ-52', 'Orange juice 52 oz', 'bottle', 549, 390, 20, 6, 'SUP-DAIRY', false],
  ['EGGS-30', 'Large eggs 30 ct', 'case', 1899, 1420, 8, 10, 'SUP-EGGS', true],
  ['EGGS-15', 'Large eggs 15 ct', 'pack', 999, 720, 5, 20, 'SUP-EGGS', false],
  ['EGGS-DOZEN', 'Large eggs dozen', 'carton', 449, 300, 40, 15, 'SUP-EGGS', false],
  ['EGGS-BROWN', 'Brown eggs dozen', 'carton', 549, 380, 15, 15, 'SUP-EGGS', false],
  ['BREAD-WHITE', 'White sandwich bread 20 oz', 'loaf', 349, 230, 50, 10, 'SUP-BAKERY', true],
  ['BREAD-WHEAT', 'Whole wheat bread 20 oz', 'loaf', 399, 260, 30, 10, 'SUP-BAKERY', false],
  ['BAGELS', 'Plain bagels 6-pack', 'bag', 449, 290, 25, 8, 'SUP-BAKERY', false],
  ['BUNS-BURGER', 'Hamburger buns 8-pack', 'bag', 379, 240, 15, 8, 'SUP-BAKERY', false],
  ['MUFFINS', 'Blueberry muffins 4-pack', 'pack', 499, 330, 15, 8, 'SUP-BAKERY', false],
  ['TORTILLAS', 'Flour tortillas 10 ct', 'bag', 349, 220, 15, 12, 'SUP-BAKERY', false],
  ['ROLLS', 'Kaiser rolls 6-pack', 'bag', 399, 250, 12, 8, 'SUP-BAKERY', false],
  ['WATER-24', 'Spring water 24 x 16.9 oz', 'case', 599, 380, 30, 6, 'SUP-HARBOR', false],
  ['COLA-12', 'Cola 12 x 12 oz cans', 'pack', 799, 560, 40, 6, 'SUP-HARBOR', false],
  ['SODA-LIME-2L', 'Lemon-lime soda 2 L', 'bottle', 299, 180, 30, 8, 'SUP-HARBOR', false],
  ['SPORTS-20', 'Sports drink 20 oz', 'bottle', 229, 130, 60, 24, 'SUP-HARBOR', false],
  ['ENERGY-16', 'Energy drink 16 oz', 'can', 329, 200, 50, 24, 'SUP-HARBOR', false],
  ['ICED-TEA', 'Sweet iced tea 18.5 oz', 'bottle', 199, 110, 50, 12, 'SUP-HARBOR', false],
  ['COLD-BREW', 'Cold brew coffee 11 oz', 'bottle', 399, 250, 20, 12, 'SUP-HARBOR', false],
  ['CHIPS-POTATO', 'Potato chips 8 oz', 'bag', 449, 280, 40, 12, 'SUP-HARBOR', false],
  ['CHIPS-TORTILLA', 'Tortilla chips 11 oz', 'bag', 499, 310, 25, 12, 'SUP-HARBOR', false],
  ['PRETZELS', 'Pretzel twists 16 oz', 'bag', 399, 240, 15, 12, 'SUP-HARBOR', false],
  ['PEANUTS', 'Salted peanuts 16 oz', 'jar', 449, 280, 10, 12, 'SUP-HARBOR', false],
  ['CANDY-BAR', 'Chocolate bar 1.5 oz', 'bar', 179, 95, 80, 36, 'SUP-HARBOR', false],
  ['GUM', 'Mint gum 14 ct', 'pack', 179, 90, 50, 20, 'SUP-HARBOR', false],
  ['RAMEN-6', 'Instant ramen 6-pack', 'pack', 349, 210, 20, 8, 'SUP-HARBOR', false],
  ['PASTA', 'Spaghetti 1 lb', 'box', 179, 100, 30, 20, 'SUP-HARBOR', false],
  ['RICE-5LB', 'Long-grain rice 5 lb', 'bag', 649, 420, 10, 8, 'SUP-HARBOR', false],
  ['BEANS-BLACK', 'Black beans 15 oz', 'can', 149, 80, 30, 24, 'SUP-HARBOR', false],
  ['TUNA', 'Chunk light tuna 5 oz', 'can', 199, 115, 25, 24, 'SUP-HARBOR', false],
  ['PEANUT-BUTTER', 'Creamy peanut butter 16 oz', 'jar', 399, 250, 10, 12, 'SUP-HARBOR', false],
  ['CEREAL', 'Toasted oat cereal 12 oz', 'box', 499, 320, 15, 12, 'SUP-HARBOR', false],
  ['COFFEE-GROUND', 'Ground coffee 12 oz', 'bag', 899, 590, 10, 6, 'SUP-HARBOR', false],
  ['PAPER-TOWELS', 'Paper towels 6 rolls', 'pack', 999, 640, 15, 6, 'SUP-HARBOR', true],
  ['BATH-TISSUE', 'Bath tissue 12 rolls', 'pack', 1299, 850, 15, 6, 'SUP-HARBOR', false],
  ['DISH-SOAP', 'Dish soap 24 oz', 'bottle', 349, 210, 10, 12, 'SUP-HARBOR', false],
  ['DETERGENT', 'Laundry detergent 50 oz', 'bottle', 1199, 780, 7, 6, 'SUP-HARBOR', false],
  ['TRASH-BAGS', 'Kitchen trash bags 40 ct', 'box', 899, 560, 6, 6, 'SUP-HARBOR', false],
  ['ICE-7LB', 'Ice 7 lb bag', 'bag', 349, 150, 40, 20, 'SUP-HARBOR', false]
];

/** On-hand counts for the four low items, so the hero story is identical every run. */
const LOW_ON_HAND = { 'MILK-WHOLE': 2, 'EGGS-30': 1, 'BREAD-WHITE': 4, 'PAPER-TOWELS': 1 };

/** 30-day unit-cost history (days ago, ¢). Eggs jumped from about $10.85 to $14.20 (+31%). */
const PRICE_OVERRIDES = { 'EGGS-30': [[27, 1080], [20, 1090], [13, 1085], [6, 1085]] };
const PRICE_DAYS = [27, 20, 13, 6];

/** Past orders that shaped the "usual quantity" baseline and the ledger history. */
export const PAST_ORDERS = [
  { supplier: 'SUP-DAIRY', sku: 'MILK-WHOLE', qty: 12, unitCost: 700, daysAgo: [22, 15, 9] },
  { supplier: 'SUP-EGGS', sku: 'EGGS-30', qty: 10, daysAgo: [23, 16, 9] },
  { supplier: 'SUP-BAKERY', sku: 'BREAD-WHITE', qty: 20, unitCost: 230, daysAgo: [21, 14, 8] }
];

export const DEMO_POLICY = {
  currency: 'USD',
  perOrderAutopayMaxMinor: 10_000,
  dailyMaxMinor: 50_000,
  weeklyMaxMinor: 150_000,
  dailyHardCapMinor: 100_000,
  weeklyHardCapMinor: 300_000,
  priceJumpPct: 20,
  substitutionTolerancePct: 5,
  quantitySpikeMultiplier: 3,
  requireDeliveryCheck: true
};

// Three recent supplier invoices (USD cents): recorded (dairy, 2 days ago),
// matched but not recorded (wholesale, this morning), arrived only (bakery, yesterday).
export const INVOICES = [
  { id: 'c0ffee00-0000-4000-8000-00000000e001', ev: 'c0ffee00-0000-4000-8000-00000000d001', supplier: 'SUP-DAIRY', number: 'ND-24817', daysAgo: 2, state: 'synced',
    items: [['MILK-2PCT', 12, 340], ['YOGURT-CUPS', 24, 360], ['BUTTER', 12, 430]] },
  { id: 'c0ffee00-0000-4000-8000-00000000e002', ev: 'c0ffee00-0000-4000-8000-00000000d002', supplier: 'SUP-HARBOR', number: 'HW-10442', daysAgo: 0, state: 'mapped',
    items: [['WATER-24', 12, 380], ['SPORTS-20', 48, 130], ['CHIPS-POTATO', 24, 280], ['ICE-7LB', 40, 150]] },
  { id: 'c0ffee00-0000-4000-8000-00000000e003', ev: 'c0ffee00-0000-4000-8000-00000000d003', supplier: 'SUP-BAKERY', number: 'HB-3391', daysAgo: 1, state: 'arrived',
    items: [['BREAD-WHEAT', 20, 260], ['BAGELS', 16, 290], ['MUFFINS', 8, 330]] }
];

// mulberry32: tiny deterministic PRNG.
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

function roundUpTo(value, step) {
  return Math.ceil(value / step) * step;
}

export function buildCatalogue(seed = 20261001) {
  const rand = prng(seed);
  const leadBySupplier = new Map(SUPPLIERS.map((s) => [s.code, s.lead]));
  return PRODUCTS.map(([sku, name, unit, price, unitCost, base10, pack, supplier, low], i) => {
    const lead = leadBySupplier.get(supplier) ?? 2;
    const minQty = Math.ceil((base10 * (lead + 1)) / 10);
    const reorderQty = roundUpTo((base10 * 7) / 10, pack);
    const onHand = low ? LOW_ON_HAND[sku] : minQty + Math.ceil((base10 * (4 + rand() * 10)) / 10);
    const noise = Array.from({ length: SALES_DAYS }, () => Math.round(80 + rand() * 40));
    const barcode = `0${String(41_000_000_000 + i * 7919).padStart(11, '0')}`;
    return { sku, name, unit, price, unitCost, base10, pack, supplier, low, lead, minQty, reorderQty, onHand, noise, barcode };
  });
}

/** Supplier payees, with sandbox emails taken from env when provided (Northside Dairy first). */
export function buildPayees(env = process.env) {
  const sandbox = [env.SANDBOX_SUPPLIER_EMAIL, ...(env.SANDBOX_SUPPLIER_EMAILS ?? '').split(',')].map((e) => (e ?? '').trim()).filter(Boolean);
  return SUPPLIERS.map((s, i) => ({
    supplier: s.code,
    email: sandbox[i] || s.email,
    verified: s.allowListed
  }));
}

function priceHistoryRows(catalogue) {
  const rows = [];
  for (const p of catalogue) {
    if (p.supplier === 'SUP-HARBOR') continue;
    const points = PRICE_OVERRIDES[p.sku] ?? PRICE_DAYS.map((d) => [d, p.unitCost]);
    for (const [daysAgo, cost] of points) rows.push({ supplier: p.supplier, sku: p.sku, unit_cost: cost, days_ago: daysAgo });
  }
  return rows;
}

function pastOrderRows(catalogue) {
  const byId = new Map(catalogue.map((p) => [p.sku, p]));
  const rows = [];
  for (const o of PAST_ORDERS) {
    const p = byId.get(o.sku);
    o.daysAgo.forEach((daysAgo, i) => {
      // Past egg orders were at the old price.
      const unitCost = o.unitCost ?? (PRICE_OVERRIDES[o.sku]?.[i]?.[1] ?? p.unitCost);
      rows.push({ supplier: o.supplier, sku: o.sku, name: p.name, unit: p.unit, qty: o.qty, unit_cost: unitCost, days_ago: daysAgo });
    });
  }
  return rows;
}

/** JSON consumed by seed_sandbox_shop() (migration 020). */
export function buildSandboxCatalogue(env = process.env, shopName = 'Your demo shop (sample data)') {
  const catalogue = buildCatalogue();
  return {
    profiles: { en: { shop_name: shopName, display_currency: 'USD', minor_per_unit: 100, locale: 'en-US', timezone: DEMO_TIMEZONE } },
    sales_days: SALES_DAYS,
    today_fraction: TODAY_FRACTION,
    weekday_multipliers: WEEKDAY_MULTIPLIERS,
    suppliers: SUPPLIERS.map((s) => ({ code: s.code, name: s.name, phone: s.phone, lead: s.lead })),
    products: catalogue.map((p) => ({
      sku: p.sku, name: p.name, unit: p.unit, barcode: p.barcode, price: p.price, unit_cost: p.unitCost, base10: p.base10,
      pack: p.pack, supplier: p.supplier, lead: p.lead, min_qty: p.minQty, reorder_qty: p.reorderQty, on_hand: p.onHand,
      noise: p.noise
    })),
    invoices: INVOICES.map((inv) => ({ number: inv.number, supplier: inv.supplier, days_ago: inv.daysAgo, state: inv.state, items: inv.items })),
    policy: {
      per_order_autopay_max_minor: DEMO_POLICY.perOrderAutopayMaxMinor,
      daily_max_minor: DEMO_POLICY.dailyMaxMinor,
      weekly_max_minor: DEMO_POLICY.weeklyMaxMinor,
      daily_hard_cap_minor: DEMO_POLICY.dailyHardCapMinor,
      weekly_hard_cap_minor: DEMO_POLICY.weeklyHardCapMinor,
      allow_listed: SUPPLIERS.filter((s) => s.allowListed).map((s) => s.code),
      price_jump_pct: DEMO_POLICY.priceJumpPct,
      substitution_tolerance_pct: DEMO_POLICY.substitutionTolerancePct,
      quantity_spike_multiplier: DEMO_POLICY.quantitySpikeMultiplier
    },
    payees: buildPayees(env),
    prices: priceHistoryRows(catalogue),
    past_orders: pastOrderRows(catalogue)
  };
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** db/seed/002: the demo tenant, seeded by the same SQL function as every sandbox shop. */
export function renderSeedSql() {
  const t = q(DEMO_TENANT_ID);
  // Emails in the committed file are the fictional defaults; the server re-seeds with sandbox emails from env.
  const catalogue = JSON.stringify(buildSandboxCatalogue({}, DEMO_SHOP_NAME));
  return [
    '-- GENERATED by scripts/gen_demo_seed.mjs; do not edit by hand.',
    `-- ShopVoice Pay demo tenant "${DEMO_SHOP_NAME}": ${PRODUCTS.length} products, ${SUPPLIERS.length} suppliers (all fictional, USD),`,
    `-- ${SALES_DAYS - 1} days of sales + today, spending policy, payees, price history and past orders.`,
    `-- Deterministic for an anchor date (demo.anchor_date setting, else today in ${DEMO_TIMEZONE}).`,
    '-- Requires a role that can call seed_sandbox_shop() (the migration/superuser role).',
    'BEGIN;',
    'INSERT INTO tenants (id, name, status, processing_mode)',
    `VALUES (${t}, ${q(DEMO_SHOP_NAME)}, 'active', 'v2')`,
    "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = 'active';",
    'INSERT INTO platform_users (id, platform_user_id, display_name, platform)',
    `VALUES (${q(DEMO_USER_ID)}, 'shopvoice-demo-owner', 'Demo Owner', 'telegram')`,
    'ON CONFLICT (id) DO NOTHING;',
    'INSERT INTO tenant_users (id, tenant_id, user_id, role, status)',
    `VALUES (${q(DEMO_TENANT_USER_ID)}, ${t}, ${q(DEMO_USER_ID)}, 'owner', 'active')`,
    'ON CONFLICT (tenant_id, user_id) DO NOTHING;',
    `SELECT seed_sandbox_shop(${t}, ${q(DEMO_USER_ID)}, ${q(catalogue)}::jsonb,`,
    `  COALESCE(NULLIF(current_setting('demo.anchor_date', true), '')::date, (now() AT TIME ZONE ${q(DEMO_TIMEZONE)})::date), 'en');`,
    'COMMIT;',
    ''
  ].join('\n');
}

export function todayInTimezone(timeZone = DEMO_TIMEZONE, now = new Date()) {
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

/** Noon New York time on a calendar date, as an ISO timestamp (seeded history). */
function noonNy(date) {
  return new Date(`${date}T16:00:00Z`).toISOString();
}

/**
 * The same shop as the SQL seed, for the in-memory store. Quantities use
 * integer arithmetic so they match Postgres numeric rounding exactly.
 */
export function buildTenantData({ anchorDate, shopName = DEMO_SHOP_NAME, env = process.env } = {}) {
  const today = anchorDate || todayInTimezone();
  const catalogue = buildCatalogue();
  const multipliers = WEEKDAY_MULTIPLIERS.map((m) => Math.round(m * 100));
  const todayTenths = Math.round(TODAY_FRACTION * 10);
  const sales = [];
  for (const p of catalogue) {
    p.noise.forEach((noise, i) => {
      const idx = i + 1;
      const date = shiftDate(today, -(SALES_DAYS - idx));
      // base10/10 x mult/100 x noise/100 x tenths/10, kept integer until the final rounding.
      const numer = p.base10 * multipliers[isoDow(date) - 1] * noise * (idx === SALES_DAYS ? todayTenths : 10);
      const qty = Math.max(0, Math.round(numer / 1_000_000));
      sales.push({ date, sku: p.sku, qty, revenueMinor: qty * p.price });
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
      receivedAt: new Date(`${date}T12:30:00Z`).toISOString(),
      totalMinor: inv.items.reduce((sum, [, qty, cost]) => sum + qty * cost, 0),
      lineCount: inv.items.length,
      resolvedCount: inv.state === 'arrived' ? 0 : inv.items.length,
      synced: inv.state === 'synced',
      productNames: inv.items.map(([sku]) => productNames.get(sku) ?? sku)
    };
  });
  const sandbox = buildSandboxCatalogue(env, shopName);
  const pastOrders = sandbox.past_orders;
  const pastQuantities = {};
  for (const o of pastOrders) (pastQuantities[o.sku] ??= []).push(o.qty);
  return {
    profile: { shopName, displayCurrency: 'USD', minorPerUnit: 100, timezone: DEMO_TIMEZONE, locale: 'en-US' },
    today,
    products: catalogue.map((p) => ({
      sku: p.sku, name: p.name, unit: p.unit, barcode: p.barcode, onHand: p.onHand, minQty: p.minQty,
      reorderQty: p.reorderQty, packSize: p.pack, unitCostMinor: p.unitCost, supplierCode: p.supplier, leadTimeDays: p.lead
    })),
    sales,
    suppliers: SUPPLIERS.map((s) => ({ code: s.code, name: s.name, leadTimeDays: s.lead })),
    invoices,
    payments: {
      policy: { ...DEMO_POLICY, allowListedSupplierIds: sandbox.policy.allow_listed },
      payees: sandbox.payees.map((p) => ({ supplierCode: p.supplier, paypalEmail: p.email, paypalMerchantId: null, currency: 'USD', verified: p.verified })),
      prices: sandbox.prices.map((r) => ({ supplierCode: r.supplier, sku: r.sku, unitCostMinor: r.unit_cost, currency: 'USD', observedOn: shiftDate(today, -r.days_ago) })),
      pastQuantities,
      history: pastOrders.map((o) => ({
        supplierCode: o.supplier,
        lines: [{ sku: o.sku, name: o.name, qty: o.qty, unitCostMinor: o.unit_cost }],
        amountMinor: o.qty * o.unit_cost,
        createdAt: noonNy(shiftDate(today, -o.days_ago))
      }))
    }
  };
}

/** Memory-backend dataset: the demo tenant plus bearer tokens. */
export function buildDemoDataset({ anchorDate, tokens = {}, env = process.env } = {}) {
  return { tenants: { [DEMO_TENANT_ID]: buildTenantData({ anchorDate, env }) }, tokens };
}

// ---- Sandbox shops ("Try the demo" / Claude connector sign-ups) ------------
export const SANDBOX_PROFILES = {
  en: { shop_name: 'Your demo shop (sample data)', display_currency: 'USD', minor_per_unit: 100, locale: 'en-US' }
};

export function buildSandboxTenantData(_locale = 'en', anchorDate = todayInTimezone(), env = process.env) {
  return buildTenantData({ anchorDate, shopName: SANDBOX_PROFILES.en.shop_name, env });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  process.stdout.write(renderSeedSql());
}
