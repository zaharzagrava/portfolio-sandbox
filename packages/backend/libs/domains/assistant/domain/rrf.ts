/**
 * Reciprocal rank fusion (Cormack et al. 2009): score(d) = Σ 1 / (k + rank_i(d)).
 * Merges rankings whose SCORES aren't comparable (cosine distance vs
 * ts_rank_cd) using ranks only; k = 60 damps the head so one list's #1
 * doesn't dominate. Ties keep first-seen order (stable).
 */
export function reciprocalRankFusion(
  lists: string[][],
  k = 60,
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) =>
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)),
    );
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
