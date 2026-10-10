/**
 * Chart of accounts (minor units; positive = credit/money in, negative = debit).
 *  CLEARING        - customer money received by the marketplace, not yet owed to anyone specific
 *  PLATFORM_FEES   - marketplace revenue
 *  SHOP_<id>       - owed to a shop (its available balance)
 *  PAYOUT_CLEARING - in flight to a shop's bank (between "payout created" and "provider confirmed")
 */
export const LEDGER_ACCOUNTS = {
  CLEARING: 'MARKETPLACE_CLEARING',
  PLATFORM_FEES: 'PLATFORM_FEES',
  PAYOUT_CLEARING: 'PAYOUT_CLEARING',
  /** Money held for us by the payment provider: debited when a payment is captured, credited on a refund (S13). */
  PROVIDER_FUNDS: 'PROVIDER_FUNDS',
} as const;

export const shopAccount = (shopId: string) => `SHOP_${shopId}`;

/** Flat platform fee per sale (minor units) - same constant the payment processor books. */
export const PLATFORM_FEE_MINOR = 50;
