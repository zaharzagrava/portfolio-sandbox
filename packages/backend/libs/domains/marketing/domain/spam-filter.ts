export interface SpamThresholds {
  /** More clicks than this in one UTC minute from one address (any campaign) are `ip_burst`. */
  ipPerMinute: number;
  /** More clicks than this in one UTC hour on one campaign from one address or one viewer are `repeat_clicker`. */
  repeatPerHour: number;
}

/** The counts include the click being judged (the counters are incremented first, atomically). */
export interface SpamCounts {
  addressMinute: number;
  /** The larger of the address-per-campaign and viewer-per-campaign hourly counts. */
  repeatHour: number;
}

export type SpamVerdict =
  { valid: true } | { valid: false; reason: 'ip_burst' | 'repeat_clicker' };

const positiveInteger = (n: number): boolean => Number.isInteger(n) && n >= 1;

/**
 * FR-027, AS-41: pure and monotone (more clicks never turn an invalid verdict valid). `ip_burst` has precedence when both
 * rules trip, so a click carries one reason. A threshold below 1 or not an integer is a defect, not a verdict.
 */
export function decideSpam(
  counts: SpamCounts,
  thresholds: SpamThresholds,
): SpamVerdict {
  if (
    !positiveInteger(thresholds.ipPerMinute) ||
    !positiveInteger(thresholds.repeatPerHour)
  )
    throw new RangeError('spam thresholds must be positive integers');
  if (counts.addressMinute > thresholds.ipPerMinute)
    return { valid: false, reason: 'ip_burst' };
  if (counts.repeatHour > thresholds.repeatPerHour)
    return { valid: false, reason: 'repeat_clicker' };
  return { valid: true };
}
