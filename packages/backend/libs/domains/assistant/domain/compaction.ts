/** Replay size above which the whole transcript is summarised into one message (S46 AS-59, FR-014). */
export const COMPACTION_THRESHOLD_TOKENS = 60_000;
/** From this share of the threshold the provider's exact token count is asked for; below it the estimate decides. */
export const COMPACTION_COUNT_RATIO = 0.8;

/** Local estimate: `ceil(chars / 4)`. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export interface CompactionDecision {
  compact: boolean;
  /** True when the number decided on came from the provider's count rather than the estimate. */
  usedCount: boolean;
  tokens: number;
}

/**
 * Decides whether a turn starts with compaction. Estimate below 80% of the threshold: no provider call. Otherwise the
 * precise count decides; when the count call fails the estimate decides.
 */
export async function decideCompaction(
  estimatedTokens: number,
  countTokens: () => Promise<number>,
): Promise<CompactionDecision> {
  if (estimatedTokens < COMPACTION_THRESHOLD_TOKENS * COMPACTION_COUNT_RATIO)
    return { compact: false, usedCount: false, tokens: estimatedTokens };
  try {
    const counted = await countTokens();
    return {
      compact: counted > COMPACTION_THRESHOLD_TOKENS,
      usedCount: true,
      tokens: counted,
    };
  } catch {
    return {
      compact: estimatedTokens > COMPACTION_THRESHOLD_TOKENS,
      usedCount: false,
      tokens: estimatedTokens,
    };
  }
}
