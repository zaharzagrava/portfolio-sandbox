import { describe, expect, it } from 'vitest';
import { idempotencyKeyFor, initialReply, replyReducer, type ReplyAction, type ReplyState } from './reply-reducer';

const run = (...actions: ReplyAction[]): ReplyState => actions.reduce(replyReducer, initialReply);
const send = (question = 'hi', idempotencyKey = 'key-1'): ReplyAction => ({ type: 'send', question, idempotencyKey });
const meta = (messageId = 'm1', eventId = '1-0'): ReplyAction => ({ type: 'meta', messageId, eventId });
const text = (t: string, eventId?: string): ReplyAction => ({ type: 'text', t, eventId });
const done: ReplyAction = { type: 'done', allowance: { used: 3, limit: 10 } };

describe('Reply phase reducer', () => {
  it('W05 AS-42 UA4: idle → sending → streaming → ended(done), text appended in arrival order, chips kept', () => {
    const sending = run(send('find a lamp', 'k'));
    expect(sending).toMatchObject({ phase: 'sending', question: 'find a lamp', idempotencyKey: 'k', text: '', tools: [] });
    const streaming = [meta(), text('Hel', '2-0'), text('lo', '3-0')].reduce(replyReducer, sending);
    expect(streaming).toMatchObject({ phase: 'streaming', messageId: 'm1', text: 'Hello', lastEventId: '3-0' });
    const ended = replyReducer(streaming, done);
    expect(ended).toMatchObject({ phase: 'ended', outcome: 'done', text: 'Hello', allowance: { used: 3, limit: 10 } });
  });

  it('W05 AS-42 UA4: the reducer never re-splits or re-orders text: what arrives is appended as it is', () => {
    const state = run(send(), meta(), text('b', '2-0'), text('a', '3-0'), text('  ', '4-0'), text('\n', '5-0'));
    expect(state.text).toBe('ba  \n');
  });

  it('W05 AS-42 UA4: a text event after the terminal event is ignored (the first terminal event is final)', () => {
    const ended = run(send(), meta(), text('Hi', '2-0'), done);
    expect(replyReducer(ended, text('late', '9-0'))).toBe(ended);
    expect(replyReducer(ended, { type: 'error', code: 'INTERNAL' })).toBe(ended);
    expect(replyReducer(ended, { type: 'refusal', category: 'x', source: 'provider' })).toBe(ended);
    expect(replyReducer(ended, { type: 'connectionLost' })).toBe(ended);
    expect(replyReducer(ended, { type: 'stopRequested' })).toBe(ended);
    expect(replyReducer(ended, meta('m2'))).toBe(ended);
  });

  it('W05 AS-43 UA4: a tool event upserts one chip by id; a tool that runs twice has two chips; order of first appearance is kept', () => {
    const state = run(
      send(),
      meta(),
      { type: 'tool', id: 't1', name: 'search_products', status: 'running' },
      { type: 'tool', id: 't2', name: 'search_products', status: 'running' },
      { type: 'tool', id: 't1', name: 'search_products', status: 'done' },
      { type: 'tool', id: 't2', name: 'search_products', status: 'failed' },
    );
    expect(state.tools).toEqual([
      { id: 't1', name: 'search_products', status: 'done' },
      { id: 't2', name: 'search_products', status: 'failed' },
    ]);
  });

  it('W05 AS-50 UA4: a second meta (a replay after a reload) rebuilds the reply from scratch, never doubles it', () => {
    const state = run(send(), meta('m1', '1-0'), text('Hel', '2-0'), { type: 'tool', id: 't1', name: 'x', status: 'running' }, { type: 'connectionLost' }, meta('m1', '1-0'), text('Hel', '2-0'));
    expect(state).toMatchObject({ phase: 'streaming', text: 'Hel', tools: [], lastEventId: '2-0', messageId: 'm1' });
  });

  it('W05 AS-49 UA4: a lost connection while streaming shows reconnecting and keeps the text; the next event continues from it', () => {
    const lost = run(send(), meta(), text('Hel', '2-0'), { type: 'connectionLost' });
    expect(lost).toMatchObject({ phase: 'reconnecting', text: 'Hel', lastEventId: '2-0', messageId: 'm1' });
    expect(replyReducer(lost, text('lo', '3-0'))).toMatchObject({ phase: 'streaming', text: 'Hello' });
    expect(replyReducer(lost, { type: 'resumed' })).toMatchObject({ phase: 'streaming', text: 'Hel' });
  });

  it('W05 AS-49 UA4: an event whose id does not increase is ignored (a repeat of the resume cursor or an older one)', () => {
    const state = run(send(), meta(), text('a', '10-0'), text('b', '10-0'), text('c', '9-5'), text('d', '10-1'), text('e'));
    expect(state.text).toBe('ade');
    expect(state.lastEventId).toBe('10-1');
  });

  it('W05 AS-49 UA4: a connection lost before the reply had an identity is a lost reply (nothing to resume)', () => {
    expect(run(send(), { type: 'connectionLost' })).toMatchObject({ phase: 'ended', outcome: 'lost', lostReason: 'interrupted' });
  });

  it('W05 AS-49 UA4: giving up after the resume window ends the reply as lost, keeping the text', () => {
    const state = run(send(), meta(), text('Hel', '2-0'), { type: 'connectionLost' }, { type: 'lost', reason: 'unreachable' });
    expect(state).toMatchObject({ phase: 'ended', outcome: 'lost', lostReason: 'unreachable', text: 'Hel' });
  });

  it('W05 AS-52 UA4: stop moves streaming or reconnecting to stopping; only the terminal CANCELLED ends it as stopped, partial text kept', () => {
    const stopping = run(send(), meta(), text('Hel', '2-0'), { type: 'stopRequested' });
    expect(stopping).toMatchObject({ phase: 'stopping', text: 'Hel' });
    expect(replyReducer(stopping, { type: 'stopRequested' })).toBe(stopping);
    expect(replyReducer(stopping, text('lo', '3-0'))).toMatchObject({ phase: 'stopping', text: 'Hello' });
    expect(replyReducer(stopping, { type: 'error', code: 'CANCELLED' })).toMatchObject({ phase: 'ended', outcome: 'stopped', text: 'Hel' });
    expect(run(send(), meta(), { type: 'connectionLost' }, { type: 'stopRequested' }).phase).toBe('stopping');
  });

  it('W05 AS-52 UA4: stop cannot be requested from idle, sending, or ended (impossible combinations cannot be represented)', () => {
    expect(replyReducer(initialReply, { type: 'stopRequested' })).toBe(initialReply);
    const sending = run(send());
    expect(replyReducer(sending, { type: 'stopRequested' })).toBe(sending);
    const ended = run(send(), meta(), done);
    expect(replyReducer(ended, { type: 'stopRequested' })).toBe(ended);
  });

  it('W05 AS-52 UA4: the 5 s local abort after Stop ends the reply as stopped', () => {
    expect(run(send(), meta(), text('x', '2-0'), { type: 'stopRequested' }, { type: 'localStop' })).toMatchObject({ phase: 'ended', outcome: 'stopped', text: 'x' });
    const streaming = run(send(), meta());
    expect(replyReducer(streaming, { type: 'localStop' })).toBe(streaming);
  });

  it('W05 AS-52 UA4: a reply that turns out finished (409 on cancel) takes its text from the history and ends as done', () => {
    const state = run(send(), meta(), text('Hel', '2-0'), { type: 'stopRequested' }, { type: 'fromHistory', text: 'Hello there' });
    expect(state).toMatchObject({ phase: 'ended', outcome: 'done', text: 'Hello there' });
  });

  it('W05 AS-51 UA4: a reply that cannot be resumed and is not in the history ends as lost (interrupted)', () => {
    expect(run(send(), meta(), { type: 'connectionLost' }, { type: 'lost', reason: 'interrupted' })).toMatchObject({ phase: 'ended', outcome: 'lost', lostReason: 'interrupted' });
  });

  it('W05 AS-57 UA4: a terminal error keeps the partial text and the code; retryAfterMs is kept for the wait', () => {
    const state = run(send(), meta(), text('Part', '2-0'), { type: 'error', code: 'PROVIDER_UNAVAILABLE', retryAfterMs: 4000 });
    expect(state).toMatchObject({ phase: 'ended', outcome: 'error', text: 'Part', errorCode: 'PROVIDER_UNAVAILABLE', retryAfterMs: 4000 });
  });

  it('W05 AS-57 UA4: CANCELLED from the server (for lack of viewers, or a stop) ends as stopped, not as an error', () => {
    expect(run(send(), meta(), { type: 'error', code: 'CANCELLED' })).toMatchObject({ outcome: 'stopped' });
  });

  it('W05 AS-58 UA4: a refusal replaces the streamed text, keeps the question and records only the source', () => {
    const state = run(send('bad question'), meta(), text('some words', '2-0'), { type: 'refusal', category: 'self_harm', source: 'moderation' });
    expect(state).toMatchObject({ phase: 'ended', outcome: 'refused', text: '', question: 'bad question', refusalSource: 'moderation' });
    expect(JSON.stringify(state)).not.toContain('self_harm');
  });

  it('W05 AS-57 UA4: an error or a refusal before the reply had an identity (sending) also ends it', () => {
    expect(run(send(), { type: 'error', code: 'INTERNAL' })).toMatchObject({ outcome: 'error' });
    expect(run(send(), { type: 'refusal', category: 'x', source: 'provider' })).toMatchObject({ outcome: 'refused' });
  });

  it('W05 AS-42 UA4: text and tool events before meta are ignored (the reply has no identity yet)', () => {
    const sending = run(send());
    expect(replyReducer(sending, text('x', '1-0'))).toBe(sending);
    expect(replyReducer(sending, { type: 'tool', id: 't', name: 'n', status: 'running' })).toBe(sending);
  });

  it('W05 AS-45 UA4: a send is accepted only from idle or ended; while a reply runs it changes nothing', () => {
    const streaming = run(send(), meta());
    expect(replyReducer(streaming, send('again', 'k2'))).toBe(streaming);
    const ended = run(send(), meta(), done);
    const again = replyReducer(ended, send('again', 'k2'));
    expect(again).toMatchObject({ phase: 'sending', question: 'again', idempotencyKey: 'k2', text: '', tools: [] });
    expect(again.messageId).toBeUndefined();
    expect(again.outcome).toBeUndefined();
  });

  it('W05 AS-50 UA4: attach (a reload mid-answer) starts reconnecting on the remembered reply, and its replayed meta rebuilds it', () => {
    const attached = replyReducer(initialReply, { type: 'attach', messageId: 'm7', question: 'what is this', idempotencyKey: 'k7' });
    expect(attached).toMatchObject({ phase: 'reconnecting', messageId: 'm7', question: 'what is this', idempotencyKey: 'k7' });
    expect(replyReducer(attached, meta('m7', '1-0'))).toMatchObject({ phase: 'streaming', text: '' });
    const lost = run(send(), meta('m7'), { type: 'connectionLost' }, { type: 'lost', reason: 'unreachable' });
    expect(replyReducer(lost, { type: 'attach', messageId: 'm7', question: 'hi', idempotencyKey: 'key-1' }).phase).toBe('reconnecting');
    const streaming = run(send(), meta());
    expect(replyReducer(streaming, { type: 'attach', messageId: 'm9', question: 'x', idempotencyKey: 'y' })).toBe(streaming);
  });

  it('W05 AS-54 UA4: an in-flight conflict attaches to the reply named by the server, with no second bubble', () => {
    const state = run(send('hi', 'k'), { type: 'attachInFlight', messageId: 'm9' });
    expect(state).toMatchObject({ phase: 'reconnecting', messageId: 'm9', question: 'hi', idempotencyKey: 'k' });
  });

  it('W05 AS-42 UA4: reset goes back to idle from any phase', () => {
    expect(run(send(), meta(), text('x', '2-0'), { type: 'reset' })).toEqual(initialReply);
  });

  it('W05 AS-45 UA4: one Idempotency-Key per user action: reused for the same unsent text, new for new text, new after a key reuse refusal', () => {
    let n = 0;
    const make = () => `key-${++n}`;
    const first = idempotencyKeyFor(undefined, 'hello', make);
    expect(first).toBe('key-1');
    expect(idempotencyKeyFor({ text: 'hello', key: first }, 'hello', make)).toBe('key-1');
    expect(idempotencyKeyFor({ text: 'hello', key: first }, ' hello ', make)).toBe('key-1');
    expect(idempotencyKeyFor({ text: 'hello', key: first }, 'hello!', make)).toBe('key-2');
    expect(idempotencyKeyFor({ text: 'hello', key: first, refused: true }, 'hello', make)).toBe('key-3');
  });
});
