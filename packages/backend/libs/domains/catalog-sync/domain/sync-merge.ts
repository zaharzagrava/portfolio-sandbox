import type { SyncField, SyncOp } from '@marketplace-sandbox/contracts';
import { compareHlc, decodeHlc } from './hlc';

/**
 * Merge rules (pure, FR-040; devices can apply the same rules locally):
 *  - stock operations are deltas that commute (`stock.count` becomes `counted - base`);
 *  - a product field is decided by last writer per field, by hybrid logical clock; the node id breaks ties and an exactly
 *    equal clock loses.
 */
export function stockDeltaOf(
  op: Extract<SyncOp, { type: 'stock.adjust' | 'stock.count' }>,
): number {
  return op.type === 'stock.adjust' ? op.delta : op.counted - op.base;
}

/** Whether `candidate` is strictly after `stored` (equal loses; an unreadable stored clock never blocks). */
export function isNewer(
  candidate: string,
  stored: string | undefined,
): boolean {
  if (stored === undefined) return true;
  const a = decodeHlc(candidate);
  const b = decodeHlc(stored);
  if (!a) return false;
  if (!b) return true;
  return compareHlc(a, b) > 0;
}

/** Fields of the edit that are newer than what the server holds. */
export function decideFields<F extends string>(
  fields: readonly F[],
  opHlc: string,
  stored: Partial<Record<string, string>>,
): { win: F[]; lose: F[] } {
  const win: F[] = [];
  const lose: F[] = [];
  for (const field of fields)
    (isNewer(opHlc, stored[field]) ? win : lose).push(field);
  return { win, lose };
}

/** The model of a product that the convergence property folds operations into. */
export interface ModelState {
  quantity: number;
  fields: Partial<Record<SyncField, { value: string | number; hlc: string }>>;
}

export const emptyModel = (quantity: number): ModelState => ({
  quantity,
  fields: {},
});

/** Applies operations in the given order; a repeated operation id counts once (the claim). */
export function foldOps(
  initial: ModelState,
  ops: readonly SyncOp[],
): ModelState {
  const seen = new Set<string>();
  const state: ModelState = {
    quantity: initial.quantity,
    fields: { ...initial.fields },
  };
  for (const op of ops) {
    if (seen.has(op.opId)) continue;
    seen.add(op.opId);
    if (op.type === 'product.update') {
      const names = Object.keys(op.fields) as SyncField[];
      const stored = Object.fromEntries(
        names.map((n) => [n, state.fields[n]?.hlc]),
      );
      const { win } = decideFields(names, op.hlc, stored);
      for (const name of win)
        state.fields[name] = { value: op.fields[name]!, hlc: op.hlc };
    } else state.quantity += stockDeltaOf(op);
  }
  return state;
}
