import { sortableId } from './ids';

/**
 * Thread positions (S25 B3, B7). A comment's `path` is its ancestors' segments joined by `.`; a segment is the
 * sortable form of the comment's own ID (timestamp first, 31 characters), so a path is unique by construction,
 * sorts parents before children and siblings by creation time, and needs no counter, clock or randomness here.
 */

/** Deepest allowed comment (top level = 0). */
export const MAX_DEPTH = 8;

const SEPARATOR = '.';

export function pathFor(parentPath: string | null, commentId: string): string {
  const segment = sortableId(commentId).slice(1); // drop the constant version nibble
  return parentPath ? `${parentPath}${SEPARATOR}${segment}` : segment;
}

export const depthOf = (path: string): number =>
  path.split(SEPARATOR).length - 1;

export const rootPathOf = (path: string): string => path.split(SEPARATOR)[0];

export const childDepth = (parentDepth: number): number => parentDepth + 1;

/** All descendants of `path` sort in [path + '.', path + '/') - '/' is the next ASCII character after '.'. */
export function subtreeRange(path: string): { from: string; to: string } {
  return { from: `${path}${SEPARATOR}`, to: `${path}/` };
}

export interface RootSlotState {
  bucket: number;
  filled: number;
}

/**
 * The slot the next top-level comment of a post takes: buckets fill up to `partitionSize`, then the next bucket starts.
 * The store applies the result with a compare-and-set, so concurrent creators get distinct slots.
 */
export function assignRootSlot(
  current: RootSlotState | undefined,
  partitionSize: number,
): RootSlotState {
  if (!current) return { bucket: 0, filled: 1 };
  return current.filled >= partitionSize
    ? { bucket: current.bucket + 1, filled: 1 }
    : { bucket: current.bucket, filled: current.filled + 1 };
}
