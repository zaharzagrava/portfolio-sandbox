import type { Problem } from '@/lib/api/errors';
import { COPY } from '@/lib/auth/copy';
import { formatWait, waitSentence } from '@/lib/auth/retry-after';

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
  // S46 shopping assistant: sending a message and resuming a reply.
  | 'assistant'
  | 'share'
  | 'video'
  // W03 (FR-081): cart, checkout, pay step, orders, notification inbox.
  | 'cart'
  | 'checkout'
  | 'pay'
  | 'orders'
  | 'notifications';

export type CopyOptions = {
  /** What a vote, reply or delete is aimed at; picks "post" or "comment" in a few texts. Default `post`. */
  target?: 'post' | 'comment';
  /** W03: a failed `read` says what could not be loaded; a `write` (default) says the change was not saved. */
  operation?: 'read' | 'write';
  /** W03 checkout: product titles for `out_of_stock` and `product_unavailable` (looked up by the caller from `productIds`). */
  titles?: string[];
  /** W03 orders: the visible text of the order's current status, for `order_not_cancellable`. */
  statusText?: string;
  /** W03 FR-082: the server's `detail`, offered as a second line of the generic form when it is a short plain 4xx string. */
  detail?: string;
};

export type ProblemCopy = {
  text: string;
  /** "Reference: {requestId}" for 5xx and unknown errors. */
  reference?: string;
  /** W03 FR-082: a second line, only for the generic form of a 4xx, only a plain string of at most 200 characters. */
  detail?: string;
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
  assistant: "You're sending messages too fast",
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

type Answer = { text: string; fallback?: boolean; generic?: boolean };

// --- W03 (FR-081, FR-082) ----------------------------------------------------------------------------------------------
const W03_SURFACES = new Set<Surface>(['cart', 'checkout', 'pay', 'orders', 'notifications']);
const W03_GENERIC = 'Something went wrong. Try again.';
const W03_OFFLINE_WRITE: Record<string, string> = {
  cart: "You're offline. The change wasn't saved.",
  checkout: 'Checkout is temporarily unavailable. Nothing was charged. Try again in a moment.',
};
const W03_OFFLINE_DEFAULT = "You're offline. Check your connection and try again.";
const W03_READ_FAILED: Record<string, string> = {
  cart: "We couldn't load your cart.",
  orders: "We couldn't load your orders.",
  notifications: "We couldn't load notifications.",
};
const W03_RATE_SUBJECT: Record<string, string> = {
  cart: "You're changing the cart too fast",
  checkout: 'Too many attempts',
  pay: 'Too many attempts',
  orders: 'Too many requests',
};

const titleList = (titles: string[] | undefined): string | undefined => (titles && titles.length > 0 ? titles.join(', ') : undefined);

/** Codes with a fixed text on a W03 surface. */
function w03ByCode(surface: Surface, problem: Problem, options: CopyOptions): string | undefined {
  const { code } = problem;
  if (surface === 'cart' && code === 'cart_line_limit') return 'Your cart is full (50 different items). Remove one to add another.';
  if (surface === 'checkout') {
    switch (code) {
      case 'cart_empty':
        return 'Your cart is empty.';
      case 'mixed_currency':
        return 'Your cart has items priced in different currencies. Remove the items of one currency to continue.';
      case 'price_changed':
        return 'Prices changed since you added these items.';
      case 'out_of_stock': {
        const titles = titleList(options.titles);
        return titles ? `Not enough stock for: ${titles}. Nothing was reserved.` : 'Not enough stock for some items. Nothing was reserved.';
      }
      case 'product_unavailable': {
        const titles = titleList(options.titles);
        return titles ? `Some items can't be bought any more: ${titles}.` : "Some items can't be bought any more.";
      }
      case 'idempotency_in_flight':
        return "We're still processing your order. Check Your orders before trying again.";
      case 'checkout_in_progress':
        return 'Another checkout for your cart is in progress. Check Your orders or try again in a moment.';
      case 'checkout_unavailable':
        return 'Checkout is temporarily unavailable. Nothing was charged. Try again in a moment.';
      case 'flash_sale_limit_exceeded':
        return "You've reached the purchase limit for this sale item.";
      case 'flash_sale_busy':
        return waitSentence('This sale is very busy', problem.retryAfterSeconds);
      case 'flash_sale_unavailable':
        return 'This sale is temporarily unavailable. Try again shortly.';
      default:
    }
  }
  if (surface === 'pay') {
    switch (code) {
      case 'order_not_found':
        return "We couldn't start the payment yet. Try again.";
      case 'payment_not_found':
        return "We couldn't find that payment.";
      case 'order_not_payable':
        return "This order can't be paid any more.";
      case 'payment_already_exists':
        return 'A payment for this order is already in progress.';
      case 'idempotency_in_flight':
        return "We're still processing your payment. Try again in a moment.";
      default:
    }
  }
  if (surface === 'orders') {
    switch (code) {
      case 'order_not_found':
        return "We couldn't find that order.";
      case 'order_not_cancellable':
        return options.statusText ? `This order can't be cancelled any more (it is now ${options.statusText}).` : "This order can't be cancelled any more.";
      case 'invalid_cursor':
        return 'This page of orders is no longer available.';
      default:
    }
  }
  if (surface === 'notifications' && code === 'invalid_cursor') return "We couldn't load notifications.";
  return undefined;
}

function w03Answer(surface: Surface, problem: Problem, options: CopyOptions): Answer {
  const { status } = problem;
  if (status === 0) {
    if (options.operation === 'read' && W03_READ_FAILED[surface]) return { text: W03_READ_FAILED[surface] };
    return { text: W03_OFFLINE_WRITE[surface] ?? W03_OFFLINE_DEFAULT };
  }
  if (status === 401 || (problem.code && SESSION_CODES.has(problem.code))) return { text: COPY.sessionEnded };
  const fixed = w03ByCode(surface, problem, options);
  if (fixed) return { text: fixed };
  if (status === 429 || problem.code === 'rate_limited') {
    if (surface === 'notifications') {
      const wait = formatWait(problem.retryAfterSeconds);
      return { text: wait ? `Try again in ${wait}.` : 'Try again later.' };
    }
    return { text: waitSentence(W03_RATE_SUBJECT[surface] ?? 'Too many requests', problem.retryAfterSeconds) };
  }
  return { text: W03_GENERIC, fallback: true, generic: true };
}

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
  if (surface === 'assistant') {
    switch (code) {
      case 'input_rejected':
        return "I can't help with that message. Try rephrasing it.";
      case 'too_many_active_turns':
        return waitSentence('Wait for your other answers to finish', problem.retryAfterSeconds);
      case 'assistant_busy':
        return waitSentence('The assistant is busy right now', problem.retryAfterSeconds);
      case 'assistant_unavailable':
        return 'The assistant is unavailable right now. Try again later.';
      case 'quota_exceeded':
        return "You've used this month's assistant allowance.";
      case 'conversation_full':
        return 'This chat is full. Start a new one.';
      case 'turn_in_progress':
        return 'The assistant is still answering. Wait for it to finish.';
      case 'idempotency_key_required':
      case 'idempotency_key_reuse':
      case 'invalid_last_event_id':
        return RELOAD;
      case 'validation_failed':
        return 'Messages must be between 1 and 4000 characters.';
      default:
    }
  }
  if (surface === 'share') {
    if (code === 'link_limit_reached') return "You've reached the limit of share links.";
  }
  return undefined;
}

function answer(surface: Surface, problem: Problem, options: CopyOptions): Answer {
  if (W03_SURFACES.has(surface)) return w03Answer(surface, problem, options);
  const target = options.target ?? 'post';
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
  const result = answer(surface, problem, options);
  const unknown = result.fallback === true || (problem.status >= 400 && problem.status < 500 && !problem.code && problem.status !== 429 && problem.status !== 401);
  const showReference = problem.status !== 0 && Boolean(problem.requestId) && (problem.status >= 500 || unknown);
  // FR-082: only the generic form of a 4xx may add the server's plain-string detail; a 5xx detail is never shown.
  const detail = typeof options.detail === 'string' ? options.detail.trim() : '';
  const showDetail = result.generic === true && problem.status >= 400 && problem.status < 500 && detail.length > 0 && detail.length <= 200;
  return {
    text: result.text,
    ...(showReference ? { reference: `Reference: ${problem.requestId}` } : {}),
    ...(showDetail ? { detail } : {}),
    retryable: problem.status === 0 || problem.status === 429 || problem.status >= 500,
  };
}
