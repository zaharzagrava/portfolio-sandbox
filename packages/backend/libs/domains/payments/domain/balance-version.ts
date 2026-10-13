export type VersionDecision = 'apply' | 'duplicate' | 'stale';

/**
 * The version guard of the balance read model (FR-025): a line applies only when its balance version is newer than
 * the stored one. A gap (a missed event) is harmless because events carry absolute values.
 */
export function decideVersion(
  stored: number | null,
  incoming: number,
): VersionDecision {
  if (stored === null || incoming > stored) return 'apply';
  return incoming === stored ? 'duplicate' : 'stale';
}

export interface BalanceRow {
  version: number;
  balanceMinor: number;
}

export function applyIfNewer(
  stored: BalanceRow | null,
  incoming: BalanceRow,
): { outcome: 'apply'; row: BalanceRow } | { outcome: 'duplicate' | 'stale' } {
  const outcome = decideVersion(stored?.version ?? null, incoming.version);
  return outcome === 'apply' ? { outcome, row: incoming } : { outcome };
}
