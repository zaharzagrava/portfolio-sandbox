import type {
  LiveComment,
  LivePin,
  LivePinEvent,
  LiveStats,
  LiveStatus,
} from './schemas.ts';

/**
 * What a viewer's client keeps for one stream. Every event is merged, never replayed: a stale pin or stats is ignored,
 * a removal is remembered even when its comment has not arrived, so any order and any duplication of the events of one
 * stream reaches the same state (S23 FR-013, AS-09).
 */
export interface LiveClientState {
  status: LiveStatus | null;
  pin: LivePin | null;
  /** Version of the last applied pin change; 0 before any. */
  pinVersion: number;
  stats: LiveStats | null;
  /** Visible comments, ascending by id. */
  comments: LiveComment[];
  /** Ids removed so far, ascending (a comment with one of these ids is never displayed). */
  removed: string[];
}

export type LiveClientEvent =
  | {
      type: 'snapshot';
      data: {
        status: LiveStatus;
        pin: LivePin | null;
        pinVersion?: number;
        recent: LiveComment[];
      };
    }
  | { type: 'comments'; data: { items: LiveComment[] } }
  | { type: 'pin'; data: LivePinEvent }
  | { type: 'comment_removed'; data: { id: string } }
  | { type: 'status'; data: { status: LiveStatus } }
  | { type: 'stats'; data: LiveStats };

export const initialLiveState = (): LiveClientState => ({
  status: null,
  pin: null,
  pinVersion: 0,
  stats: null,
  comments: [],
  removed: [],
});

const RANK: Record<LiveStatus, number> = { SCHEDULED: 0, LIVE: 1, ENDED: 2 };
const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const mergeComments = (
  state: LiveClientState,
  incoming: LiveComment[],
): Pick<LiveClientState, 'comments'> => {
  const removed = new Set(state.removed);
  const known = new Map(state.comments.map((c) => [c.id, c]));
  for (const comment of incoming)
    if (!removed.has(comment.id) && !known.has(comment.id))
      known.set(comment.id, comment);
  return { comments: [...known.values()].sort(byId) };
};

const mergeStatus = (
  current: LiveStatus | null,
  next: LiveStatus,
): LiveStatus =>
  current === null || RANK[next] > RANK[current] ? next : current;

const withPin = (
  state: LiveClientState,
  version: number,
  pin: LivePin | null,
): LiveClientState =>
  version > state.pinVersion ? { ...state, pin, pinVersion: version } : state;

/** Pure; the caller replaces its state with the result. */
export function reduceLive(
  state: LiveClientState,
  event: LiveClientEvent,
): LiveClientState {
  switch (event.type) {
    case 'snapshot': {
      const pinVersion = event.data.pinVersion ?? event.data.pin?.version ?? 0;
      const pinned = withPin(state, pinVersion, event.data.pin);
      return {
        ...pinned,
        status: mergeStatus(state.status, event.data.status),
        ...mergeComments(state, event.data.recent),
      };
    }
    case 'comments':
      return { ...state, ...mergeComments(state, event.data.items) };
    case 'pin':
      return withPin(
        state,
        event.data.version,
        'unpinned' in event.data ? null : event.data,
      );
    case 'comment_removed': {
      if (state.removed.includes(event.data.id)) return state;
      return {
        ...state,
        removed: [...state.removed, event.data.id].sort(),
        comments: state.comments.filter((c) => c.id !== event.data.id),
      };
    }
    case 'status':
      return { ...state, status: mergeStatus(state.status, event.data.status) };
    case 'stats':
      return state.stats && event.data.second <= state.stats.second
        ? state
        : { ...state, stats: event.data };
  }
}
