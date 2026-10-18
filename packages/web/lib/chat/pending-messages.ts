/**
 * The lifecycle of a message the member has sent but the server has not confirmed (W05 FR-026, FR-027, AS-14..AS-19).
 * One `clientMessageId` is made per user action and kept for every retry, manual or automatic, so a request that had in fact
 * succeeded comes back `200 duplicate: true` and is shown once. Pending bubbles live in the conversation's `useReducer`,
 * in memory only; a confirmed message goes to the query cache and its bubble is removed.
 */

/** A fresh `clientMessageId` for a new user action. Never call this for a retry. */
export function newClientMessageId(): string {
  return crypto.randomUUID();
}

export type PendingMessage = {
  clientMessageId: string;
  body: string;
  replyToId: string | null;
  state: 'sending' | 'failed';
  /** Set when `failed`: `network` (nothing answered, or a 5xx) can be retried automatically; `refused` (a 4xx) never. */
  failure?: 'network' | 'refused';
  /** A refusal's problem code (`reply_target_invalid`, `validation_failed`, `rate_limited`, ...). */
  reason?: string;
  /** Epoch milliseconds before which Retry is disabled (a `429` with `Retry-After`). */
  retryAfterAt?: number;
};

export type PendingState = { items: PendingMessage[] };

export const initialPending: PendingState = { items: [] };

export type PendingAction =
  | { type: 'submit'; clientMessageId: string; body: string; replyToId?: string | null }
  | { type: 'confirmed'; clientMessageId: string }
  | { type: 'failed'; clientMessageId: string; failure: 'network' }
  | { type: 'refused'; clientMessageId: string; reason: string; retryAfterAt?: number }
  | { type: 'retry'; clientMessageId: string; now: number }
  /** `reply_target_invalid`: the reference is dropped and the draft becomes a new action with a new id, in the same place. */
  | { type: 'retryWithoutReply'; clientMessageId: string; newClientMessageId: string }
  | { type: 'discard'; clientMessageId: string }
  /** The session ended: drafts and bubbles hold no data worth keeping (AS-40). */
  | { type: 'clear' };

const indexOf = (state: PendingState, clientMessageId: string) => state.items.findIndex((item) => item.clientMessageId === clientMessageId);

function replaceAt(state: PendingState, index: number, item: PendingMessage): PendingState {
  const items = state.items.slice();
  items[index] = item;
  return { items };
}

/** Whether Retry may be pressed now: the bubble failed and no wait is running. */
export function canRetry(item: PendingMessage, now: number): boolean {
  return item.state === 'failed' && (item.retryAfterAt === undefined || item.retryAfterAt <= now);
}

/** The bubbles to retry on `online` or a reopened connection: network failures only, oldest first. */
export function autoRetryIds(state: PendingState): string[] {
  return state.items.filter((item) => item.state === 'failed' && item.failure === 'network').map((item) => item.clientMessageId);
}

export function pendingReducer(state: PendingState, action: PendingAction): PendingState {
  switch (action.type) {
    case 'submit':
      if (indexOf(state, action.clientMessageId) >= 0) return state;
      return { items: [...state.items, { clientMessageId: action.clientMessageId, body: action.body, replyToId: action.replyToId ?? null, state: 'sending' }] };
    case 'confirmed': {
      const index = indexOf(state, action.clientMessageId);
      return index < 0 ? state : { items: state.items.filter((_, at) => at !== index) };
    }
    case 'failed': {
      const index = indexOf(state, action.clientMessageId);
      const item = state.items[index];
      if (!item || item.state !== 'sending') return state;
      return replaceAt(state, index, { clientMessageId: item.clientMessageId, body: item.body, replyToId: item.replyToId, state: 'failed', failure: action.failure });
    }
    case 'refused': {
      const index = indexOf(state, action.clientMessageId);
      const item = state.items[index];
      if (!item || item.state !== 'sending') return state;
      return replaceAt(state, index, {
        clientMessageId: item.clientMessageId,
        body: item.body,
        replyToId: item.replyToId,
        state: 'failed',
        failure: 'refused',
        reason: action.reason,
        ...(action.retryAfterAt !== undefined ? { retryAfterAt: action.retryAfterAt } : {}),
      });
    }
    case 'retry': {
      const index = indexOf(state, action.clientMessageId);
      const item = state.items[index];
      if (!item || !canRetry(item, action.now)) return state;
      return replaceAt(state, index, { clientMessageId: item.clientMessageId, body: item.body, replyToId: item.replyToId, state: 'sending' });
    }
    case 'retryWithoutReply': {
      const index = indexOf(state, action.clientMessageId);
      const item = state.items[index];
      if (!item || item.state !== 'failed' || indexOf(state, action.newClientMessageId) >= 0) return state;
      return replaceAt(state, index, { clientMessageId: action.newClientMessageId, body: item.body, replyToId: null, state: 'sending' });
    }
    case 'discard': {
      const index = indexOf(state, action.clientMessageId);
      return index < 0 ? state : { items: state.items.filter((_, at) => at !== index) };
    }
    case 'clear':
      return state.items.length === 0 ? state : initialPending;
  }
}
