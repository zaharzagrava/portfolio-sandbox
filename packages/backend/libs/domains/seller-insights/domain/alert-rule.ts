import { createHash } from 'node:crypto';

export type AlertOutcome =
  | 'alert'
  | 'not_undercut'
  | 'currency_mismatch'
  | 'product_unavailable'
  | 'shop_inactive'
  | 'not_lower_than_previous';

export interface AlertInput {
  competitorPriceMinor: number;
  competitorCurrency: string;
  yourPriceMinor: number;
  yourCurrency: string;
  productActive: boolean;
  shopActive: boolean;
  lastEvaluatedPriceMinor: number | null;
}

/**
 * FR-025: alert when the competitor is cheaper than you in the same currency,
 * the product and shop are active, and the watch has no previous evaluation or
 * the competitor went lower than at that evaluation. Checks run in the order
 * of the outcomes below, the first failing one is reported.
 */
export function shouldAlert(input: AlertInput): {
  alert: boolean;
  outcome: AlertOutcome;
} {
  const outcome = ((): AlertOutcome => {
    if (!input.productActive) return 'product_unavailable';
    if (!input.shopActive) return 'shop_inactive';
    if (input.competitorCurrency !== input.yourCurrency)
      return 'currency_mismatch';
    if (input.competitorPriceMinor >= input.yourPriceMinor)
      return 'not_undercut';
    if (
      input.lastEvaluatedPriceMinor !== null &&
      input.competitorPriceMinor >= input.lastEvaluatedPriceMinor
    )
      return 'not_lower_than_previous';
    return 'alert';
  })();
  return { alert: outcome === 'alert', outcome };
}

/** Deterministic UUIDv7-shaped id (version nibble 7, variant 10) for one alert. */
export function eventIdFor(
  watchId: string,
  priceVersion: number | string,
  ownerId: string,
): string {
  const bytes = createHash('sha256')
    .update(`${watchId}|${priceVersion}|${ownerId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
