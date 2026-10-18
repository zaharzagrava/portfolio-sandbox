import { describe, expect, it } from 'vitest';
import type { AssistantProblem } from '@/lib/api/assistant';
import { allowanceView, refusalCopy, replyEndCopy, sendProblemCopy } from './problem-copy';

const problem = (status: number, code?: string, extra: Partial<AssistantProblem> = {}): AssistantProblem => ({ status, ...(code ? { code } : {}), errors: [], ...extra });

describe('Assistant problem copy', () => {
  it('W05 AS-56 SC-007 UA6: every code listed in AS-56 has its own sentence, chosen by code', () => {
    const table: [string, AssistantProblem, string][] = [
      ['validation_failed', problem(400, 'validation_failed'), "That message can't be sent. Messages can be up to 4,000 characters."],
      ['input_rejected sensitive_data', problem(422, 'input_rejected', { category: 'sensitive_data' }), 'Your message looks like it contains a card number or a password. Remove it and try again.'],
      ['input_rejected other', problem(422, 'input_rejected', { category: 'violence' }), "I can't help with that request."],
      ['input_rejected no category', problem(422, 'input_rejected'), "I can't help with that request."],
      ['turn_in_progress', problem(409, 'turn_in_progress'), 'The assistant is still answering. Wait for it to finish.'],
      ['conversation_full', problem(409, 'conversation_full'), 'This chat is full. Start a new chat to continue.'],
      ['not_found', problem(404, 'not_found'), 'This chat no longer exists.'],
      ['too_many_active_turns', problem(429, 'too_many_active_turns'), 'The assistant is already answering in other chats. Wait for one to finish.'],
      ['idempotency_key_required', problem(422, 'idempotency_key_required'), 'Something went wrong. Try again.'],
    ];
    for (const [name, input, text] of table) expect(sendProblemCopy(input).text, name).toBe(text);
  });

  it('W05 AS-56 UA6: the codes that wait say how long, in W01 words, and "a moment" when the server gave none', () => {
    expect(sendProblemCopy(problem(429, 'rate_limited', { retryAfterSeconds: 30 }))).toMatchObject({ text: "You're sending messages too fast. Try again in 30 seconds.", waitSeconds: 30 });
    expect(sendProblemCopy(problem(429, 'rate_limited')).text).toBe("You're sending messages too fast. Try again in a moment.");
    expect(sendProblemCopy(problem(503, 'assistant_busy', { retryAfterSeconds: 90 })).text).toBe('The assistant is busy right now. Try again in 2 minutes.');
    expect(sendProblemCopy(problem(503, 'assistant_unavailable', { retryAfterSeconds: 7200 })).text).toBe('The assistant is unavailable right now. Try again in 2 hours.');
    expect(sendProblemCopy(problem(503, 'assistant_unavailable')).text).toBe('The assistant is unavailable right now. Try again in a moment.');
    expect(sendProblemCopy(problem(429, 'rate_limited', { retryAfterSeconds: 0.2 })).text).toBe("You're sending messages too fast. Try again in 1 second.");
  });

  it('W05 AS-56 UA6: the effect tells the interface what else to do: keep the text, offer New chat, reset the conversation, disable Send for the wait', () => {
    expect(sendProblemCopy(problem(409, 'conversation_full'))).toMatchObject({ effect: 'new-chat', keepText: true });
    expect(sendProblemCopy(problem(404, 'not_found'))).toMatchObject({ effect: 'reset-conversation', keepText: true });
    expect(sendProblemCopy(problem(429, 'rate_limited', { retryAfterSeconds: 5 }))).toMatchObject({ effect: 'wait', waitSeconds: 5, keepText: true });
    expect(sendProblemCopy(problem(503, 'assistant_busy', { retryAfterSeconds: 5 }))).toMatchObject({ effect: 'wait', waitSeconds: 5 });
    expect(sendProblemCopy(problem(400, 'validation_failed'))).toMatchObject({ effect: 'none', keepText: true });
  });

  it('W05 AS-59 UA6: quota_exceeded says when the allowance resets (local date) and disables the composer until then', () => {
    const resetsAt = '2026-11-01T00:00:00.000Z';
    const copy = sendProblemCopy(problem(429, 'quota_exceeded', { used: 5, limit: 5, resetsAt }));
    const date = new Date(resetsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    expect(copy).toMatchObject({ text: `You've used your monthly assistant allowance. It resets on ${date}.`, effect: 'quota', resetsAt, keepText: true });
    expect(sendProblemCopy(problem(429, 'quota_exceeded')).text).toBe("You've used your monthly assistant allowance. It resets soon.");
  });

  it('W05 AS-54 UA6: idempotency_in_flight attaches to the named reply and idempotency_key_reuse starts again with a new key; neither shows text', () => {
    expect(sendProblemCopy(problem(409, 'idempotency_in_flight', { messageId: 'm9' }))).toMatchObject({ effect: 'attach', messageId: 'm9', text: '' });
    expect(sendProblemCopy(problem(422, 'idempotency_key_reuse'))).toMatchObject({ effect: 'new-key', text: '' });
    expect(sendProblemCopy(problem(409, 'idempotency_in_flight')).effect).toBe('none');
  });

  it('W05 AS-60 UA6: a 401 is W01\'s session-ended flow, with no retry and no text of its own', () => {
    expect(sendProblemCopy(problem(401, 'unauthenticated'))).toMatchObject({ effect: 'session-ended', text: '' });
    expect(sendProblemCopy(problem(401))).toMatchObject({ effect: 'session-ended' });
  });

  it('W05 AS-56 FR-062 UA6: unknown codes fall back by status class; 5xx, network and unparsable add the reference; the unexpected-error copy covers invalid_response', () => {
    expect(sendProblemCopy(problem(418, 'teapot')).text).toBe("Something didn't work. Check the details and try again.");
    expect(sendProblemCopy(problem(500, undefined, { requestId: 'req-1' }))).toMatchObject({ text: 'Something went wrong. Try again.', reference: 'Reference: req-1' });
    expect(sendProblemCopy(problem(0))).toMatchObject({ text: 'Something went wrong. Try again.' });
    expect(sendProblemCopy(problem(0)).reference).toBeUndefined();
    expect(sendProblemCopy(problem(500, 'invalid_response')).text).toBe('Something went wrong. Try again.');
  });

  it('W05 AS-57 SC-007 UA6: every terminal error code ends the reply with its own sentence; Try again puts the question back', () => {
    const table: [string, number | undefined, string][] = [
      ['CANCELLED', undefined, "Stopped. This reply wasn't saved."],
      ['GENERATION_LOST', undefined, 'The reply was interrupted. Ask again to retry.'],
      ['PROVIDER_UNAVAILABLE', undefined, 'The assistant is busy right now. Try again in a moment.'],
      ['PROVIDER_UNAVAILABLE', 4000, 'The assistant is busy right now. Try again in 4 seconds.'],
      ['PROVIDER_UNAVAILABLE', 90_000, 'The assistant is busy right now. Try again in 2 minutes.'],
      ['TURN_TIMEOUT', undefined, 'That took too long to answer. Try a shorter or simpler question.'],
      ['MODERATION_UNAVAILABLE', undefined, "The assistant can't check this reply right now. Try again in a moment."],
      ['INTERNAL', undefined, 'The assistant ran into a problem. Try again.'],
      ['SHUTTING_DOWN', undefined, 'The assistant ran into a problem. Try again.'],
      ['TOOL_LOOP_LIMIT', undefined, 'The assistant ran into a problem. Try again.'],
      ['SOMETHING_NEW', undefined, 'The assistant ran into a problem. Try again.'],
    ];
    for (const [code, retryAfterMs, text] of table) expect(replyEndCopy({ outcome: code === 'CANCELLED' ? 'stopped' : 'error', errorCode: code, retryAfterMs }), `${code} ${retryAfterMs}`).toMatchObject({ text, tryAgain: true });
  });

  it('W05 AS-52 AS-51 UA6: stopped and lost outcomes have their own notes; a lost reply has two reasons', () => {
    expect(replyEndCopy({ outcome: 'stopped' })).toMatchObject({ text: "Stopped. This reply wasn't saved.", tryAgain: true });
    expect(replyEndCopy({ outcome: 'lost', lostReason: 'interrupted' })).toMatchObject({ text: 'The reply was interrupted. Ask again to retry.', tryAgain: true });
    expect(replyEndCopy({ outcome: 'lost', lostReason: 'unreachable' })).toMatchObject({ text: "We couldn't reconnect to the reply.", tryAgain: true, reattach: true });
    expect(replyEndCopy({ outcome: 'lost', lostReason: 'interrupted' }).reattach).toBeFalsy();
  });

  it('W05 AS-57 UA6: no provider, model or stack text can come out of the copy, whatever the code', () => {
    const everything = ['CANCELLED', 'GENERATION_LOST', 'PROVIDER_UNAVAILABLE', 'TURN_TIMEOUT', 'MODERATION_UNAVAILABLE', 'INTERNAL', 'x']
      .map((errorCode) => replyEndCopy({ outcome: 'error', errorCode }).text)
      .join(' ');
    expect(everything).not.toMatch(/anthropic|openai|claude|gpt|stack|exception|\bat \w+\.\w+\(/i);
  });

  it('W05 AS-58 UA6: a refusal shows one fixed notice and "not saved", and no category', () => {
    expect(refusalCopy()).toEqual({ text: "I can't help with that.", note: "This exchange wasn't saved." });
  });

  it('W05 AS-47 UA6: the allowance is a floored percentage capped at 100, nothing when the limit is 0 or unknown', () => {
    const resetsAt = '2026-11-01T00:00:00.000Z';
    expect(allowanceView({ used: 0, limit: 1000, resetsAt })).toMatchObject({ percent: 0, label: '0% of your monthly allowance used', usedUp: false });
    expect(allowanceView({ used: 999, limit: 1000, resetsAt })).toMatchObject({ percent: 99, usedUp: false });
    expect(allowanceView({ used: 1, limit: 3, resetsAt })).toMatchObject({ percent: 33 });
    expect(allowanceView({ used: 1500, limit: 1000, resetsAt })).toMatchObject({ percent: 100, usedUp: true });
    expect(allowanceView({ used: 5, limit: 0, resetsAt })).toBeNull();
    expect(allowanceView(undefined)).toBeNull();
  });

  it('W05 AS-47 AS-59 UA6: at 100% the line says it is used up and when it resets', () => {
    const resetsAt = '2026-11-01T00:00:00.000Z';
    const date = new Date(resetsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    expect(allowanceView({ used: 1000, limit: 1000, resetsAt })).toMatchObject({ percent: 100, usedUp: true, label: `Monthly allowance used up. Resets ${date}.`, resetsAt });
  });
});
