import { describe, expect, it } from 'vitest';
import type { ChatProblem } from '@/lib/api/chat';
import { deleteCopy, loadCopy, resolveCopy, sendCopy, sendFailureKind, UNAVAILABLE_CHAT_TEXT } from './errors-copy';

const problem = (status: number, code?: string, extra: Partial<ChatProblem> = {}): ChatProblem => ({ status, ...(code ? { code } : {}), errors: [], ...extra });

describe('Chat error copy', () => {
  it('W05 AS-05 SC-007 UC1: every code of the resolving refusals has its own sentence and way out, chosen by code', () => {
    const table: [string, ChatProblem, string, string][] = [
      ['400 validation_failed', problem(400, 'validation_failed'), "This product link isn't valid.", 'browse-products'],
      ['404 product_not_found', problem(404, 'product_not_found'), "This product link isn't valid.", 'browse-products'],
      ['409 channel_archived', problem(409, 'channel_archived'), "This chat was archived and isn't accepting new members.", 'back-to-product'],
      ['403 banned', problem(403, 'banned'), "You can't join this chat.", 'none'],
      ['403 permission_denied', problem(403, 'permission_denied'), "Only staff of this product's shop can open its chat.", 'none'],
      ['500', problem(500), "We couldn't open this chat.", 'try-again'],
      ['503', problem(503, 'unavailable'), "We couldn't open this chat.", 'try-again'],
      ['network (status 0)', problem(0), "We couldn't open this chat.", 'try-again'],
    ];
    for (const [name, input, text, action] of table) expect(resolveCopy(input), name).toMatchObject({ text, action });
  });

  it('W05 AS-05 UC1: a rate limit shows the wait in W01 words and offers Try again with the wait, or "later" without a header', () => {
    expect(resolveCopy(problem(429, 'rate_limited', { retryAfterSeconds: 17 }))).toEqual({ text: 'Too many requests. Try again in 17 seconds.', action: 'try-again', retryAfterSeconds: 17 });
    expect(resolveCopy(problem(429, 'rate_limited', { retryAfterSeconds: 120 })).text).toBe('Too many requests. Try again in 2 minutes.');
    expect(resolveCopy(problem(429, 'rate_limited')).text).toBe('Too many requests. Try again in a moment.');
  });

  it('W05 AS-05 FR-062 UC1: a server failure carries the reference; an unknown 4xx falls back by status class; nothing technical is shown', () => {
    expect(resolveCopy(problem(500, undefined, { requestId: 'req-9' }))).toMatchObject({ text: "We couldn't open this chat.", reference: 'Reference: req-9' });
    expect(resolveCopy(problem(418, 'teapot')).text).toBe("Something didn't work. Check the details and try again.");
    expect(resolveCopy(problem(418, 'teapot')).reference).toBeUndefined();
  });

  it('W05 AS-18 SC-007 UC5: every refusal on send has its own sentence and effect, chosen by code (never the server detail)', () => {
    const table: [string, ChatProblem, string, string][] = [
      ['403 banned', problem(403, 'banned'), 'You can no longer take part in this chat.', 'banned'],
      ['409 channel_archived', problem(409, 'channel_archived'), 'This chat was archived. You can read it, but not reply.', 'archived'],
      ['404 channel_not_found', problem(404, 'channel_not_found'), UNAVAILABLE_CHAT_TEXT, 'unavailable'],
      ['403 other', problem(403, 'forbidden'), UNAVAILABLE_CHAT_TEXT, 'unavailable'],
      ['422 reply_target_invalid', problem(422, 'reply_target_invalid'), 'The message you replied to is no longer available.', 'reply-target'],
      ['400 validation_failed', problem(400, 'validation_failed'), "That message can't be sent.", 'refused'],
      ['422 idempotency_key_reuse', problem(422, 'idempotency_key_reuse'), 'Something went wrong. Try again.', 'refused'],
      ['418 unknown 4xx', problem(418, 'teapot'), "Something didn't work. Check the details and try again.", 'refused'],
      ['500', problem(500), 'Something went wrong. Try again.', 'transient'],
      ['network', problem(0), 'Something went wrong. Try again.', 'transient'],
    ];
    for (const [name, input, text, effect] of table) expect(sendCopy(input), name).toMatchObject({ text, effect });
  });

  it('W05 AS-18 UC5: a mute says until when, in the viewer\'s local time, and keeps the instant for the timer', () => {
    const until = '2026-10-17T12:30:00.000Z';
    const copy = sendCopy(problem(403, 'muted', { mutedUntil: until }));
    expect(copy.effect).toBe('muted');
    expect(copy.mutedUntil).toBe(until);
    expect(copy.text).toBe(`You're muted until ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`);
    expect(sendCopy(problem(403, 'muted'))).toMatchObject({ text: "You're muted.", effect: 'muted' });
  });

  it('W05 AS-19 UC5: a rate limit on send gives the wait sentence and keeps the seconds for the timer', () => {
    expect(sendCopy(problem(429, 'rate_limited', { retryAfterSeconds: 12 }))).toMatchObject({
      text: "You're sending messages too fast. Try again in 12 seconds.",
      effect: 'wait',
      retryAfterSeconds: 12,
    });
    expect(sendCopy(problem(429, 'rate_limited')).text).toBe("You're sending messages too fast. Try again in a moment.");
  });

  it('W05 AS-16 UC5: a server failure on send carries the reference', () => {
    expect(sendCopy(problem(502, undefined, { requestId: 'req-3' }))).toMatchObject({ effect: 'transient', reference: 'Reference: req-3' });
  });

  it('W05 AS-17 UC6: a failure is a network failure (retried automatically) when nothing answered or the server failed; a 4xx is a refusal', () => {
    expect(sendFailureKind(problem(0))).toBe('network');
    expect(sendFailureKind(problem(500))).toBe('network');
    expect(sendFailureKind(problem(503))).toBe('network');
    expect(sendFailureKind(problem(400, 'validation_failed'))).toBe('refused');
    expect(sendFailureKind(problem(403, 'banned'))).toBe('refused');
    expect(sendFailureKind(problem(429, 'rate_limited'))).toBe('refused');
  });

  it('W05 AS-20 UC7: deleting a message: 403 is a toast, 404 and 204 are success, anything else is the generic failure', () => {
    expect(deleteCopy(problem(403, 'permission_denied'))).toEqual({ text: "You can't delete this message.", effect: 'toast' });
    expect(deleteCopy(problem(404, 'message_not_found'))).toEqual({ text: '', effect: 'done' });
    expect(deleteCopy(problem(500))).toMatchObject({ text: 'Something went wrong. Try again.', effect: 'toast' });
    expect(deleteCopy(problem(0))).toMatchObject({ effect: 'toast' });
  });

  it('W05 AS-12 AS-40 UC4: a failed read of a chat is "unavailable" for 403/404 and "couldn\'t load" otherwise', () => {
    expect(loadCopy(problem(404, 'channel_not_found'))).toEqual({ text: UNAVAILABLE_CHAT_TEXT, effect: 'unavailable' });
    expect(loadCopy(problem(403, 'banned'))).toEqual({ text: UNAVAILABLE_CHAT_TEXT, effect: 'unavailable' });
    expect(loadCopy(problem(500, undefined, { requestId: 'r1' }))).toEqual({ text: "We couldn't load this chat.", effect: 'retry', reference: 'Reference: r1' });
    expect(loadCopy(problem(0))).toEqual({ text: "We couldn't load this chat.", effect: 'retry' });
    expect(UNAVAILABLE_CHAT_TEXT).toBe("This chat isn't available.");
  });
});
