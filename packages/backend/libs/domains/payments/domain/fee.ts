import { JournalInvalid } from './ledger-errors';

export interface CaptureSplit {
  /** Debit of `PROVIDER_CLEARING`. */
  providerMinor: number;
  /** Credit of `MARKETPLACE_CLEARING`: what settlement later splits over the shops. */
  clearingMinor: number;
  /** Credit of `PLATFORM_FEES`. */
  feeMinor: number;
}

/**
 * The one fee rule (FR-011): a flat fee per captured payment. The amount must be above the fee, so the clearing
 * credit is always positive; a negative or fractional amount is a malformed line.
 */
export function splitCapture(
  amountMinor: number,
  feeMinor: number,
): CaptureSplit {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
    throw new JournalInvalid('line_amount_invalid');
  if (amountMinor <= feeMinor) throw new JournalInvalid('amount_not_above_fee');
  return {
    providerMinor: -amountMinor,
    clearingMinor: amountMinor - feeMinor,
    feeMinor,
  };
}
