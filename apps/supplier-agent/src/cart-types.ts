// The merchant side of PayPal's Cart API v1 (developer.paypal.com/api/agentic-commerce/v1),
// the subset ShopVoice's simulated supplier agents implement. Field names follow the spec.

export interface CartMoney {
  readonly currency_code: string;
  /** Decimal string, e.g. "7.10". */
  readonly value: string;
}

export interface CartItem {
  readonly variant_id: string;
  readonly quantity: number;
  readonly name?: string;
  readonly price?: CartMoney;
}

export type CartStatus = 'CREATED' | 'INCOMPLETE' | 'READY' | 'COMPLETED';
export type ValidationStatus = 'VALID' | 'INVALID' | 'REQUIRES_ADDITIONAL_INFORMATION';

export interface SuggestedAlternative {
  readonly variant_id: string;
  readonly name: string;
  readonly price: CartMoney;
  /** How many of the alternative replace the requested quantity. */
  readonly quantity: number;
}

export interface ValidationIssue {
  readonly code: 'INVENTORY_ISSUE' | 'PRICING_ERROR' | 'DATA_ERROR';
  readonly type: 'MISSING_FIELD' | 'INVALID_DATA' | 'BUSINESS_RULE';
  readonly message: string;
  readonly user_message?: string;
  readonly variant_id?: string;
  readonly context?: {
    readonly specific_issue: 'ITEM_OUT_OF_STOCK' | 'ITEM_NOT_AVAILABLE' | 'PRICE_MISMATCH';
    readonly available_quantity?: number;
    readonly expected_price?: CartMoney;
    readonly current_price?: CartMoney;
    readonly suggested_alternatives?: readonly SuggestedAlternative[];
  };
  readonly resolution_options?: readonly { readonly action: 'SUGGEST_ALTERNATIVE' | 'ACCEPT_NEW_PRICE' | 'REMOVE_ITEM'; readonly label: string }[];
}

export interface PaymentMethod {
  readonly type: 'paypal';
  /** The PayPal order id that pays for this cart. */
  readonly token: string;
  readonly payer_id?: string;
}

export interface Cart {
  readonly id: string;
  readonly status: CartStatus;
  readonly validation_status: ValidationStatus;
  readonly validation_issues: readonly ValidationIssue[];
  readonly items: readonly (CartItem & { readonly name: string; readonly price: CartMoney })[];
  readonly totals: { readonly subtotal: CartMoney; readonly total: CartMoney };
  readonly payment_method?: PaymentMethod;
  readonly payment_confirmation?: { readonly merchant_order_number: string; readonly order_review_page: string };
  readonly create_time: string;
  readonly update_time: string;
}

export function toMoney(minor: number, currency: string): CartMoney {
  return { currency_code: currency, value: (minor / 100).toFixed(2) };
}

/** "7.10" -> 710; anything that is not a plain non-negative decimal is null. */
export function fromMoney(money: CartMoney | undefined): number | null {
  if (!money || typeof money.value !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(money.value)) return null;
  return Math.round(Number(money.value) * 100);
}
