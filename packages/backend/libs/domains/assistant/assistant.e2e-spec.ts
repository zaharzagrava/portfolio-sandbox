import { types } from 'cassandra-driver';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { waitFor } from '@app/test/utils/async-helpers';
import { openSse, readSse, type SseEvent } from '@app/test/utils/sse-client';
import { compareStreamIds } from './domain/stream-id';
import {
  bootAssistant,
  data,
  TERMINAL,
  textOf,
  type Harness,
  type TestUser,
} from './testing/assistant.harness';

describe('Shopping assistant: resumable streams, cancel, abort, shutdown', () => {
  let h: Harness;
  let secondApp: Harness | undefined;

  beforeAll(async () => {
    h = await bootAssistant();
  });
  afterAll(async () => {
    await h.close();
    await secondApp?.close();
  });
  beforeEach(async () => {
    await h.reset();
    // A generation outlives its first viewer in most of these specs; the abort specs set their own grace.
    h.config.set('assistant_detach_grace_ms', 60_000);
  });

  const streamUrl = (g: string) =>
    `${h.baseUrl}/assistant/messages/${g}/stream`;
  const resume = (
    u: TestUser,
    g: string,
    lastId?: string,
    opts: { count?: number; timeoutMs?: number } = {},
  ) =>
    readSse(streamUrl(g), {
      headers: { ...u.auth, ...(lastId && { 'Last-Event-ID': lastId }) },
      count: opts.count ?? 1_000,
      until: TERMINAL,
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
  const attach = (u: TestUser, g: string, lastId?: string) =>
    openSse(streamUrl(g), {
      headers: { ...u.auth, ...(lastId && { 'Last-Event-ID': lastId }) },
    });
  const state = async (u: TestUser, g: string) =>
    (await h.generations.meta(u.id, g))?.state;
  const terminalEvents = async (u: TestUser, g: string) =>
    ((await h.generations.read(u.id, g, undefined, 10_000)) ?? []).filter((e) =>
      TERMINAL.includes(e.event.type),
    );
  const cancel = (u: TestUser, g: string) =>
    h.http().post(`/api/assistant/messages/${g}/cancel`).set(u.auth);
  const messageIdOf = (events: SseEvent[]) =>
    data(events[0]).messageId as string;

  it('S46 AS-22: reconnect with Last-Event-ID resumes exactly once, in order', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    const text = Array.from({ length: 30 }, (_, i) => `w${i} `).join('');
    h.llm.script({ text, chunks: 30, delayMs: 60 });

    // read meta + the first 12 text events, then the connection drops
    const first = await h.ask(u, c, { text: 'go' }, { count: 13 });
    const g = messageIdOf(first.events);
    const lastId = first.events.at(-1)!.id!;
    const rest = await resume(u, g, lastId);

    expect(rest.events.at(-1)!.event).toBe('done');
    expect(rest.events[0].event).toBe('text');
    expect(compareStreamIds(rest.events[0].id!, lastId)).toBeGreaterThan(0);
    const all = [...first.events, ...rest.events];
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect(textOf(all)).toBe(text);
    for (let i = 1; i < all.length; i++)
      expect(compareStreamIds(all[i - 1].id!, all[i].id!)).toBeLessThan(0);
  });

  it('S46 AS-22: 50 randomized resumes against a generator at full speed lose and repeat nothing', async () => {
    const text = Array.from({ length: 600 }, (_, i) => `[${i}]`).join('');
    // Rounds of 5 trials side by side: every trial has its own user and conversation, and the scripted turns are
    // identical, so it does not matter which trial takes which queued turn.
    const runTrial = async (trial: number) => {
      const u = await h.user();
      const c = await h.conversation(u);
      // the 40 ms coalescing leaves some twenty events; the first read takes a random few of them
      const take = 2 + Math.floor(Math.random() * 8);
      const first = await h.ask(u, c, { text: 'go' }, { count: take });
      const rest = await resume(
        u,
        messageIdOf(first.events),
        first.events.at(-1)!.id!,
      );
      const all = [...first.events, ...rest.events];
      expect([trial, rest.status, rest.body]).toEqual([trial, 200, undefined]);
      expect(rest.events.at(-1)!.event).toBe('done');
      expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
      expect(textOf(all)).toBe(text);
    };
    for (let from = 0; from < 50; from += 5) {
      for (let i = 0; i < 5; i++)
        h.llm.script({ text, chunks: 600, delayMs: 1 });
      await Promise.all(
        Array.from({ length: 5 }, (_, i) => runTrial(from + i)),
      );
    }
  }, 170_000);

  it('S46 AS-23: replays the whole generation without Last-Event-ID; the terminal id returns an empty stream', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.llm.script({ text: 'one two three', chunks: 3 });
    const original = await h.ask(u, c, { text: 'go' });
    const g = messageIdOf(original.events);

    const replay = await resume(u, g);
    expect(replay.events.map((e) => [e.id, e.event, e.data])).toEqual(
      original.events.map((e) => [e.id, e.event, e.data]),
    );

    const started = Date.now();
    const after = await resume(u, g, original.events.at(-1)!.id!, {
      timeoutMs: 5_000,
    });
    expect(after.status).toBe(200);
    expect(after.events).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  describe('S46 AS-24: a malformed Last-Event-ID is a 400, a newer one waits for live events', () => {
    it.each(['abc', '12', '12-', '-3', '1_2', '1-2-3', '1-2x'])(
      '%j is rejected',
      async (bad) => {
        const u = await h.user();
        const c = await h.conversation(u);
        h.llm.script({ text: 'x' });
        const g = messageIdOf((await h.ask(u, c, { text: 'go' })).events);
        const res = await resume(u, g, bad);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_last_event_id');
      },
    );

    it('an id newer than the newest event gives an empty replay, then live events', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.llm.script({ text: 'a b c d e f', chunks: 6, delayMs: 300 });
      const first = await h.ask(u, c, { text: 'go' }, { count: 2 });
      const g = messageIdOf(first.events);
      const [ms] = first.events.at(-1)!.id!.split('-').map(Number);

      const res = await resume(u, g, `${ms + 1}-0`);
      expect(res.events.length).toBeGreaterThan(0);
      for (const e of res.events)
        expect(compareStreamIds(e.id!, `${ms + 1}-0`)).toBeGreaterThan(0);
      expect(res.events.at(-1)!.event).toBe('done');
      // the events before the cursor were not replayed
      expect(res.events.length).toBeLessThan(first.events.length + 6 + 1);
    });
  });

  it('S46 AS-25: a generation is gone after the replay window; the answer stays in the history', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.config.set('assistant_replay_window_ms', 400);
    h.llm.script({ text: 'kept' });
    const g = messageIdOf((await h.ask(u, c, { text: 'go' })).events);
    expect((await resume(u, g)).status).toBe(200);

    await waitFor(async () => (await h.generations.meta(u.id, g)) === null, {
      description: 'replay window passes',
    });
    const gone = await resume(u, g);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('generation_not_found');
    const unknown = await resume(u, '11111111-1111-1111-8111-111111111111');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('generation_not_found');
    const history = await h
      .http()
      .get(`/api/assistant/conversations/${c}/messages`)
      .set(u.auth)
      .expect(200);
    expect(history.body.messages.map((m: { text: string }) => m.text)).toEqual([
      'go',
      'kept',
    ]);
  });

  describe('S46 AS-26: abort when nobody watches', () => {
    it('aborts the provider call after the grace period and frees the conversation', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.config.set('assistant_detach_grace_ms', 300);
      h.llm.script({ text: 'streaming', hang: true, delayMs: 20 });

      const first = await h.ask(u, c, { text: 'go' }, { count: 2 });
      const g = messageIdOf(first.events);
      await waitFor(async () => h.llm.aborted === 1, {
        timeoutMs: 4_000,
        description: 'provider call aborted',
      });

      await waitFor(async () => (await state(u, g)) === 'error', {
        timeoutMs: 4_000,
      });
      const [terminal] = await terminalEvents(u, g);
      expect(terminal.event).toEqual({
        type: 'error',
        data: { code: 'CANCELLED' },
      });
      expect(await h.repository.messages(u.id, c)).toHaveLength(0);
      expect(await h.admission.lockHolder(u.id, c)).toBeNull();
      expect(await h.admission.slotMembers(u.id)).toEqual([]);

      h.llm.script({ text: 'second try' });
      const again = await h.ask(u, c, { text: 'go again' });
      expect(again.status).toBe(200);
      expect(again.events.at(-1)!.event).toBe('done');
    });

    it('does not abort when the viewer reconnects within the grace period', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.config.set('assistant_detach_grace_ms', 500);
      h.llm.script({ text: 'streaming', hang: true, delayMs: 20 });
      const first = await h.ask(u, c, { text: 'go' }, { count: 2 });
      const g = messageIdOf(first.events);

      const viewer = await attach(u, g, first.events.at(-1)!.id!);
      await new Promise((r) => setTimeout(r, 900));
      expect(h.llm.aborted).toBe(0);
      expect(await state(u, g)).toBe('running');
      expect(viewer.events.length).toBeGreaterThan(0);
      viewer.close();
      await cancel(u, g);
    });
  });

  describe('S46 AS-27: several viewers, and a viewer on another process', () => {
    it('a second tab keeps the generation alive after the first one leaves', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.config.set('assistant_detach_grace_ms', 300);
      h.llm.script({
        text: Array.from({ length: 20 }, (_, i) => `t${i} `).join(''),
        chunks: 20,
        delayMs: 120,
      });

      const first = await h.ask(u, c, { text: 'go' }, { count: 2 });
      const g = messageIdOf(first.events);
      const tabB = await attach(u, g);
      await tabB.waitFor(
        (frames) => frames.some((f) => f.event === 'done'),
        15_000,
      );

      expect(h.llm.aborted).toBe(0);
      const received = tabB.events.map((e) => e.id);
      expect(new Set(received).size).toBe(received.length);
      expect(textOf(tabB.events)).toBe(
        Array.from({ length: 20 }, (_, i) => `t${i} `).join(''),
      );
      tabB.close();
    });

    it('a viewer on a second app instance sees the same events and keeps the generation alive', async () => {
      // Both apps share the process's model classes; the second app is closed in `afterAll`, after the first.
      const second = (secondApp = await bootAssistant());
      {
        const u = await h.user();
        const c = await h.conversation(u);
        h.config.set('assistant_detach_grace_ms', 400);
        h.llm.script({ text: 'streaming', hang: true, delayMs: 50 });
        const first = await h.ask(u, c, { text: 'go' }, { count: 2 });
        const g = messageIdOf(first.events);

        const remote = await openSse(
          `${second.baseUrl}/assistant/messages/${g}/stream`,
          {
            headers: await second.sessionFor(u.id),
          },
        );
        expect([remote.status, remote.body]).toEqual([200, undefined]);
        await remote.waitFor(
          (frames) => frames.filter((f) => f.event === 'text').length >= 3,
          5_000,
        );
        await new Promise((r) => setTimeout(r, 900));
        expect(h.llm.aborted).toBe(0);
        expect(remote.events[0].event).toBe('meta');
        expect(data(remote.events[0]).messageId).toBe(g);

        remote.close();
        await waitFor(async () => h.llm.aborted === 1, {
          timeoutMs: 5_000,
          description: 'aborted after the remote viewer left',
        });
      }
    });
  });

  it('S46 AS-28: cancel aborts within 1 s, answers 202 twice, persists nothing', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.llm.script({ text: 'streaming', hang: true, delayMs: 20 });
    const first = await h.ask(u, c, { text: 'go' }, { count: 2 });
    const g = messageIdOf(first.events);
    // metering is slow, so the generation stays visible as "running" for a while after the abort
    const outbox = h.app.get(OutboxService);
    const append = outbox.appendStandalone.bind(outbox);
    const slow = jest
      .spyOn(outbox, 'appendStandalone')
      .mockImplementation(async (...args) => {
        await new Promise((r) => setTimeout(r, 600));
        return append(...args);
      });
    try {
      const started = Date.now();
      const a = await cancel(u, g);
      const b = await cancel(u, g);
      expect([a.status, a.body, b.status, b.body]).toEqual([
        202,
        { cancelling: true },
        202,
        { cancelling: true },
      ]);
      await waitFor(async () => h.llm.aborted === 1, {
        timeoutMs: 1_000,
        description: 'abort within 1 s',
      });
      expect(Date.now() - started).toBeLessThan(1_000);
      await waitFor(async () => (await state(u, g)) === 'error', {
        timeoutMs: 5_000,
      });
    } finally {
      slow.mockRestore();
    }
    const terminals = await terminalEvents(u, g);
    expect(terminals.map((e) => e.event)).toEqual([
      { type: 'error', data: { code: 'CANCELLED' } },
    ]);
    expect(await h.repository.messages(u.id, c)).toHaveLength(0);
    expect(await h.admission.lockHolder(u.id, c)).toBeNull();
  });

  it('S46 AS-29: cancel of a finished generation is 409 and does not change the outcome', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.llm.script({ text: 'finished' });
    const events = (await h.ask(u, c, { text: 'go' })).events;
    const g = messageIdOf(events);

    const res = await cancel(u, g);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('generation_finished');
    expect(await state(u, g)).toBe('done');
    expect((await terminalEvents(u, g)).map((e) => e.event.type)).toEqual([
      'done',
    ]);

    h.config.set('assistant_replay_window_ms', 200);
    h.llm.script({ text: 'second' });
    const g2 = messageIdOf((await h.ask(u, c, { text: 'again' })).events);
    await waitFor(async () => (await h.generations.meta(u.id, g2)) === null, {
      description: 'generation expires',
    });
    const gone = await cancel(u, g2);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('generation_not_found');
  });

  describe('S46 AS-30: a lost generator', () => {
    /** A generation whose process has disappeared: it holds the lock and a slot, but nothing refreshes its liveness. */
    const orphan = async (u: TestUser, c: string) => {
      const g = types.TimeUuid.now().toString();
      await h.generations.start(u.id, g, c);
      await h.generations.append(u.id, g, {
        type: 'meta',
        data: { messageId: g, conversationId: c },
      });
      expect(await h.admission.acquireLock(u.id, c, g, 300_000)).toBe(true);
      expect(await h.admission.acquireSlot(u.id, g, 3, 300_000)).toBe(true);
      await h.redis.client.del(`assistant:gen:{${u.id}:${g}}:alive`);
      return g;
    };

    it('yields exactly one GENERATION_LOST, reclaims the lock and slot, and the next send succeeds', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      const g = await orphan(u, c);

      const started = Date.now();
      const res = await resume(u, g);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(res.events.map((e) => e.event)).toEqual(['meta', 'error']);
      expect(data(res.events[1])).toEqual({ code: 'GENERATION_LOST' });
      expect(await h.admission.lockHolder(u.id, c)).toBeNull();
      expect(await h.admission.slotMembers(u.id)).toEqual([]);
      expect(await h.repository.messages(u.id, c)).toHaveLength(0);

      h.llm.script({ text: 'works again' });
      expect((await h.ask(u, c, { text: 'hello' })).events.at(-1)!.event).toBe(
        'done',
      );
    });

    it('two viewers racing to report it write one terminal event', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      const g = await orphan(u, c);

      const [a, b] = await Promise.all([resume(u, g), resume(u, g)]);
      expect(a.events.at(-1)!.event).toBe('error');
      expect(b.events.at(-1)!.event).toBe('error');
      expect(a.events.at(-1)!.id).toBe(b.events.at(-1)!.id);
      expect(await terminalEvents(u, g)).toHaveLength(1);
    });

    it('a send reclaims the lock of a lost generation even when nobody watches it', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      await orphan(u, c);
      h.llm.script({ text: 'reclaimed' });
      const res = await h.ask(u, c, { text: 'hello' });
      expect(res.status).toBe(200);
      expect(res.events.at(-1)!.event).toBe('done');
    });
  });

  it('S46 AS-31: the next send right after a terminal event is never 409 (100 runs)', async () => {
    for (let run = 0; run < 100; run++) {
      await h.resetBudget();
      const u = await h.user();
      const c = await h.conversation(u);
      // the last scripted turn of every other run is a refusal: any terminal event frees the conversation
      h.llm.script(
        { text: 'first' },
        run % 2 ? { text: '', stopReason: 'refusal' } : { text: 'second' },
        { text: 'third' },
      );
      const one = await h.ask(u, c, { text: 'one' });
      expect(one.events.at(-1)!.event).toBe('done');
      const two = await h.ask(u, c, { text: 'two' });
      expect(two.status).toBe(200);
      const three = await h.ask(u, c, { text: 'three' });
      expect(three.status).toBe(200);
    }
  }, 170_000);
});
