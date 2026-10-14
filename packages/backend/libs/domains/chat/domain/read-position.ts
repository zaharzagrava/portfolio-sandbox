/**
 * Read position arithmetic (S24 FR-030, FR-032). Mirrors the SQL `LEAST(GREATEST(lastReadSeq, :seq), lastSeq)` of the
 * conditional update so the rule is testable without a database. A position that is already beyond `lastSeq` (never
 * produced by the system) is left alone: it never moves back.
 */
export function advanceReadPosition(
  current: number,
  requested: number,
  lastSeq: number,
): number {
  return Math.max(current, Math.min(Math.max(current, requested), lastSeq));
}

export function unreadCount(lastSeq: number, lastReadSeq: number): number {
  return Math.max(0, lastSeq - lastReadSeq);
}
