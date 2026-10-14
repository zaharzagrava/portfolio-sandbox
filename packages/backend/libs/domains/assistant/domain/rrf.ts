/**
 * Reciprocal rank fusion (Cormack et al. 2009): score(d) = Σ 1 / (k + rank_i(d)), ranks starting at 1.
 * Merges rankings whose SCORES aren't comparable (cosine distance vs ts_rank_cd) using ranks only; k = 60 damps the
 * head so one list's #1 doesn't dominate. An id repeated inside one list counts once, at its best rank. Ties keep
 * first-seen order (stable, deterministic); the result is ordered by descending score.
 */
export function reciprocalRankFusion(
  lists: string[][],
  k = 60,
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
