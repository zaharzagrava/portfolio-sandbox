import type { LiveComment } from './live-constants';

export type DeliveredComment = LiveComment & { mine?: true };

export interface WindowInput {
  /** Staff comments of the window: never dropped, never capped. */
  priority: LiveComment[];
  /** The sample drawn from the ordinary comments of the window. */
  sample: LiveComment[];
  /** The viewer's own comments of the window (empty for anonymous viewers and for viewers who did not post). */
  own?: LiveComment[];
}

const byId = (a: LiveComment, b: LiveComment) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * What one viewer receives for one window (FR-010): priority + own + sample, each comment once, ascending by id.
 * Comments the viewer wrote carry `mine: true` on this per-viewer copy; nobody else's copy does.
 */
export function composeWindow(input: WindowInput): DeliveredComment[] {
  const own = input.own ?? [];
  const mineIds = new Set(own.map((c) => c.id));
  const byKey = new Map<string, LiveComment>();
  for (const comment of [...input.priority, ...own, ...input.sample])
    if (!byKey.has(comment.id)) byKey.set(comment.id, comment);
  return [...byKey.values()]
    .sort(byId)
    .map((c) => (mineIds.has(c.id) ? { ...c, mine: true as const } : c));
}
