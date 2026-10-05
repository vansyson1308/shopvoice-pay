// A simulated supplier's seller agent: the merchant side of PayPal's Cart API
// v1 spec (create, read, replace and check out a cart; business problems are
// reported as validation_issues). ShopVoice's buyer agent calls it the way
// PayPal would call a merchant: with an RS256 JWT scoped to "cart" for one
// merchant_id. Labelled "simulated" everywhere it is shown; in production
// PayPal Store Sync connects real suppliers.
import { randomUUID } from 'node:crypto';
import { JwtError, verifyJwt } from '../../../packages/common/dist/index.js';
import type { PublicJwk } from '../../../packages/common/dist/index.js';
import { fromMoney, toMoney } from './cart-types.js';
import type { Cart, CartItem, PaymentMethod, ValidationIssue } from './cart-types.js';

export interface CatalogItem {
  readonly variantId: string;
  readonly name: string;
  readonly priceMinor: number;
  /** null = always in stock. */
  stock: number | null;
  /** Offered when this item is short: each requested unit becomes `perUnit` of the alternative. */
  readonly alternatives?: readonly { readonly variantId: string; readonly perUnit: number }[];
}

export interface SupplierCatalog {
  readonly supplierCode: string;
  readonly name: string;
  readonly currency: string;
  readonly orderPrefix: string;
  readonly items: CatalogItem[];
}

export interface AgentResponse {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

export const SUPPLIER_AGENT_AUDIENCE = 'shopvoice-supplier-agent';
const CART_TTL_MS = 24 * 3600_000;
const MAX_CARTS = 10_000;

interface StoredCart {
  readonly supplierCode: string;
  cart: Cart;
  expiresAt: number;
}

function issueFor(item: CartItem, catalog: SupplierCatalog): ValidationIssue | null {
  const entry = catalog.items.find((i) => i.variantId === item.variant_id);
  if (!entry) {
    return {
      code: 'INVENTORY_ISSUE', type: 'BUSINESS_RULE', variant_id: item.variant_id,
      message: `Variant ${item.variant_id} is not sold by ${catalog.name}.`, user_message: 'This item is not available.',
      context: { specific_issue: 'ITEM_NOT_AVAILABLE' },
      resolution_options: [{ action: 'REMOVE_ITEM', label: 'Remove the item' }]
    };
  }
  if (entry.stock !== null && item.quantity > entry.stock) {
    const alternatives = (entry.alternatives ?? []).flatMap((alt) => {
      const other = catalog.items.find((i) => i.variantId === alt.variantId);
      const need = item.quantity * alt.perUnit;
      return other && (other.stock === null || other.stock >= need)
        ? [{ variant_id: other.variantId, name: other.name, price: toMoney(other.priceMinor, catalog.currency), quantity: need }]
        : [];
    });
    return {
      code: 'INVENTORY_ISSUE', type: 'BUSINESS_RULE', variant_id: item.variant_id,
      message: `Only ${entry.stock} of ${entry.name} in stock.`, user_message: `${entry.name} is out of stock.`,
      context: { specific_issue: 'ITEM_OUT_OF_STOCK', available_quantity: entry.stock, suggested_alternatives: alternatives },
      resolution_options: [...(alternatives.length ? [{ action: 'SUGGEST_ALTERNATIVE' as const, label: 'Use the suggested alternative' }] : []), { action: 'REMOVE_ITEM', label: 'Remove the item' }]
    };
  }
  const expected = fromMoney(item.price);
  if (expected !== null && expected < entry.priceMinor) {
    return {
      code: 'PRICING_ERROR', type: 'BUSINESS_RULE', variant_id: item.variant_id,
      message: `The price of ${entry.name} changed.`, user_message: 'The price changed.',
      context: { specific_issue: 'PRICE_MISMATCH', expected_price: toMoney(expected, catalog.currency), current_price: toMoney(entry.priceMinor, catalog.currency) },
      resolution_options: [{ action: 'ACCEPT_NEW_PRICE', label: 'Accept the new price' }, { action: 'REMOVE_ITEM', label: 'Remove the item' }]
    };
  }
  return null;
}

/** Strict request parsing: a list of {variant_id, quantity, name?, price?}; anything else is a 400. */
function parseItems(raw: unknown): CartItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) return null;
  const items: CartItem[] = [];
  for (const entry of raw) {
    const row = (entry ?? {}) as Record<string, unknown>;
    if (typeof row.variant_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.variant_id)) return null;
    if (!Number.isSafeInteger(row.quantity) || (row.quantity as number) < 1 || (row.quantity as number) > 100_000) return null;
    const price = row.price as CartItem['price'] | undefined;
    if (price !== undefined && fromMoney(price) === null) return null;
    items.push({ variant_id: row.variant_id, quantity: row.quantity as number, ...(price ? { price } : {}) });
  }
  return items;
}

export class SupplierAgent {
  private readonly carts = new Map<string, StoredCart>();
  private readonly byRequestId = new Map<string, string>();
  private orderNumber = 1000;

  constructor(
    private readonly catalogs: readonly SupplierCatalog[],
    private readonly buyerKeys: () => readonly PublicJwk[],
    private readonly now: () => number = Date.now
  ) {}

  catalog(code: string): SupplierCatalog | undefined {
    return this.catalogs.find((c) => c.supplierCode === code);
  }

  private build(id: string, catalog: SupplierCatalog, items: readonly CartItem[], created: string, extra: Partial<Cart> = {}): Cart {
    const issues = items.map((i) => issueFor(i, catalog)).filter((x): x is ValidationIssue => x !== null);
    const priced = items.map((i) => {
      const entry = catalog.items.find((c) => c.variantId === i.variant_id);
      return { variant_id: i.variant_id, quantity: i.quantity, name: entry?.name ?? i.variant_id, price: toMoney(entry?.priceMinor ?? 0, catalog.currency) };
    });
    const totalMinor = priced.reduce((acc, i) => acc + i.quantity * (fromMoney(i.price) ?? 0), 0);
    return {
      id, status: issues.length ? 'INCOMPLETE' : 'READY', validation_status: issues.length ? 'INVALID' : 'VALID', validation_issues: issues,
      items: priced, totals: { subtotal: toMoney(totalMinor, catalog.currency), total: toMoney(totalMinor, catalog.currency) },
      create_time: created, update_time: new Date(this.now()).toISOString(), ...extra
    };
  }

  private authorize(supplierCode: string, headers: Record<string, string | undefined>): AgentResponse | null {
    const auth = headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) return { status: 401, json: { name: 'UNAUTHORIZED', message: 'A bearer token is required.' } };
    try {
      const claims = verifyJwt(auth.slice(7), this.buyerKeys(), { audience: SUPPLIER_AGENT_AUDIENCE, nowMs: this.now() });
      if (claims.merchant_id !== supplierCode) return { status: 403, json: { name: 'FORBIDDEN', message: 'The token is for another merchant.' } };
      if (!Array.isArray(claims.scope) || !claims.scope.includes('cart')) return { status: 403, json: { name: 'FORBIDDEN', message: 'The token lacks the cart scope.' } };
      return null;
    } catch (error) {
      return { status: 401, json: { name: 'UNAUTHORIZED', message: error instanceof JwtError ? error.message : 'invalid token' } };
    }
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, c] of this.carts) if (c.expiresAt <= t) this.carts.delete(id);
    while (this.carts.size >= MAX_CARTS) this.carts.delete(this.carts.keys().next().value as string);
  }

  /** One Cart API call for a supplier. `path` is relative to /merchant-cart. */
  async handle(supplierCode: string, method: string, path: string, headers: Record<string, string | undefined>, body: unknown): Promise<AgentResponse> {
    const catalog = this.catalog(supplierCode);
    if (!catalog) return { status: 404, json: { name: 'RESOURCE_NOT_FOUND', message: 'Unknown merchant.' } };
    const denied = this.authorize(supplierCode, headers);
    if (denied) return denied;
    const input = (body ?? {}) as Record<string, unknown>;

    if (method === 'POST' && path === '') {
      const requestId = headers['paypal-request-id'];
      const replay = requestId ? this.byRequestId.get(`${supplierCode}:${requestId}`) : undefined;
      if (replay && this.carts.has(replay)) return { status: 201, json: { ...(this.carts.get(replay) as StoredCart).cart } };
      const items = parseItems(input.items);
      if (!items) return { status: 400, json: { name: 'INVALID_REQUEST', message: 'items must be a list of {variant_id, quantity}.' } };
      if (items.every((i) => !catalog.items.some((c) => c.variantId === i.variant_id))) {
        return { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', message: 'None of the items are sold by this merchant; no cart was created.' } };
      }
      this.sweep();
      const id = `CART-${randomUUID()}`;
      const now = new Date(this.now()).toISOString();
      const cart = this.build(id, catalog, items, now);
      this.carts.set(id, { supplierCode, cart, expiresAt: this.now() + CART_TTL_MS });
      if (requestId) this.byRequestId.set(`${supplierCode}:${requestId}`, id);
      return { status: 201, json: { ...cart } };
    }

    const m = /^\/([A-Za-z0-9-]{1,80})(\/checkout)?$/.exec(path);
    const stored = m ? this.carts.get(m[1] ?? '') : undefined;
    if (!m || !stored || stored.supplierCode !== supplierCode) return { status: 404, json: { name: 'RESOURCE_NOT_FOUND', message: 'No such cart.' } };

    if (method === 'GET' && !m[2]) return { status: 200, json: { ...stored.cart } };

    if (method === 'PUT' && !m[2]) {
      if (stored.cart.status === 'COMPLETED') return { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', message: 'A completed cart cannot be changed.' } };
      const items = parseItems(input.items);
      if (!items) return { status: 400, json: { name: 'INVALID_REQUEST', message: 'items must be a list of {variant_id, quantity}.' } };
      stored.cart = this.build(stored.cart.id, catalog, items, stored.cart.create_time);
      return { status: 200, json: { ...stored.cart } };
    }

    if (method === 'POST' && m[2]) {
      const pm = input.payment_method as PaymentMethod | undefined;
      if (!pm || pm.type !== 'paypal' || typeof pm.token !== 'string' || !/^[A-Za-z0-9-]{6,40}$/.test(pm.token)) {
        return { status: 400, json: { name: 'INVALID_REQUEST', message: 'payment_method {type: "paypal", token} is required.' } };
      }
      if (stored.cart.status === 'COMPLETED') {
        // Checking out again returns the same confirmation; a different payment is refused.
        return stored.cart.payment_method?.token === pm.token
          ? { status: 200, json: { ...stored.cart } }
          : { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', message: 'This cart was already paid with another payment.' } };
      }
      const fresh = this.build(stored.cart.id, catalog, stored.cart.items, stored.cart.create_time);
      if (fresh.status !== 'READY') {
        stored.cart = fresh;
        return { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', message: 'The cart has unresolved issues.', validation_issues: fresh.validation_issues } };
      }
      for (const item of fresh.items) {
        const entry = catalog.items.find((c) => c.variantId === item.variant_id);
        if (entry && entry.stock !== null) entry.stock -= item.quantity;
      }
      this.orderNumber += 1;
      const number = `${catalog.orderPrefix}-${this.orderNumber}`;
      stored.cart = {
        ...fresh, status: 'COMPLETED', payment_method: { type: 'paypal', token: pm.token },
        payment_confirmation: { merchant_order_number: number, order_review_page: `https://${catalog.supplierCode.toLowerCase()}.supplier.example/orders/${number}` }
      };
      return { status: 200, json: { ...stored.cart } };
    }
    return { status: 405, json: { name: 'METHOD_NOT_SUPPORTED', message: 'Not supported.' } };
  }
}

/**
 * The demo suppliers' simulated agents, priced from the seed's current unit
 * costs. Valley Farm Eggs is out of 30-count cases and offers two 15-count
 * packs for each, at the same total price.
 */
export function demoCatalogs(
  suppliers: readonly { readonly code: string; readonly name: string }[],
  products: readonly (readonly [string, string, string, number, number, number, number, string, boolean])[]
): SupplierCatalog[] {
  const overrides: Record<string, Partial<CatalogItem>> = {
    'EGGS-30': { stock: 0, alternatives: [{ variantId: 'EGGS-15', perUnit: 2 }] },
    'EGGS-15': { priceMinor: 710 }
  };
  return suppliers.map((s) => ({
    supplierCode: s.code,
    name: s.name,
    currency: 'USD',
    orderPrefix: s.code.replace(/^SUP-/, '').slice(0, 4),
    items: products.filter((p) => p[7] === s.code).map((p) => ({ variantId: p[0], name: p[1], priceMinor: p[4], stock: null, ...overrides[p[0]] }))
  }));
}
