/**
 * Merge rules (pure; the service applies them inside one transaction per op):
 *  - stock: operations are DELTAS (PN-counter style) - "+5 received", "−1 sold",
 *    and a physical count becomes `counted − deviceBase` (what this device saw
 *    change). Deltas commute: devices syncing in any order converge.
 *  - product fields: last-writer-wins PER FIELD by HLC - two devices editing
 *    title and price concurrently both win their own field.
 */
export type SyncOp =
  | {
      type: 'stock.adjust';
      opId: string;
      hlc: string;
      productId: string;
      delta: number;
      reason: 'received' | 'sold' | 'damaged' | 'returned' | 'other';
    }
  | {
      type: 'stock.count';
      opId: string;
      hlc: string;
      productId: string;
      counted: number;
      base: number;
    }
  | {
      type: 'product.update';
      opId: string;
      hlc: string;
      productId: string;
      fields: Partial<
        Record<'title' | 'price' | 'description', string | number>
      >;
    };

export function stockDelta(
  op: Extract<SyncOp, { type: 'stock.adjust' | 'stock.count' }>,
): number {
  return op.type === 'stock.adjust' ? op.delta : op.counted - op.base;
}

/** Fields of the update that are newer than what the server holds (LWW per field). */
export function winningFields(
  fields: Record<string, unknown>,
  opHlc: string,
  current: Record<string, string | undefined>,
): { win: string[]; lose: string[] } {
  const win: string[] = [];
  const lose: string[] = [];
  for (const field of Object.keys(fields))
    (current[field] === undefined || opHlc > current[field] ? win : lose).push(
      field,
    );
  return { win, lose };
}
