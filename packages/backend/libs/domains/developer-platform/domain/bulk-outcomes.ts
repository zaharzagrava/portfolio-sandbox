export type BulkOutcome =
  | 'applied'
  | 'replayed'
  | 'not_found'
  | 'insufficient_stock'
  | 'not_applied'
  | 'conflict';

export interface BulkItem {
  operationId: string;
  productId: string;
  delta: number;
}

export interface ItemOutcome {
  operation_id: string;
  product_id: string;
  outcome: BulkOutcome;
  stock_after?: number;
}

/** The shape of the catalog's stock answer this module reads (the catalog's own types are not imported into the domain layer). */
export type StockAnswer =
  | {
      outcome: 'applied';
      results: {
        operationId: string;
        productId: string;
        quantityAfter: number;
        replayed: boolean;
      }[];
    }
  | {
      outcome: 'rejected';
      failures: { operationId: string; productId: string; code: string }[];
    };

const FAILURE: Record<string, BulkOutcome> = {
  insufficient_stock: 'insufficient_stock',
  not_found: 'not_found',
};

/**
 * One outcome per item, in the request's order (FR-046, FR-048). Items whose product is not the shop's are `not_found`
 * and were never sent to the stock service; the others are `applied`/`replayed` with the stock after, or — when the
 * all-or-nothing call was refused — the refused item says why and every other one is `not_applied`.
 */
export function toOutcomes(
  items: readonly BulkItem[],
  missing: ReadonlySet<string>,
  answer: StockAnswer | undefined,
): ItemOutcome[] {
  const applied = new Map(
    answer?.outcome === 'applied'
      ? answer.results.map((r) => [r.operationId, r])
      : [],
  );
  const refused = new Map(
    answer?.outcome === 'rejected'
      ? answer.failures.map((f) => [f.operationId, f.code])
      : [],
  );
  return items.map((item): ItemOutcome => {
    const base = { operation_id: item.operationId, product_id: item.productId };
    if (missing.has(item.productId)) return { ...base, outcome: 'not_found' };
    const done = applied.get(item.operationId);
    if (done)
      return {
        ...base,
        outcome: done.replayed ? 'replayed' : 'applied',
        stock_after: done.quantityAfter,
      };
    const code = refused.get(item.operationId);
    if (code) return { ...base, outcome: FAILURE[code] ?? 'conflict' };
    return { ...base, outcome: 'not_applied' };
  });
}

const OK: ReadonlySet<BulkOutcome> = new Set(['applied', 'replayed']);

/** Synchronous call: `failed` when the all-or-nothing call was refused or nothing was applied, else `succeeded` (AS-50). */
export function syncStatus(
  results: readonly Pick<ItemOutcome, 'outcome'>[],
  rejected: boolean,
): 'succeeded' | 'failed' {
  if (rejected) return 'failed';
  return results.some((r) => OK.has(r.outcome)) || results.length === 0
    ? 'succeeded'
    : 'failed';
}

export const FAILURES_KEPT = 1_000;

/** What one chunk adds to its job: applied, replayed, every other outcome as failed (with the first failures listed). */
export function chunkTotals(outcomes: readonly ItemOutcome[]): {
  applied: number;
  replayed: number;
  failed: number;
  failures: {
    operation_id: string;
    product_id: string;
    outcome: BulkOutcome;
  }[];
} {
  const failures = outcomes
    .filter((o) => !OK.has(o.outcome))
    .map(({ operation_id, product_id, outcome }) => ({
      operation_id,
      product_id,
      outcome,
    }));
  return {
    applied: outcomes.filter((o) => o.outcome === 'applied').length,
    replayed: outcomes.filter((o) => o.outcome === 'replayed').length,
    failed: failures.length,
    failures,
  };
}
