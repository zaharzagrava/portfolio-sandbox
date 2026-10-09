import { randomInt } from 'node:crypto';

/** Top-level comments per bucket partition: a 50k-comment thread spans ~10 partitions, each a bounded read. */
export const COMMENTS_PER_BUCKET = 5_000;

/**
 * Materialized-path segment: base-36 milliseconds (fixed width 9 → lexicographic
 * order = chronological order until year 5188) + 3 random chars to break ties.
 * Coordination-free: no per-parent counter that a lost Redis key could reset
 * into duplicate paths.
 */
export function pathSegment(now = Date.now()): string {
  return (
    now.toString(36).padStart(9, '0') +
    randomInt(36 ** 3)
      .toString(36)
      .padStart(3, '0')
  );
}

export function childPath(parentPath: string | null, now?: number): string {
  return parentPath ? `${parentPath}.${pathSegment(now)}` : pathSegment(now);
}

/** All descendants of `path` sort in [path + '.', path + '/') - '/' is the next ASCII char after '.'. */
export function subtreeRange(path: string): { from: string; to: string } {
  return { from: `${path}.`, to: `${path}/` };
}
