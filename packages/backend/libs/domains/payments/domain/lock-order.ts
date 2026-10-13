import { JournalInvalid } from './ledger-errors';

export interface RowKey {
  accountId: string;
  shard: number;
}

export interface RowDelta extends RowKey {
  amountMinor: number;
}

/** Ascending (account, shard): the one global order in which a posting touches balance rows (FR-020). */
export function compareRows(a: RowKey, b: RowKey): number {
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1;
  return a.shard - b.shard;
}

/**
 * One entry per (account, shard) with the lines added together, in lock order. A row total outside the safe-integer
 * range is `balance_overflow` (summed exactly, so the intermediate sums cannot hide it).
 */
export function aggregateRows(lines: readonly RowDelta[]): RowDelta[] {
  const rows = new Map<string, RowKey & { total: bigint }>();
  for (const l of lines) {
    const key = `${l.accountId}\u0000${l.shard}`;
    const found = rows.get(key);
    if (found) found.total += BigInt(l.amountMinor);
    else
      rows.set(key, {
        accountId: l.accountId,
        shard: l.shard,
        total: BigInt(l.amountMinor),
      });
  }
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  return [...rows.values()].sort(compareRows).map((r) => {
    if (r.total > max || r.total < -max)
      throw new JournalInvalid('balance_overflow');
    return {
      accountId: r.accountId,
      shard: r.shard,
      amountMinor: Number(r.total),
    };
  });
}
