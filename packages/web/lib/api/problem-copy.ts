import type { Problem } from '@/lib/api/errors';
import { COPY } from '@/lib/auth/copy';
import { waitSentence } from '@/lib/auth/retry-after';

/**
 * The Copy catalogue of W02 (spec FR-170..FR-176) as one function: `(surface, problem)` -> the visible text. The text
 * comes from the stable `code` and the HTTP status only; the server's `title`, `detail` and `message` are never
 * rendered (AS-73). `Problem` is W01's, and `ProblemAlert` shows the result.
 */

export type Surface =
  | 'search'
  | 'pickup-search'
  | 'product'
  | 'pickup'
  | 'discussions-read'
  | 'discussions-write'
  | 'vote'
  | 'ask'
  | 'share'
  | 'video';

export type CopyOptions = {
  /** What a vote, reply or delete is aimed at; picks "post" or "comment" in a few texts. Default `post`. */
  target?: 'post' | 'comment';
};

export type ProblemCopy = {
  text: string;
  /** "Reference: {requestId}" for 5xx and unknown errors. */
  reference?: string;
  retryable: boolean;
};

const SESSION_CODES = new Set(['unauthorized', 'unauthenticated', 'session_expired', 'invalid_token']);
const RELOAD = 'Something went wrong. Reload the page and try again.';
const FIRST_PAGE = 'That page is no longer available. Showing the first page.';

const RATE_SUBJECT: Partial<Record<Surface, string>> = {
  search: 'Too many searches',
  'discussions-write': "You're posting too fast",
  vote: "You're voting too fast",
  ask: "You've asked a lot of questions",
  share: 'Too many share links created',
};

/** The sentence for "the service behind this surface is down" (5xx). */
const UNAVAILABLE: Partial<Record<Surface, string>> = {
  search: 'Search is temporarily unavailable. Try again.',
  'pickup-search': 'Pickup search is temporarily unavailable. Try again.',
  product: "This product page couldn't be loaded right now. Try again.",
  pickup: 'Pickup availability is temporarily unavailable. Try again.',
  'discussions-read': 'Discussions are temporarily unavailable. Try again.',
  'discussions-write': 'Discussions are temporarily unavailable. Try again.',
  vote: 'Discussions are temporarily unavailable. Try again.',
  share: 'Sharing is temporarily unavailable. Try again.',
  video: 'Video is temporarily unavailable. Try again.',
};

const DISCUSSION_SURFACES = new Set<Surface>(['discussions-read', 'discussions-write', 'vote']);

type Answer = { text: string; fallback?: boolean };

/** Codes with a fixed text on a surface (before the status rules). */
function byCode(surface: Surface, problem: Problem, target: 'post' | 'comment'): string | undefined {
  const { code } = problem;
  switch (surface) {
    case 'search':
    case 'discussions-read':
      if (code === 'invalid_cursor') return FIRST_PAGE;
      break;
    default:
  }
  if (DISCUSSION_SURFACES.has(surface)) {
    switch (code) {
      case 'board_not_found':
        return "Discussions aren't available for this product.";
      case 'board_closed':
        return 'Discussions are closed for this product.';
      case 'parent_deleted':
        return "You can't reply to a deleted comment.";
      case 'max_depth_exceeded':
        return 'This conversation is too deep to reply to. Start a new comment instead.';
      case 'parent_not_found':
      case 'comment_not_found':
        return 'That comment is no longer available.';
      case 'post_not_found':
        return 'That post is no longer available.';
      case 'target_not_found':
        return `That ${target} is no longer available.`;
      case 'target_deleted':
        return 'That comment was deleted.';
      case 'self_vote_not_allowed':
        return `You can't vote on your own ${target}.`;
      case 'forbidden':
        return "You can't do that.";
      case 'idempotency_key_required':
      case 'idempotency_key_reuse':
      case 'request_in_progress':
        return RELOAD;
      case 'validation_failed':
        return COPY.checkFields;
      default:
    }
  }
  if (surface === 'ask') {
    switch (code) {
      case 'input_rejected':
        return "We can't answer that question. Try rephrasing it.";
      case 'assistant_busy':
        return waitSentence('The assistant is busy right now', problem.retryAfterSeconds);
      case 'assistant_unavailable':
        return 'The assistant is unavailable right now. Try again later.';
      case 'validation_failed':
        return 'Questions must be between 3 and 500 characters.';
      default:
    }
  }
  if (surface === 'share') {
    if (code === 'link_limit_reached') return "You've reached the limit of share links.";
  }
  return undefined;
}

function answer(surface: Surface, problem: Problem, target: 'post' | 'comment'): Answer {
  const { status } = problem;
  if (status === 0) return { text: COPY.offline };
  if (status === 401 || (problem.code && SESSION_CODES.has(problem.code))) return { text: COPY.sessionEnded };

  const fixed = byCode(surface, problem, target);
  if (fixed) return { text: fixed };

  if (status === 429 || problem.code === 'rate_limited') {
    return { text: waitSentence(RATE_SUBJECT[surface] ?? 'Too many requests', problem.retryAfterSeconds) };
  }

  // Status rules per surface.
  if (status === 404) {
    switch (surface) {
      case 'product':
        return { text: "We couldn't find that product." };
      case 'discussions-read':
        return { text: "Discussions aren't available for this product." };
      case 'ask':
        return { text: "Questions aren't available for this product." };
      case 'video':
        return { text: "This video isn't available." };
      default:
    }
  }
  if (surface === 'ask' && status === 422) return { text: "We can't answer that question. Try rephrasing it." };
  if (surface === 'ask' && status === 400) return { text: 'Questions must be between 3 and 500 characters.' };
  if (surface === 'ask' && status === 503) return { text: 'The assistant is unavailable right now. Try again later.' };
  if (surface === 'share' && (status === 400 || status === 422)) return { text: "This product can't be shared right now." };

  if (status >= 500) return { text: UNAVAILABLE[surface] ?? (status === 503 ? COPY.slow : COPY.server) };
  if (status >= 400) return { text: COPY.fallback4xx, fallback: true };
  return { text: COPY.server, fallback: true };
}

export function problemCopy(surface: Surface, problem: Problem, options: CopyOptions = {}): ProblemCopy {
  const result = answer(surface, problem, options.target ?? 'post');
  const unknown = result.fallback === true || (problem.status >= 400 && problem.status < 500 && !problem.code && problem.status !== 429 && problem.status !== 401);
  const showReference = problem.status !== 0 && Boolean(problem.requestId) && (problem.status >= 500 || unknown);
  return {
    text: result.text,
    ...(showReference ? { reference: `Reference: ${problem.requestId}` } : {}),
    retryable: problem.status === 0 || problem.status === 429 || problem.status >= 500,
  };
}
