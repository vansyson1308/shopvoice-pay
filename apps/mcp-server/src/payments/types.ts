// PayPal REST resource shapes, limited to the fields ShopVoice Pay reads.
// Field names mirror PayPal's JSON exactly (snake_case) so they can be
// compared against the API reference and the sandbox responses in SPIKE.md.

export interface PayPalAmount {
  readonly currency_code: string;
  readonly value: string;
}

export interface PayPalLink {
  readonly href: string;
  readonly rel: string;
  readonly method?: string;
}

export type OrderStatus = 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
export type AuthorizationStatus = 'CREATED' | 'CAPTURED' | 'DENIED' | 'PARTIALLY_CAPTURED' | 'VOIDED' | 'PENDING' | 'EXPIRED';
export type CaptureStatus = 'COMPLETED' | 'DECLINED' | 'PARTIALLY_REFUNDED' | 'PENDING' | 'REFUNDED' | 'FAILED';
export type RefundStatus = 'CANCELLED' | 'FAILED' | 'PENDING' | 'COMPLETED';

export interface PayPalAuthorization {
  readonly id: string;
  readonly status: AuthorizationStatus;
  readonly amount: PayPalAmount;
  readonly invoice_id?: string;
  readonly custom_id?: string;
  readonly expiration_time?: string;
  readonly create_time?: string;
  readonly update_time?: string;
  readonly links?: readonly PayPalLink[];
}

export interface PayPalCapture {
  readonly id: string;
  readonly status: CaptureStatus;
  readonly amount: PayPalAmount;
  readonly final_capture?: boolean;
  readonly invoice_id?: string;
  readonly create_time?: string;
  readonly links?: readonly PayPalLink[];
}

export interface PayPalRefund {
  readonly id: string;
  readonly status: RefundStatus;
  readonly amount: PayPalAmount;
  readonly invoice_id?: string;
  readonly create_time?: string;
  readonly links?: readonly PayPalLink[];
}

export interface PayPalPayee {
  readonly email_address?: string;
  readonly merchant_id?: string;
}

export interface PayPalPurchaseUnit {
  readonly reference_id?: string;
  readonly description?: string;
  readonly invoice_id?: string;
  readonly custom_id?: string;
  readonly amount: PayPalAmount;
  readonly payee?: PayPalPayee;
  readonly payments?: {
    readonly authorizations?: readonly PayPalAuthorization[];
    readonly captures?: readonly PayPalCapture[];
    readonly refunds?: readonly PayPalRefund[];
  };
}

export interface PayPalOrder {
  readonly id: string;
  readonly status: OrderStatus;
  readonly intent?: 'CAPTURE' | 'AUTHORIZE';
  readonly purchase_units?: readonly PayPalPurchaseUnit[];
  readonly payment_source?: {
    readonly paypal?: {
      readonly email_address?: string;
      readonly account_id?: string;
      readonly attributes?: { readonly vault?: { readonly id?: string; readonly status?: string; readonly customer?: { readonly id?: string } } };
    };
  };
  readonly links?: readonly PayPalLink[];
}

export interface PayPalSetupToken {
  readonly id: string;
  readonly status: 'CREATED' | 'PAYER_ACTION_REQUIRED' | 'APPROVED' | 'VAULTED' | 'TOKENIZED';
  readonly customer?: { readonly id?: string };
  readonly links?: readonly PayPalLink[];
}

export interface PayPalPaymentToken {
  readonly id: string;
  readonly customer?: { readonly id?: string };
  readonly payment_source?: {
    readonly paypal?: { readonly email_address?: string; readonly payer_id?: string; readonly name?: { readonly given_name?: string; readonly surname?: string } };
  };
  readonly links?: readonly PayPalLink[];
}

export interface PayPalPayoutBatch {
  readonly batch_header: {
    readonly payout_batch_id: string;
    readonly batch_status: 'DENIED' | 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'CANCELED';
    readonly sender_batch_header?: { readonly sender_batch_id?: string };
  };
  readonly items?: readonly {
    readonly payout_item_id: string;
    readonly transaction_status?: string;
    readonly payout_item?: { readonly receiver?: string; readonly amount?: PayPalAmount; readonly sender_item_id?: string };
  }[];
  readonly links?: readonly PayPalLink[];
}

export function findLink(links: readonly PayPalLink[] | undefined, ...rels: string[]): string | null {
  for (const rel of rels) {
    const link = links?.find((l) => l.rel === rel);
    if (link) return link.href;
  }
  return null;
}
