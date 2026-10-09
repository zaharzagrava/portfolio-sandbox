export type VersionDecision = 'apply' | 'duplicate' | 'stale';

const assertVersion = (value: number, what: string): void => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(
      `${what} version must be an integer between 0 and 2^53-1`,
    );
};

/**
 * The version guard as a pure decision (S53 FR-032, FR-044): `apply` when nothing is stored or the stored version
 * is lower, `duplicate` when equal, `stale` when the stored version is higher. Strict: an equal version is a
 * duplicate, never applied twice. Domains that own their read-model tables use it for their own conditional update.
 */
export function applyIfNewer(
  stored: number | null,
  incoming: number,
): VersionDecision {
  assertVersion(incoming, 'incoming');
  if (stored === null) return 'apply';
  assertVersion(stored, 'stored');
  if (incoming > stored) return 'apply';
  return incoming === stored ? 'duplicate' : 'stale';
}
