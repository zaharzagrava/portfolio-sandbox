/** Who gets the second chance (S21 FR-030, AS-38). Pure. */

export type RunnerUpCandidate = {
  bidderId: string;
  /** The bidder's highest maximum. */
  maxAmountMinor: number;
  /** Sequence of the earliest bid at that maximum (ties go to the earlier bid). */
  sequence: number;
};

/** Candidates other than the winner whose maximum covers the reserve, best first. */
export function rankRunnersUp(
  candidates: readonly RunnerUpCandidate[],
  rules: { winnerId: string | null; reservePriceMinor: number | null },
): RunnerUpCandidate[] {
  return candidates
    .filter(
      (c) =>
        c.bidderId !== rules.winnerId &&
        (rules.reservePriceMinor === null ||
          c.maxAmountMinor >= rules.reservePriceMinor),
    )
    .sort(
      (a, b) => b.maxAmountMinor - a.maxAmountMinor || a.sequence - b.sequence,
    );
}

/** The best ranked candidate who is not a member of the selling shop. */
export function selectRunnerUp(
  ranked: readonly RunnerUpCandidate[],
  memberIds: ReadonlySet<string>,
): RunnerUpCandidate | null {
  return ranked.find((c) => !memberIds.has(c.bidderId)) ?? null;
}
