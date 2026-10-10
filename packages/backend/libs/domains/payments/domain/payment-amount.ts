import {
  MAX_PAYMENT_AMOUNT_MINOR,
  PAYMENT_CURRENCIES,
  type PaymentCurrency,
} from '@marketplace-sandbox/contracts';

export type MoneyCheck =
  | { kind: 'ok'; amountMinor: number; currency: PaymentCurrency }
  | { kind: 'amount_out_of_range' }
  | { kind: 'currency_unsupported' };

/** Integer minor units from 1 to 99,999,999 in EUR, USD or GBP (S13 FR-007); currency codes are upper case. */
export function checkPaymentMoney(
  amountMinor: number,
  currency: string,
): MoneyCheck {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 1 ||
    amountMinor > MAX_PAYMENT_AMOUNT_MINOR
  )
    return { kind: 'amount_out_of_range' };
  if (!(PAYMENT_CURRENCIES as readonly string[]).includes(currency))
    return { kind: 'currency_unsupported' };
  return { kind: 'ok', amountMinor, currency: currency as PaymentCurrency };
}
