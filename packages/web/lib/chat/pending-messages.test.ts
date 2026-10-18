import type { ChatMessage } from '@marketplace-sandbox/contracts';
import { describe, expect, it } from 'vitest';
import { mergeMessages } from './catch-up';
import { autoRetryIds, canRetry, initialPending, newClientMessageId, pendingReducer, type PendingAction, type PendingState } from './pending-messages';

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'a0000000-0000-4000-8000-000000000002';
const C = 'a0000000-0000-4000-8000-000000000003';
const REPLY = 'e0000000-0000-4000-8000-0000000000aa';
const USER = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';

const run = (...actions: PendingAction[]): PendingState => actions.reduce(pendingReducer, initialPending);
const submit = (clientMessageId: string, body = `text ${clientMessageId.slice(-1)}`, replyToId: string | null = null): PendingAction => ({ type: 'submit', clientMessageId, body, replyToId });

describe('Pending messages (client message id lifecycle)', () => {
  it('W05 AS-14 UC6: a submitted draft is one bubble in the state sending, in the order of sending', () => {
    const state = run(submit(A, 'one'), submit(B, 'two', REPLY));
    expect(state.items).toEqual([
      { clientMessageId: A, body: 'one', replyToId: null, state: 'sending' },
      { clientMessageId: B, body: 'two', replyToId: REPLY, state: 'sending' },
    ]);
  });

  it('W05 AS-15 UC6: submitting the same action twice (a double press) does not make a second bubble', () => {
    expect(run(submit(A), submit(A)).items).toHaveLength(1);
  });

  it('W05 AS-14 UC6: a confirmed send removes its bubble (the message goes to the cache); an unknown id changes nothing', () => {
    const state = run(submit(A), submit(B), { type: 'confirmed', clientMessageId: A });
    expect(state.items.map((i) => i.clientMessageId)).toEqual([B]);
    expect(pendingReducer(state, { type: 'confirmed', clientMessageId: C })).toBe(state);
  });

  it('W05 AS-16 UC6: a send that did not complete is failed(network); Retry re-sends the same clientMessageId, body and reply reference', () => {
    const failed = run(submit(A, 'hello', REPLY), { type: 'failed', clientMessageId: A, failure: 'network' });
    expect(failed.items[0]).toMatchObject({ clientMessageId: A, state: 'failed', failure: 'network' });
    const retried = pendingReducer(failed, { type: 'retry', clientMessageId: A, now: 0 });
    expect(retried.items[0]).toEqual({ clientMessageId: A, body: 'hello', replyToId: REPLY, state: 'sending' });
  });

  it('W05 AS-16 UC6: a bubble leaves failed only by Retry or Discard; retrying a bubble that is sending changes nothing', () => {
    const sending = run(submit(A));
    expect(pendingReducer(sending, { type: 'retry', clientMessageId: A, now: 0 })).toBe(sending);
    expect(pendingReducer(sending, { type: 'failed', clientMessageId: B, failure: 'network' })).toBe(sending);
    const failed = pendingReducer(sending, { type: 'failed', clientMessageId: A, failure: 'network' });
    expect(pendingReducer(failed, { type: 'discard', clientMessageId: A }).items).toEqual([]);
  });

  it('W05 AS-16 UC6: Discard removes only that bubble', () => {
    const state = run(submit(A), submit(B), { type: 'failed', clientMessageId: A, failure: 'network' }, { type: 'discard', clientMessageId: A });
    expect(state.items.map((i) => i.clientMessageId)).toEqual([B]);
  });

  it('W05 AS-16 UC6: later drafts may be sent while one bubble is failed, and keep their order', () => {
    const state = run(submit(A), { type: 'failed', clientMessageId: A, failure: 'network' }, submit(B), submit(C));
    expect(state.items.map((i) => [i.clientMessageId, i.state])).toEqual([[A, 'failed'], [B, 'sending'], [C, 'sending']]);
  });

  it('W05 AS-17 UC6: only network failures are retried automatically, oldest first; refusals never are', () => {
    const state = run(
      submit(A),
      submit(B),
      submit(C),
      { type: 'failed', clientMessageId: C, failure: 'network' },
      { type: 'refused', clientMessageId: B, reason: 'validation_failed' },
      { type: 'failed', clientMessageId: A, failure: 'network' },
    );
    expect(autoRetryIds(state)).toEqual([A, C]);
    const after = [A, C].reduce((s, id) => pendingReducer(s, { type: 'retry', clientMessageId: id, now: 0 }), state);
    expect(after.items.map((i) => [i.clientMessageId, i.state])).toEqual([[A, 'sending'], [B, 'failed'], [C, 'sending']]);
    // a retry that fails again waits for the next reconnection: it is a candidate again only then
    const failedAgain = [A, C].reduce((s, id) => pendingReducer(s, { type: 'failed', clientMessageId: id, failure: 'network' }), after);
    expect(autoRetryIds(failedAgain)).toEqual([A, C]);
    expect(autoRetryIds(initialPending)).toEqual([]);
  });

  it('W05 AS-18 UC6: a refusal keeps the bubble with its reason; a 4xx is not an automatic retry candidate', () => {
    const state = run(submit(A), { type: 'refused', clientMessageId: A, reason: 'channel_archived' });
    expect(state.items[0]).toMatchObject({ state: 'failed', failure: 'refused', reason: 'channel_archived' });
    expect(autoRetryIds(state)).toEqual([]);
  });

  it('W05 AS-19 UC6: a rate-limited bubble cannot be retried before its wait ends, and can after', () => {
    const state = run(submit(A), { type: 'refused', clientMessageId: A, reason: 'rate_limited', retryAfterAt: 10_000 });
    expect(canRetry(state.items[0], 9_999)).toBe(false);
    expect(pendingReducer(state, { type: 'retry', clientMessageId: A, now: 9_999 })).toBe(state);
    expect(canRetry(state.items[0], 10_000)).toBe(true);
    expect(pendingReducer(state, { type: 'retry', clientMessageId: A, now: 10_000 }).items[0]).toMatchObject({ state: 'sending', clientMessageId: A });
  });

  it('W05 AS-18 UC6: reply_target_invalid drops the reference and starts a new action with a new clientMessageId, in the same place', () => {
    const state = run(submit(A, 'first'), submit(B, 'answer', REPLY), { type: 'refused', clientMessageId: B, reason: 'reply_target_invalid' }, submit(C, 'last'));
    const next = pendingReducer(state, { type: 'retryWithoutReply', clientMessageId: B, newClientMessageId: 'a0000000-0000-4000-8000-0000000000ff' });
    expect(next.items.map((i) => i.clientMessageId)).toEqual([A, 'a0000000-0000-4000-8000-0000000000ff', C]);
    expect(next.items[1]).toEqual({ clientMessageId: 'a0000000-0000-4000-8000-0000000000ff', body: 'answer', replyToId: null, state: 'sending' });
    // only a failed bubble can be re-made
    expect(pendingReducer(next, { type: 'retryWithoutReply', clientMessageId: A, newClientMessageId: B })).toBe(next);
  });

  it('W05 AS-40 UC6: clear drops every bubble (the session ended)', () => {
    expect(run(submit(A), submit(B), { type: 'clear' })).toEqual(initialPending);
  });

  it('W05 AS-16 UC6: newClientMessageId makes a UUID per call', () => {
    const ids = new Set(Array.from({ length: 20 }, () => newClientMessageId()));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// --- SC-001: randomised interleavings of lost responses, retries and live deliveries -------------------------------------
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Wire = { clientMessageId: string; outcome: 'ok' | 'lost-response' | 'lost-request' };

/** One simulated world: an idempotent server, the client's held messages, the pending reducer and the requests on the wire. */
function simulate(seed: number) {
  const random = mulberry32(seed);
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
  const serverByClientId = new Map<string, ChatMessage>();
  const serverLog: ChatMessage[] = [];
  let held: ChatMessage[] = [];
  let pending = initialPending;
  const inFlight: Wire[] = [];
  let counter = 0;
  const submitted: string[] = [];
  const bodyOf = new Map<string, string>();

  const serverStore = (clientMessageId: string, body: string): { message: ChatMessage; duplicate: boolean } => {
    const known = serverByClientId.get(clientMessageId);
    if (known) return { message: known, duplicate: true };
    const seq = serverLog.length + 1;
    const message: ChatMessage = { id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, seq, authorId: USER, body, replyToId: null, createdAt: '2026-10-01T10:00:00.000Z', deleted: false };
    serverByClientId.set(clientMessageId, message);
    serverLog.push(message);
    return { message, duplicate: false };
  };

  const dispatch = (action: PendingAction) => (pending = pendingReducer(pending, action));
  const send = (clientMessageId: string) => inFlight.push({ clientMessageId, outcome: pick(['ok', 'ok', 'lost-response', 'lost-request'] as const) });

  const settleOne = () => {
    if (inFlight.length === 0) return;
    const [wire] = inFlight.splice(Math.floor(random() * inFlight.length), 1);
    const item = pending.items.find((i) => i.clientMessageId === wire.clientMessageId);
    if (!item) return;
    if (wire.outcome === 'lost-request') return void dispatch({ type: 'failed', clientMessageId: wire.clientMessageId, failure: 'network' });
    const { message } = serverStore(wire.clientMessageId, item.body);
    if (wire.outcome === 'lost-response') return void dispatch({ type: 'failed', clientMessageId: wire.clientMessageId, failure: 'network' });
    held = mergeMessages(held, [message]); // 201 or 200 duplicate: the stored message goes to the cache, ignoring `duplicate`
    dispatch({ type: 'confirmed', clientMessageId: wire.clientMessageId });
  };

  const step = () => {
    const roll = random();
    if (roll < 0.25 && submitted.length < 12) {
      const id = `a0000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
      const body = `message ${counter}`;
      submitted.push(id);
      bodyOf.set(id, body);
      dispatch(submit(id, body));
      send(id);
    } else if (roll < 0.6) settleOne();
    else if (roll < 0.75) {
      const failed = pending.items.filter((i) => i.state === 'failed');
      if (failed.length) {
        const item = pick(failed);
        dispatch({ type: 'retry', clientMessageId: item.clientMessageId, now: 0 });
        send(item.clientMessageId);
      }
    } else if (roll < 0.85) {
      // reconnection: every network failure is retried once, oldest first
      for (const id of autoRetryIds(pending)) {
        dispatch({ type: 'retry', clientMessageId: id, now: 0 });
        send(id);
      }
    } else {
      // a live delivery (hint or sync): everything the server stored so far, in a random order, possibly twice
      const batch = [...serverLog].sort(() => random() - 0.5);
      held = mergeMessages(held, random() < 0.5 ? batch : [...batch, ...batch]);
    }
    expectInvariants();
  };

  const expectInvariants = () => {
    const ids = held.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(held.map((m) => m.seq)).toEqual([...held.map((m) => m.seq)].sort((a, b) => a - b));
    expect(serverLog.length).toBeLessThanOrEqual(submitted.length);
    expect(new Set(pending.items.map((i) => i.clientMessageId)).size).toBe(pending.items.length);
  };

  const quiesce = () => {
    for (let guard = 0; guard < 500 && (inFlight.length > 0 || pending.items.length > 0); guard++) {
      if (inFlight.length > 0) settleOne();
      else
        for (const item of pending.items) {
          dispatch({ type: 'retry', clientMessageId: item.clientMessageId, now: 0 });
          inFlight.push({ clientMessageId: item.clientMessageId, outcome: random() < 0.5 ? 'ok' : 'lost-response' });
        }
    }
    held = mergeMessages(held, serverLog); // the final sync
    expectInvariants();
  };

  return { step, quiesce, submitted, held: () => held, pending: () => pending, serverLog: () => serverLog, bodyOf };
}

describe('Pending messages: randomised interleavings (SC-001)', () => {
  it('W05 AS-16 UC6: across 1,000 random interleavings of lost requests, lost responses, retries, reconnections and live deliveries, every message is stored and shown exactly once, in order', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const world = simulate(seed);
      for (let i = 0; i < 60; i++) world.step();
      world.quiesce();
      const bodies = world.held().map((m) => m.body);
      expect(world.pending().items, `seed ${seed}`).toEqual([]);
      expect(bodies, `seed ${seed}`).toHaveLength(world.submitted.length);
      expect(new Set(bodies).size, `seed ${seed}`).toBe(bodies.length);
      expect(world.serverLog(), `seed ${seed}`).toHaveLength(world.submitted.length);
      expect(new Set(world.held().map((m) => m.id)).size, `seed ${seed}`).toBe(world.held().length);
    }
  });

  it('W05 AS-16 UC6: a duplicate answer for a message the sync already delivered adds nothing and removes the bubble', () => {
    const message: ChatMessage = { id: '00000000-0000-4000-8000-000000000001', seq: 1, authorId: USER, body: 'x', replyToId: null, createdAt: '2026-10-01T10:00:00.000Z', deleted: false };
    const held = mergeMessages([], [message]); // delivered by a hint before the response
    const afterDuplicate = mergeMessages(held, [message]); // the retry answered 200 duplicate:true
    expect(afterDuplicate).toHaveLength(1);
    expect(run(submit(A), { type: 'failed', clientMessageId: A, failure: 'network' }, { type: 'retry', clientMessageId: A, now: 0 }, { type: 'confirmed', clientMessageId: A }).items).toEqual([]);
  });
});
