/** Default account age (hours) below which a vote does not move rankings (S25 FR-025). */
export const DEFAULT_MIN_ACCOUNT_AGE_HOURS = 24;

export interface VoteWeightInput {
  /** The voter's account creation time, or `null` when the directory could not resolve it. */
  createdAt: Date | null;
  shadowBanned: boolean;
  now: Date;
  minAgeHours?: number;
}

/**
 * Ranking weight of a vote, fixed when it is cast: 0 for an unresolved account, a shadow-banned voter or an account
 * younger than the threshold, else 1. Displayed counts always use the raw vote.
 */
export function voteWeight(input: VoteWeightInput): 0 | 1 {
  if (input.shadowBanned || input.createdAt === null) return 0;
  const minMs =
    (input.minAgeHours ?? DEFAULT_MIN_ACCOUNT_AGE_HOURS) * 3_600_000;
  return input.now.getTime() - input.createdAt.getTime() >= minMs ? 1 : 0;
}
