import { describe, expect, it } from 'vitest';
import type { Problem } from './errors';
import { problemFromError } from './errors';
import { problemCopy, type Surface } from './problem-copy';

const problem = (status: number, code?: string, extra: Partial<Problem> = {}): Problem => ({ status, ...(code ? { code } : {}), errors: [], ...extra });

const OFFLINE = 'You appear to be offline. Check your connection and try again.';
const SESSION = 'Your session ended. Sign in again to continue.';

type Row = [Surface, Problem, string];

const rows: Row[] = [
  // search
  ['search', problem(400, 'invalid_cursor'), 'That page is no longer available. Showing the first page.'],
  ['search', problem(429, 'rate_limited', { retryAfterSeconds: 30 }), 'Too many searches. Try again in 30 seconds.'],
  ['search', problem(429, 'rate_limited'), 'Too many searches. Try again later.'],
  ['search', problem(503, 'search_unavailable'), 'Search is temporarily unavailable. Try again.'],
  ['search', problem(500), 'Search is temporarily unavailable. Try again.'],
  ['search', problem(502), 'Search is temporarily unavailable. Try again.'],
  ['search', problem(0), OFFLINE],
  ['search', problem(404), "Something didn't work. Check the details and try again."],
  ['search', problem(422, 'validation_failed'), "Something didn't work. Check the details and try again."],
  // pickup search
  ['pickup-search', problem(429, 'rate_limited', { retryAfterSeconds: 120 }), 'Too many requests. Try again in 2 minutes.'],
  ['pickup-search', problem(503, 'search_unavailable'), 'Pickup search is temporarily unavailable. Try again.'],
  ['pickup-search', problem(500), 'Pickup search is temporarily unavailable. Try again.'],
  ['pickup-search', problem(0), OFFLINE],
  // product
  ['product', problem(404, 'not_found'), "We couldn't find that product."],
  ['product', problem(503), "This product page couldn't be loaded right now. Try again."],
  ['product', problem(429, 'rate_limited', { retryAfterSeconds: 5 }), 'Too many requests. Try again in 5 seconds.'],
  ['product', problem(0), OFFLINE],
  // pickup
  ['pickup', problem(429, 'rate_limited', { retryAfterSeconds: 3600 }), 'Too many requests. Try again in 1 hour.'],
  ['pickup', problem(503), 'Pickup availability is temporarily unavailable. Try again.'],
  ['pickup', problem(500), 'Pickup availability is temporarily unavailable. Try again.'],
  ['pickup', problem(0), OFFLINE],
  // discussions read
  ['discussions-read', problem(404, 'board_not_found'), "Discussions aren't available for this product."],
  ['discussions-read', problem(429, 'rate_limited', { retryAfterSeconds: 10 }), 'Too many requests. Try again in 10 seconds.'],
  ['discussions-read', problem(503, 'service_unavailable'), 'Discussions are temporarily unavailable. Try again.'],
  ['discussions-read', problem(500), 'Discussions are temporarily unavailable. Try again.'],
  ['discussions-read', problem(400, 'invalid_cursor'), 'That page is no longer available. Showing the first page.'],
  ['discussions-read', problem(0), OFFLINE],
  // discussions write
  ['discussions-write', problem(409, 'board_closed'), 'Discussions are closed for this product.'],
  ['discussions-write', problem(404, 'board_not_found'), "Discussions aren't available for this product."],
  ['discussions-write', problem(429, 'rate_limited', { retryAfterSeconds: 45 }), "You're posting too fast. Try again in 45 seconds."],
  ['discussions-write', problem(409, 'parent_deleted'), "You can't reply to a deleted comment."],
  ['discussions-write', problem(409, 'max_depth_exceeded'), 'This conversation is too deep to reply to. Start a new comment instead.'],
  ['discussions-write', problem(404, 'parent_not_found'), 'That comment is no longer available.'],
  ['discussions-write', problem(404, 'post_not_found'), 'That post is no longer available.'],
  ['discussions-write', problem(404, 'comment_not_found'), 'That comment is no longer available.'],
  ['discussions-write', problem(403, 'forbidden'), "You can't do that."],
  ['discussions-write', problem(401, 'unauthorized'), SESSION],
  ['discussions-write', problem(401, 'session_expired'), SESSION],
  ['discussions-write', problem(400, 'idempotency_key_required'), 'Something went wrong. Reload the page and try again.'],
  ['discussions-write', problem(422, 'idempotency_key_reuse'), 'Something went wrong. Reload the page and try again.'],
  ['discussions-write', problem(409, 'request_in_progress'), 'Something went wrong. Reload the page and try again.'],
  ['discussions-write', problem(400, 'validation_failed'), 'Check the highlighted fields.'],
  ['discussions-write', problem(503, 'service_unavailable'), 'Discussions are temporarily unavailable. Try again.'],
  ['discussions-write', problem(0), OFFLINE],
  // vote
  ['vote', problem(429, 'rate_limited', { retryAfterSeconds: 7 }), "You're voting too fast. Try again in 7 seconds."],
  ['vote', problem(404, 'target_not_found'), 'That post is no longer available.'],
  ['vote', problem(409, 'target_deleted'), 'That comment was deleted.'],
  ['vote', problem(403, 'self_vote_not_allowed'), "You can't vote on your own post."],
  ['vote', problem(401, 'unauthorized'), SESSION],
  ['vote', problem(500), 'Discussions are temporarily unavailable. Try again.'],
  ['vote', problem(0), OFFLINE],
  // ask
  ['ask', problem(422, 'input_rejected'), "We can't answer that question. Try rephrasing it."],
  ['ask', problem(429, 'assistant_busy', { retryAfterSeconds: 20 }), 'The assistant is busy right now. Try again in 20 seconds.'],
  ['ask', problem(429, 'rate_limited', { retryAfterSeconds: 60 }), "You've asked a lot of questions. Try again in 1 minute."],
  ['ask', problem(503, 'assistant_unavailable'), 'The assistant is unavailable right now. Try again later.'],
  ['ask', problem(400, 'validation_failed'), 'Questions must be between 3 and 500 characters.'],
  ['ask', problem(404, 'product_not_found'), "Questions aren't available for this product."],
  ['ask', problem(404), "Questions aren't available for this product."],
  ['ask', problem(500), 'Something went wrong on our side. Try again.'],
  ['ask', problem(0), OFFLINE],
  // share
  ['share', problem(409, 'link_limit_reached'), "You've reached the limit of share links."],
  ['share', problem(422, 'destination_not_allowed'), "This product can't be shared right now."],
  ['share', problem(400, 'validation_failed'), "This product can't be shared right now."],
  ['share', problem(429, 'rate_limited', { retryAfterSeconds: 90 }), 'Too many share links created. Try again in 2 minutes.'],
  ['share', problem(503), 'Sharing is temporarily unavailable. Try again.'],
  ['share', problem(500), 'Sharing is temporarily unavailable. Try again.'],
  ['share', problem(401, 'unauthorized'), SESSION],
  ['share', problem(0), OFFLINE],
  // video
  ['video', problem(404, 'video_not_found'), "This video isn't available."],
  ['video', problem(429, 'rate_limited', { retryAfterSeconds: 4 }), 'Too many requests. Try again in 4 seconds.'],
  ['video', problem(503), 'Video is temporarily unavailable. Try again.'],
  ['video', problem(0), OFFLINE],
];

describe('problem copy catalogue', () => {
  it.each(rows)('W02 AS-73: %s %j -> "%s"', (surface, input, text) => {
    expect(problemCopy(surface, input).text).toBe(text);
  });

  it('W02 AS-73: the comment variants of the target texts', () => {
    expect(problemCopy('vote', problem(404, 'target_not_found'), { target: 'comment' }).text).toBe('That comment is no longer available.');
    expect(problemCopy('vote', problem(403, 'self_vote_not_allowed'), { target: 'comment' }).text).toBe("You can't vote on your own comment.");
    expect(problemCopy('discussions-write', problem(404, 'post_not_found'), { target: 'comment' }).text).toBe('That post is no longer available.');
  });

  it('W02 AS-73: a reference accompanies 5xx and unknown errors when the body had a request id', () => {
    expect(problemCopy('search', problem(500, undefined, { requestId: 'req-9' })).reference).toBe('Reference: req-9');
    expect(problemCopy('pickup', problem(503, undefined, { requestId: 'req-9' })).reference).toBe('Reference: req-9');
    expect(problemCopy('product', problem(418, undefined, { requestId: 'req-9' })).reference).toBe('Reference: req-9');
  });

  it('W02 AS-73: no reference for offline, rate limits, known 4xx codes or a missing request id', () => {
    expect(problemCopy('search', problem(0)).reference).toBeUndefined();
    expect(problemCopy('search', problem(429, 'rate_limited', { requestId: 'r' })).reference).toBeUndefined();
    expect(problemCopy('discussions-write', problem(409, 'board_closed', { requestId: 'r' })).reference).toBeUndefined();
    expect(problemCopy('search', problem(500)).reference).toBeUndefined();
  });

  it('W02 AS-73: wait text rounds like W01 (seconds, minutes up, hours up)', () => {
    expect(problemCopy('product', problem(429, 'rate_limited', { retryAfterSeconds: 1 })).text).toBe('Too many requests. Try again in 1 second.');
    expect(problemCopy('product', problem(429, 'rate_limited', { retryAfterSeconds: 61 })).text).toBe('Too many requests. Try again in 2 minutes.');
    expect(problemCopy('product', problem(429, 'rate_limited', { retryAfterSeconds: 3601 })).text).toBe('Too many requests. Try again in 2 hours.');
  });

  it('W02 AS-73: any 429 gets the wait text even without the stable code', () => {
    expect(problemCopy('search', problem(429, undefined, { retryAfterSeconds: 8 })).text).toBe('Too many searches. Try again in 8 seconds.');
  });

  it('W02 AS-73: unknown 4xx and 5xx fall back by class on every surface', () => {
    const surfaces: Surface[] = ['search', 'pickup-search', 'product', 'pickup', 'discussions-read', 'discussions-write', 'vote', 'ask', 'share', 'video'];
    for (const surface of surfaces) {
      const unknown4xx = problemCopy(surface, problem(418, 'teapot')).text;
      const unknown5xx = problemCopy(surface, problem(599, 'weird')).text;
      expect(unknown4xx.length).toBeGreaterThan(0);
      expect(unknown5xx.length).toBeGreaterThan(0);
      expect(unknown4xx).not.toContain('teapot');
      expect(unknown5xx).not.toContain('weird');
    }
    expect(problemCopy('share', problem(418, 'teapot')).text).toBe("Something didn't work. Check the details and try again.");
    expect(problemCopy('video', problem(599, 'weird')).text).toBe('Video is temporarily unavailable. Try again.');
  });

  it('W02 AS-73: retryable is true for offline, 429 and 5xx, false for content that is gone', () => {
    expect(problemCopy('search', problem(0)).retryable).toBe(true);
    expect(problemCopy('search', problem(503)).retryable).toBe(true);
    expect(problemCopy('search', problem(429, 'rate_limited')).retryable).toBe(true);
    expect(problemCopy('discussions-write', problem(404, 'post_not_found')).retryable).toBe(false);
    expect(problemCopy('discussions-write', problem(409, 'board_closed')).retryable).toBe(false);
    expect(problemCopy('share', problem(409, 'link_limit_reached')).retryable).toBe(false);
  });

  it('W02 AS-73: the server title and detail are never rendered', () => {
    const error = {
      response: {
        status: 500,
        headers: {},
        data: { code: 'internal', title: 'SERVER TITLE', detail: 'SERVER DETAIL select * from users', requestId: 'req-1', message: 'SERVER MESSAGE' },
      },
    };
    for (const surface of ['search', 'pickup', 'discussions-read', 'ask', 'share', 'video', 'product'] as Surface[]) {
      const copy = problemCopy(surface, problemFromError(error));
      expect(JSON.stringify(copy)).not.toMatch(/SERVER|select/);
    }
  });

  it('W02 AS-77: problemFromError keeps only status, code, field errors, Retry-After and requestId', () => {
    const error = {
      response: {
        status: 409,
        headers: { 'retry-after': '12' },
        data: {
          code: 'board_closed',
          title: 'T',
          detail: 'D',
          instance: '/x',
          type: 'urn:x',
          traceId: 'trace',
          requestId: 'req-2',
          errors: [{ field: 'title', code: 'too_short', message: 'M' }],
          secret: 'S',
        },
      },
    };
    const kept = problemFromError(error);
    expect(Object.keys(kept).sort()).toEqual(['code', 'errors', 'requestId', 'retryAfterSeconds', 'status']);
    expect(kept).toEqual({ status: 409, code: 'board_closed', errors: [{ field: 'title', code: 'too_short' }], retryAfterSeconds: 12, requestId: 'req-2' });
  });

  it('W02 AS-77: an error without a response is an offline problem', () => {
    expect(problemFromError(new Error('boom'))).toEqual({ status: 0, errors: [] });
  });
});
