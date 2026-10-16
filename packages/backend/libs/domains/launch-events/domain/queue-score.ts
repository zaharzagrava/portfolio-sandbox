/** Width of the random window that opens the sale: pre-sale joiners are shuffled inside it (S22 AS-03). */
export const PRESALE_WINDOW_MS = 1_000;

/**
 * Waiting-room order (S22 FR-003). Pure: the caller injects the instant and the random source (no `Date.now`,
 * no `Math.random`).
 *  - before `salesOpenAt`: uniform in `[open, open + 1 s)` whatever the join instant, so refreshing early gives no edge;
 *  - at or after it: `max(now, open + 1 s)`, so every pre-sale joiner is ahead, and later joiners follow join order.
 */
export const joinScore = (input: {
  nowMs: number;
  salesOpenAtMs: number;
  random: () => number;
}): number => {
  const { nowMs, salesOpenAtMs, random } = input;
  if (nowMs < salesOpenAtMs)
    return salesOpenAtMs + random() * PRESALE_WINDOW_MS;
  return Math.max(nowMs, salesOpenAtMs + PRESALE_WINDOW_MS);
};
