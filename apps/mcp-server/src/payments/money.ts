// Money is integer minor units plus an ISO 4217 currency code. Never floats.
// PayPal takes amounts as decimal strings ("84.00"); these helpers convert at
// the API boundary only.

/** Currencies PayPal supports with zero decimal places. Everything else we accept uses two. */
const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD']);
/** ShopVoice Pay demo funds are USD; the list keeps display code honest if that changes. */
const SUPPORTED = new Set(['USD', 'CAD', 'EUR', 'GBP', 'AUD', ...ZERO_DECIMAL]);

export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export class MoneyError extends Error {}

export function assertCurrency(currency: string): string {
  const code = currency.toUpperCase();
  if (!SUPPORTED.has(code)) throw new MoneyError(`unsupported_currency:${currency}`);
  return code;
}

export function minorExponent(currency: string): 0 | 2 {
  return ZERO_DECIMAL.has(assertCurrency(currency)) ? 0 : 2;
}

export function assertMinor(amountMinor: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new MoneyError(`invalid_amount_minor:${amountMinor}`);
  }
  return amountMinor;
}

/** 8400 USD -> "84.00"; 500 JPY -> "500". */
export function toPayPalValue(amountMinor: number, currency: string): string {
  assertMinor(amountMinor);
  const exp = minorExponent(currency);
  if (exp === 0) return String(amountMinor);
  const whole = Math.floor(amountMinor / 100);
  const cents = amountMinor % 100;
  return `${whole}.${String(cents).padStart(2, '0')}`;
}

/** "84.00" USD -> 8400. Rejects anything that is not a plain non-negative decimal with the right scale. */
export function fromPayPalValue(value: string, currency: string): number {
  const exp = minorExponent(currency);
  const pattern = exp === 0 ? /^(\d+)$/ : /^(\d+)(?:\.(\d{1,2}))?$/;
  const match = pattern.exec(value.trim());
  if (!match) throw new MoneyError(`invalid_paypal_value:${value}`);
  const whole = Number(match[1]);
  const frac = exp === 0 ? 0 : Number((match[2] ?? '').padEnd(2, '0'));
  return assertMinor(whole * 10 ** exp + frac);
}

export function toPayPalAmount(money: Money): { currency_code: string; value: string } {
  return { currency_code: assertCurrency(money.currency), value: toPayPalValue(money.amountMinor, money.currency) };
}

/** "$84.00" style string for UI and speech. */
export function formatMoney(money: Money): string {
  const code = assertCurrency(money.currency);
  const value = toPayPalValue(money.amountMinor, code);
  return code === 'USD' ? `$${value}` : `${value} ${code}`;
}

/** Spoken form: "$84" for whole dollars, "$84.50" otherwise. */
export function speakMoney(money: Money): string {
  const formatted = formatMoney(money);
  return formatted.endsWith('.00') ? formatted.slice(0, -3) : formatted;
}

export function sumMinor(values: readonly number[]): number {
  return values.reduce((acc, v) => assertMinor(acc + assertMinor(v)), 0);
}
