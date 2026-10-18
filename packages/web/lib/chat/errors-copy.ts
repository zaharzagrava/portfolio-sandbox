import type { ChatProblem } from '@/lib/api/chat';
import { waitPhrase } from '@/lib/auth/retry-after';

/**
 * The visible form of every problem the chat can return (W05 FR-060..FR-063, AS-05, AS-18, AS-19, AS-20). The text comes from
 * the stable `code` and the HTTP status only: the server's `title` and `detail` are never shown. Unknown codes fall back by
 * status class (FR-062); a server failure, a network failure or an unparsable answer adds "Reference: {requestId}" when known.
 */

export const UNAVAILABLE_CHAT_TEXT = "This chat isn't available.";
const GENERIC_4XX = "Something didn't work. Check the details and try again.";
const GENERIC_5XX = 'Something went wrong. Try again.';

const reference = (problem: ChatProblem): { reference?: string } => (problem.requestId ? { reference: `Reference: ${problem.requestId}` } : {});
const isTransient = (problem: ChatProblem) => problem.status === 0 || problem.status >= 500;
const mutedClock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// --- opening a chat from a product (AS-05) ------------------------------------------------------------------------------

export type ResolveCopy = {
  text: string;
  /** The way out shown next to the message. */
  action: 'browse-products' | 'back-to-product' | 'try-again' | 'none';
  reference?: string;
  /** For `try-again` after a rate limit: the button is enabled when the wait ends. */
  retryAfterSeconds?: number;
};

export function resolveCopy(problem: ChatProblem): ResolveCopy {
  const { status, code } = problem;
  if (code === 'validation_failed' || code === 'product_not_found') return { text: "This product link isn't valid.", action: 'browse-products' };
  if (code === 'channel_archived') return { text: "This chat was archived and isn't accepting new members.", action: 'back-to-product' };
  if (code === 'banned') return { text: "You can't join this chat.", action: 'none' };
  if (code === 'permission_denied') return { text: "Only staff of this product's shop can open its chat.", action: 'none' };
  if (status === 429 || code === 'rate_limited') {
    return { text: `Too many requests. Try again in ${waitPhrase(problem.retryAfterSeconds)}.`, action: 'try-again', ...(problem.retryAfterSeconds !== undefined ? { retryAfterSeconds: problem.retryAfterSeconds } : {}) };
  }
  if (isTransient(problem)) return { text: "We couldn't open this chat.", action: 'try-again', ...reference(problem) };
  return { text: GENERIC_4XX, action: 'none' };
}

/** `404 channel_not_found` on the by-product lookup is a state, not an error (AS-03). */
export const NO_CHAT_YET_TEXT = "The seller hasn't opened a chat for this product yet.";

// --- sending (AS-18, AS-19) -------------------------------------------------------------------------------------------------

export type SendEffect =
  /** The composer is replaced and the conversation is read-only. */
  | 'banned'
  /** The composer is off until `mutedUntil`, then a timer re-enables it. */
  | 'muted'
  | 'archived'
  /** The pane is replaced by the unavailable state. */
  | 'unavailable'
  /** The reply reference is dropped; Retry sends the text without it under a new `clientMessageId`. */
  | 'reply-target'
  /** The bubble is "Not sent" with Retry and Discard. */
  | 'refused'
  /** Rate limited: Retry is disabled until the wait ends. */
  | 'wait'
  /** The request did not complete (network or 5xx): "Not sent", retried automatically on reconnection. */
  | 'transient';

export type SendCopy = { text: string; effect: SendEffect; reference?: string; mutedUntil?: string; retryAfterSeconds?: number };

export function sendCopy(problem: ChatProblem): SendCopy {
  const { status, code } = problem;
  if (code === 'banned') return { text: 'You can no longer take part in this chat.', effect: 'banned' };
  if (code === 'muted') {
    return problem.mutedUntil && Number.isFinite(Date.parse(problem.mutedUntil))
      ? { text: `You're muted until ${mutedClock(problem.mutedUntil)}.`, effect: 'muted', mutedUntil: problem.mutedUntil }
      : { text: "You're muted.", effect: 'muted' };
  }
  if (code === 'channel_archived') return { text: 'This chat was archived. You can read it, but not reply.', effect: 'archived' };
  if (code === 'channel_not_found' || status === 404 || status === 403) return { text: UNAVAILABLE_CHAT_TEXT, effect: 'unavailable' };
  if (code === 'reply_target_invalid') return { text: 'The message you replied to is no longer available.', effect: 'reply-target' };
  if (code === 'validation_failed') return { text: "That message can't be sent.", effect: 'refused' };
  if (status === 429 || code === 'rate_limited') {
    return {
      text: `You're sending messages too fast. Try again in ${waitPhrase(problem.retryAfterSeconds)}.`,
      effect: 'wait',
      ...(problem.retryAfterSeconds !== undefined ? { retryAfterSeconds: problem.retryAfterSeconds } : {}),
    };
  }
  if (isTransient(problem)) return { text: GENERIC_5XX, effect: 'transient', ...reference(problem) };
  if (code === 'idempotency_key_reuse' || code === 'idempotency_conflict') return { text: GENERIC_5XX, effect: 'refused' };
  return { text: GENERIC_4XX, effect: 'refused' };
}

/** `network` failures (nothing answered, or a 5xx) are retried once automatically on reconnection; refusals (4xx) never. */
export function sendFailureKind(problem: ChatProblem): 'network' | 'refused' {
  return isTransient(problem) ? 'network' : 'refused';
}

// --- deleting a message (AS-20) ---------------------------------------------------------------------------------------------

export type DeleteCopy = { text: string; effect: 'toast' | 'done'; reference?: string };

/** `404` is success (it is already gone); `403` is a toast; anything else is the generic failure. */
export function deleteCopy(problem: ChatProblem): DeleteCopy {
  if (problem.status === 404) return { text: '', effect: 'done' };
  if (problem.status === 403) return { text: "You can't delete this message.", effect: 'toast' };
  return { text: isTransient(problem) ? GENERIC_5XX : GENERIC_4XX, effect: 'toast', ...(isTransient(problem) ? reference(problem) : {}) };
}

// --- reading a chat (AS-12, AS-40) -------------------------------------------------------------------------------------------

export type LoadCopy = { text: string; effect: 'unavailable' | 'retry'; reference?: string };

/** A failed read of a chat the member could read a moment ago: `403`/`404` is the unavailable state, the rest can be retried. */
export function loadCopy(problem: ChatProblem): LoadCopy {
  if (problem.status === 403 || problem.status === 404) return { text: UNAVAILABLE_CHAT_TEXT, effect: 'unavailable' };
  return { text: "We couldn't load this chat.", effect: 'retry', ...reference(problem) };
}
