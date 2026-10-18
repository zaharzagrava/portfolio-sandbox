import type { AssistantProblem } from '@/lib/api/assistant';
import { waitPhrase } from '@/lib/auth/retry-after';
import type { LostReason, ReplyOutcome } from './reply-reducer';

/**
 * The visible form of every refusal and error of the assistant (W05 FR-060..FR-063, AS-56..AS-59). Copy comes from the stable
 * `code`, the stream's terminal `error` code and the HTTP status only; the server's `title`/`detail` and any provider, model or
 * stack text never reach the screen. Unknown codes fall back by status class (FR-062).
 */

const GENERIC_4XX = "Something didn't work. Check the details and try again.";
const GENERIC_5XX = 'Something went wrong. Try again.';

const localDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
const validInstant = (iso: string | undefined): iso is string => iso !== undefined && Number.isFinite(Date.parse(iso));

// --- a send refused before the stream starts (AS-56, AS-59, AS-54, AS-60) ----------------------------------------------------

export type SendEffect =
  | 'none'
  /** The composer is replaced by "This chat is full." with New chat (AS-64). */
  | 'new-chat'
  /** The conversation is gone: the sheet resets to an empty one. */
  | 'reset-conversation'
  /** Send is disabled for `waitSeconds`, then enabled again by a timer. */
  | 'wait'
  /** The composer is disabled until `resetsAt`, then the usage is read again. */
  | 'quota'
  /** The same key is still being answered: attach to `messageId`. */
  | 'attach'
  /** The text changed under the same key: start again with a new key. */
  | 'new-key'
  /** W01's session-ended flow runs once; nothing else happens here. */
  | 'session-ended';

export type SendProblemCopy = {
  text: string;
  effect: SendEffect;
  /** The member's text stays in the field and nothing is added to the transcript. */
  keepText: boolean;
  waitSeconds?: number;
  resetsAt?: string;
  messageId?: string;
  reference?: string;
};

export function sendProblemCopy(problem: AssistantProblem): SendProblemCopy {
  const { status, code } = problem;
  const keep = { keepText: true } as const;
  const reference = problem.requestId ? { reference: `Reference: ${problem.requestId}` } : {};
  if (status === 401 || code === 'unauthenticated') return { text: '', effect: 'session-ended', keepText: true };
  switch (code) {
    case 'validation_failed':
      return { text: "That message can't be sent. Messages can be up to 4,000 characters.", effect: 'none', ...keep };
    case 'input_rejected':
      return {
        text: problem.category === 'sensitive_data' ? 'Your message looks like it contains a card number or a password. Remove it and try again.' : "I can't help with that request.",
        effect: 'none',
        ...keep,
      };
    case 'turn_in_progress':
      return { text: 'The assistant is still answering. Wait for it to finish.', effect: 'none', ...keep };
    case 'conversation_full':
      return { text: 'This chat is full. Start a new chat to continue.', effect: 'new-chat', ...keep };
    case 'not_found':
      return { text: 'This chat no longer exists.', effect: 'reset-conversation', ...keep };
    case 'too_many_active_turns':
      return { text: 'The assistant is already answering in other chats. Wait for one to finish.', effect: 'none', ...keep };
    case 'rate_limited':
      return { text: `You're sending messages too fast. Try again in ${waitPhrase(problem.retryAfterSeconds)}.`, effect: 'wait', ...keep, ...wait(problem) };
    case 'assistant_busy':
      return { text: `The assistant is busy right now. Try again in ${waitPhrase(problem.retryAfterSeconds)}.`, effect: 'wait', ...keep, ...wait(problem) };
    case 'assistant_unavailable':
      return { text: `The assistant is unavailable right now. Try again in ${waitPhrase(problem.retryAfterSeconds)}.`, effect: 'wait', ...keep, ...wait(problem) };
    case 'quota_exceeded': {
      const resetsAt = validInstant(problem.resetsAt) ? problem.resetsAt : undefined;
      return {
        text: `You've used your monthly assistant allowance. It resets ${resetsAt ? `on ${localDate(resetsAt)}` : 'soon'}.`,
        effect: 'quota',
        ...keep,
        ...(resetsAt ? { resetsAt } : {}),
      };
    }
    case 'idempotency_in_flight':
      return problem.messageId ? { text: '', effect: 'attach', messageId: problem.messageId, ...keep } : { text: GENERIC_5XX, effect: 'none', ...keep };
    case 'idempotency_key_reuse':
      return { text: '', effect: 'new-key', ...keep };
    case 'idempotency_key_required':
      return { text: GENERIC_5XX, effect: 'none', ...keep };
    default:
      return status > 0 && status < 500 ? { text: GENERIC_4XX, effect: 'none', ...keep } : { text: GENERIC_5XX, effect: 'none', ...keep, ...reference };
  }
}

const wait = (problem: AssistantProblem): { waitSeconds?: number } => (problem.retryAfterSeconds !== undefined ? { waitSeconds: problem.retryAfterSeconds } : {});

// --- how a reply ends (AS-51, AS-52, AS-57) ------------------------------------------------------------------------------------

export type ReplyEndCopy = {
  text: string;
  /** Try again puts the question back in the field; it is never re-sent automatically and gets a new key. */
  tryAgain: boolean;
  /** "We couldn't reconnect": Try again re-attaches once more instead of asking again. */
  reattach?: boolean;
};

export function replyEndCopy(end: { outcome: Exclude<ReplyOutcome, 'done' | 'refused'>; errorCode?: string; retryAfterMs?: number; lostReason?: LostReason }): ReplyEndCopy {
  if (end.outcome === 'stopped') return { text: "Stopped. This reply wasn't saved.", tryAgain: true };
  if (end.outcome === 'lost') {
    return end.lostReason === 'unreachable'
      ? { text: "We couldn't reconnect to the reply.", tryAgain: true, reattach: true }
      : { text: 'The reply was interrupted. Ask again to retry.', tryAgain: true };
  }
  switch (end.errorCode) {
    case 'CANCELLED':
      return { text: "Stopped. This reply wasn't saved.", tryAgain: true };
    case 'GENERATION_LOST':
      return { text: 'The reply was interrupted. Ask again to retry.', tryAgain: true };
    case 'PROVIDER_UNAVAILABLE':
      return { text: `The assistant is busy right now. Try again in ${waitPhrase(end.retryAfterMs === undefined ? undefined : end.retryAfterMs / 1000)}.`, tryAgain: true };
    case 'TURN_TIMEOUT':
      return { text: 'That took too long to answer. Try a shorter or simpler question.', tryAgain: true };
    case 'MODERATION_UNAVAILABLE':
      return { text: "The assistant can't check this reply right now. Try again in a moment.", tryAgain: true };
    default:
      return { text: 'The assistant ran into a problem. Try again.', tryAgain: true };
  }
}

/** A refusal replaces the streamed text with one notice; the question stays with the note; the category is never shown. */
export function refusalCopy(): { text: string; note: string } {
  return { text: "I can't help with that.", note: "This exchange wasn't saved." };
}

// --- the monthly allowance (AS-47, AS-59) --------------------------------------------------------------------------------------

export type AllowanceView = { percent: number; label: string; usedUp: boolean; resetsAt: string };

/** `floor(used / limit * 100)` capped at 100; nothing when the limit is 0 or unknown (tokens mean nothing to a shopper). */
export function allowanceView(usage: { used: number; limit: number; resetsAt: string } | undefined): AllowanceView | null {
  if (!usage || !(usage.limit > 0)) return null;
  const percent = Math.min(100, Math.floor((Math.max(usage.used, 0) / usage.limit) * 100));
  const usedUp = percent >= 100;
  return {
    percent,
    usedUp,
    resetsAt: usage.resetsAt,
    label: usedUp ? `Monthly allowance used up. Resets ${validInstant(usage.resetsAt) ? localDate(usage.resetsAt) : 'soon'}.` : `${percent}% of your monthly allowance used`,
  };
}
