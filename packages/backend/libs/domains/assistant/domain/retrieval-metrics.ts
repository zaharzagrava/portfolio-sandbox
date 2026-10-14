/**
 * The maths of the retrieval evaluation harness (S47 FR-027, AS-49), pure so it is table-tested.
 * A case is `{retrieved, expected}`: the identifiers of the documents the search returned, best first, and the
 * identifiers at least one of which a good search finds. Only the top `k` count.
 */
export interface EvalCase {
  retrieved: string[];
  expected: string[];
}

/** 1-based rank of the first retrieved document that is expected, within the top `k`; `null` when none is. */
export function firstRelevantRank(
  retrieved: string[],
  expected: string[],
  k: number,
): number | null {
  if (!expected.length) return null;
  const wanted = new Set(expected);
  const index = retrieved.slice(0, k).findIndex((id) => wanted.has(id));
  return index < 0 ? null : index + 1;
}

export function reciprocalRank(
  retrieved: string[],
  expected: string[],
  k: number,
): number {
  const rank = firstRelevantRank(retrieved, expected, k);
  return rank === null ? 0 : 1 / rank;
}

export interface EvalReport {
  cases: number;
  hits: number;
  /** Share of cases with at least one expected document in the top k. */
  recallAtK: number;
  /** Mean over cases of 1 / rank of the first expected document (0 when it is outside the top k). */
  mrr: number;
}

export function evaluateRetrieval(cases: EvalCase[], k: number): EvalReport {
  if (!cases.length) return { cases: 0, hits: 0, recallAtK: 0, mrr: 0 };
  const hits = cases.filter(
    (c) => firstRelevantRank(c.retrieved, c.expected, k) !== null,
  ).length;
  const mrr =
    cases.reduce(
      (sum, c) => sum + reciprocalRank(c.retrieved, c.expected, k),
      0,
    ) / cases.length;
  return { cases: cases.length, hits, recallAtK: hits / cases.length, mrr };
}
