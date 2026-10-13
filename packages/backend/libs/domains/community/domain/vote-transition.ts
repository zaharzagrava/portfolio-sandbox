/**
 * Vote transitions (S25 C5, FR-020, FR-025). The vote store holds one record per (user, target); the displayed counts
 * (`ups`, `downs`) and the ranking counts (`wups`, `wdowns`, weighted) follow the committed `(previous, next)` pair, so
 * they always equal a recount of the records.
 */
export interface VoteRecord {
  value: 1 | -1;
  /** Ranking weight fixed at cast time (FR-025). */
  weight: 0 | 1;
}

export interface VoteDelta {
  dUps: number;
  dDowns: number;
  dWups: number;
  dWdowns: number;
}

export interface VoteCounts {
  ups: number;
  downs: number;
  wups: number;
  wdowns: number;
}

export const EMPTY_COUNTS: VoteCounts = {
  ups: 0,
  downs: 0,
  wups: 0,
  wdowns: 0,
};

const contribution = (record: VoteRecord | null): VoteDelta => ({
  dUps: record?.value === 1 ? 1 : 0,
  dDowns: record?.value === -1 ? 1 : 0,
  dWups: record?.value === 1 ? record.weight : 0,
  dWdowns: record?.value === -1 ? record.weight : 0,
});

/** What moves when a user's record goes from `previous` to `next` (`null` = no record). */
export function voteDelta(
  previous: VoteRecord | null,
  next: VoteRecord | null,
): VoteDelta {
  const before = contribution(previous);
  const after = contribution(next);
  return {
    dUps: after.dUps - before.dUps,
    dDowns: after.dDowns - before.dDowns,
    dWups: after.dWups - before.dWups,
    dWdowns: after.dWdowns - before.dWdowns,
  };
}

export const applyDelta = (
  counts: VoteCounts,
  delta: VoteDelta,
): VoteCounts => ({
  ups: counts.ups + delta.dUps,
  downs: counts.downs + delta.dDowns,
  wups: counts.wups + delta.dWups,
  wdowns: counts.wdowns + delta.dWdowns,
});

export const isNoop = (d: VoteDelta): boolean =>
  d.dUps === 0 && d.dDowns === 0 && d.dWups === 0 && d.dWdowns === 0;
