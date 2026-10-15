import { types } from 'cassandra-driver';
import { v4 } from 'uuid';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  bootAssistant,
  data,
  type Harness,
  type TestUser,
} from './testing/assistant.harness';

type Block = { type: string; [k: string]: unknown };

describe('Shopping assistant: transcript, compaction, atomic persistence', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootAssistant();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    h.config.set('assistant_detach_grace_ms', 60_000);
  });

  const summaryModel = () => h.config.get('assistant_summary_model');
  const messageId = (events: { data?: string }[]) =>
    JSON.parse(events[0].data!).messageId as string;

  /** Stores a long finished transcript directly (well over the compaction threshold). */
  const longTranscript = async (
    u: TestUser,
    c: string,
    messages = 10,
    chars = 28_000,
  ) => {
    const ids: string[] = [];
    for (let i = 0; i < messages; i += 3) {
      const batch = Array.from(
        { length: Math.min(3, messages - i) },
        (_, j) => ({
          role: ((i + j) % 2 === 0 ? 'user' : 'assistant') as
            'user' | 'assistant',
          content: JSON.stringify([
            { type: 'text', text: `${i + j}:`.padEnd(chars, 'x') },
          ]),
          visibleText: `m${i + j}`,
          toolNames: [] as string[],
        }),
      );
      await h.repository.appendTurn(
        u.id,
        c,
        types.TimeUuid.now().toString(),
        batch,
      );
    }
    for (const m of await h.repository.messages(u.id, c)) ids.push(m.messageId);
    return ids;
  };

  it('S46 AS-58: the third turn replays turns 1–2 byte for byte; system and tools stay frozen', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.llm.script(
      { thinking: 'first thoughts', text: 'answer one' },
      {
        toolUses: [{ name: 'product_details', input: { product_id: v4() } }],
        thinking: 'second thoughts',
      },
      { text: 'answer two' },
      { text: 'answer three' },
    );

    await h.ask(u, c, { text: 'one', lat: 1.5, lng: 2.5 });
    await h.ask(u, c, { text: 'two' });
    await h.ask(u, c, { text: 'three', lat: 3.5, lng: 4.5 });

    const requests = h.llm.requests;
    expect(requests).toHaveLength(4);
    const third = requests[3].messages;
    // turns 1 and 2 (user, assistant, user, tool_use, tool_result, assistant) come back exactly as sent and returned
    expect(JSON.stringify(third.slice(0, 5))).toBe(
      JSON.stringify(requests[2].messages),
    );
    expect(third).toHaveLength(7);
    const assistantOne = third[1].content as Block[];
    expect(assistantOne[0]).toEqual({
      type: 'thinking',
      thinking: 'first thoughts',
      signature: `sig-${'first thoughts'.length}`,
    });
    // system and tools are byte-identical in every request, with the cache breakpoint on the system prompt
    for (const request of requests) {
      expect(JSON.stringify(request.system)).toBe(
        JSON.stringify(requests[0].system),
      );
      expect(JSON.stringify(request.tools)).toBe(
        JSON.stringify(requests[0].tools),
      );
    }
    const system = requests[0].system as unknown as Block[];
    expect(system.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    // per-turn facts live only in the appended user message of their own turn
    const contexts = third
      .filter((m) => m.role === 'user' && Array.isArray(m.content))
      .map(
        (m) =>
          (m.content as Block[]).find((b) =>
            String(b.text).startsWith('<context>'),
          )?.text,
      );
    expect(contexts.filter(Boolean)).toEqual([
      '<context>Location shared for pickup search: yes.</context>',
      '<context>Location shared for pickup search: no.</context>',
      '<context>Location shared for pickup search: yes.</context>',
    ]);
    expect(JSON.stringify(requests[0].system)).not.toContain('Location shared');
  });

  describe('S46 AS-59: a long conversation is compacted into one summary', () => {
    it('summarises the whole transcript, moves the marker forward and never replays what came before', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      const ids = await longTranscript(u, c);
      h.llm.script(
        { model: summaryModel(), text: 'SUMMARY OF EVERYTHING' },
        { text: 'fresh answer' },
      );

      const res = await h.ask(u, c, { text: 'continue please' });
      expect(res.events.at(-1)!.event).toBe('done');

      const [summaryCall, chat] = h.llm.requests;
      expect(summaryCall.model).toBe(summaryModel());
      expect(JSON.stringify(summaryCall.system)).toContain('300 words');
      expect(chat.messages).toHaveLength(2);
      expect(JSON.stringify(chat.messages[0])).toBe(
        JSON.stringify({
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<conversation_summary>\nSUMMARY OF EVERYTHING\n</conversation_summary>',
            },
          ],
        }),
      );
      expect(chat.messages[1].role).toBe('user');
      const record = await h.repository.find(u.id, c);
      expect(record!.summary).toBe('SUMMARY OF EVERYTHING');
      expect(record!.compactedUpTo).toBe(ids.at(-1));

      // the summary call is a recorded, charged call
      const m = messageId(res.events);
      const rows = await waitFor(
        async () => {
          const found = await outboxRowsFor(h.app, `${m}:0`);
          return found.length ? found : null;
        },
        { description: 'summary record' },
      );
      const payload = ((
        rows[0].payload as { payload?: Record<string, unknown> }
      ).payload ?? rows[0].payload) as Record<string, unknown>;
      expect(payload).toMatchObject({
        purpose: 'summary',
        outcome: 'completed',
      });
      expect(
        (await h.http().get('/api/assistant/usage').set(u.auth)).body.used,
      ).toBeGreaterThan(Number(payload.billableTokens));

      // the next turn replays the summary plus only what was said after it
      h.llm.script({ text: 'second fresh answer' });
      await h.ask(u, c, { text: 'and then?' });
      const next = h.llm.requests.at(-1)!.messages;
      expect(next).toHaveLength(4);
      expect(JSON.stringify(next)).not.toContain('xxxxxxxxxx');
      expect(JSON.stringify(next[0])).toContain('SUMMARY OF EVERYTHING');
    });

    it('the marker only moves forward, and racing compactions record once', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      const ids = await longTranscript(u, c, 6, 100);
      expect(
        await h.repository.recordCompaction(u.id, c, 'first', ids[3]),
      ).toBe(true);
      expect(
        await h.repository.recordCompaction(u.id, c, 'older', ids[1]),
      ).toBe(false);
      expect(await h.repository.recordCompaction(u.id, c, 'same', ids[3])).toBe(
        false,
      );
      expect((await h.repository.find(u.id, c))!.compactedUpTo).toBe(ids[3]);
      const raced = await Promise.all([
        h.repository.recordCompaction(u.id, c, 'race a', ids[4]),
        h.repository.recordCompaction(u.id, c, 'race b', ids[5]),
      ]);
      expect(raced.filter(Boolean).length).toBeGreaterThanOrEqual(1);
      const record = await h.repository.find(u.id, c);
      expect(record!.compactedUpTo).toBe(ids[5]);
      expect(record!.summary).toBe('race b');
    });

    it('two turns racing leave one compaction: the reply lock serialises them', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      await longTranscript(u, c);
      h.llm.script(
        { model: summaryModel(), text: 'SUMMARY', delayMs: 300 },
        { text: 'answer', delayMs: 100 },
        { model: summaryModel(), text: 'SECOND SUMMARY' },
      );
      const [a, b] = await Promise.all([
        h.ask(u, c, { text: 'one' }),
        h.ask(u, c, { text: 'two' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(
        h.llm.requests.filter((r) => r.model === summaryModel()),
      ).toHaveLength(1);
    });

    it('a count that fails falls back to the local estimate', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      await longTranscript(u, c);
      const original = h.llm.countTokens.bind(h.llm);
      h.llm.countTokens = async () => {
        throw new Error('count endpoint down');
      };
      try {
        h.llm.script(
          { model: summaryModel(), text: 'ESTIMATE SUMMARY' },
          { text: 'answer' },
        );
        const res = await h.ask(u, c, { text: 'continue' });
        expect(res.events.at(-1)!.event).toBe('done');
        expect((await h.repository.find(u.id, c))!.summary).toBe(
          'ESTIMATE SUMMARY',
        );
      } finally {
        h.llm.countTokens = original;
      }
    });
  });

  it('S46 AS-60: a failing summary fails the turn, records no compaction, and the next turn retries', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    await longTranscript(u, c);
    const before = (await h.repository.messages(u.id, c)).length;
    h.llm.script({ model: summaryModel(), unavailable: true });

    const failed = await h.ask(u, c, { text: 'continue' });

    expect(data(failed.events.at(-1)!).code).toBe('PROVIDER_UNAVAILABLE');
    const record = await h.repository.find(u.id, c);
    expect([record!.summary, record!.compactedUpTo]).toEqual([null, null]);
    expect(await h.repository.messages(u.id, c)).toHaveLength(before);
    expect(await h.admission.lockHolder(u.id, c)).toBeNull();

    h.llm.script(
      { model: summaryModel(), text: 'RETRIED SUMMARY' },
      { text: 'answer' },
    );
    const retried = await h.ask(u, c, { text: 'continue' });
    expect(retried.events.at(-1)!.event).toBe('done');
    expect((await h.repository.find(u.id, c))!.summary).toBe('RETRIED SUMMARY');
  });

  describe('S46 AS-61: only a turn that ends done is persisted, as a whole', () => {
    const rowsOf = async (u: TestUser, c: string) =>
      h.repository.messages(u.id, c);

    it('done: the user message, every tool round and the answer are stored together', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.llm.script(
        {
          text: 'looking',
          toolUses: [{ name: 'product_details', input: { product_id: v4() } }],
        },
        { text: 'final' },
      );
      const res = await h.ask(u, c, { text: 'go' });
      expect(res.events.at(-1)!.event).toBe('done');
      const rows = await rowsOf(u, c);
      expect(rows.map((r) => r.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(new Set(rows.map((r) => r.turnId))).toEqual(
        new Set([messageId(res.events)]),
      );
      expect(await h.repository.messageCount(u.id, c)).toBe(4);
    });

    const outcomes: [string, (u: TestUser, c: string) => Promise<void>][] = [
      [
        'a provider refusal',
        async (u, c) => {
          h.llm.script({ text: '', stopReason: 'refusal' });
          expect((await h.ask(u, c, { text: 'go' })).events.at(-1)!.event).toBe(
            'refusal',
          );
        },
      ],
      [
        'a provider error',
        async (u, c) => {
          h.llm.script({ unavailable: true }, { unavailable: true });
          expect(
            data((await h.ask(u, c, { text: 'go' })).events.at(-1)!).code,
          ).toBe('PROVIDER_UNAVAILABLE');
        },
      ],
      [
        'a cancel during the second tool round',
        async (u, c) => {
          h.llm.script(
            {
              text: 'round one',
              toolUses: [
                { name: 'product_details', input: { product_id: v4() } },
              ],
            },
            { text: 'round two', hang: true, delayMs: 20 },
          );
          const first = await h.ask(u, c, { text: 'go' }, { count: 6 });
          const m = messageId(first.events);
          await h
            .http()
            .post(`/api/assistant/messages/${m}/cancel`)
            .set(u.auth)
            .expect(202);
          await waitFor(
            async () => (await h.generations.meta(u.id, m))?.state === 'error',
            { description: 'cancelled' },
          );
        },
      ],
      [
        'a disconnect abort',
        async (u, c) => {
          h.config.set('assistant_detach_grace_ms', 300);
          h.llm.script({ text: 'streaming', hang: true, delayMs: 20 });
          const first = await h.ask(u, c, { text: 'go' }, { count: 2 });
          await waitFor(
            async () =>
              (await h.generations.meta(u.id, messageId(first.events)))
                ?.state === 'error',
            { description: 'aborted' },
          );
        },
      ],
      [
        'a timeout',
        async (u, c) => {
          h.config.set('assistant_turn_timeout_ms', 1_200);
          h.llm.script({ text: 'streaming', hang: true, delayMs: 20 });
          expect(
            data((await h.ask(u, c, { text: 'go' })).events.at(-1)!).code,
          ).toBe('TURN_TIMEOUT');
        },
      ],
      [
        'a crashed generator',
        async (u, c) => {
          const g = types.TimeUuid.now().toString();
          await h.generations.start(u.id, g, c);
          await h.admission.acquireLock(u.id, c, g, 60_000);
          await h.redis.client.del(`assistant:gen:{${u.id}:${g}}:alive`);
          const res = await h.ask(u, c, { text: 'go' });
          expect(res.status).toBe(200);
          // the crashed turn left nothing; this one is stored on its own (checked below as two rows)
        },
      ],
    ];
    it.each(outcomes)(
      '%s leaves no row of the turn, and the next send sees a valid transcript',
      async (_name, run) => {
        const u = await h.user();
        const c = await h.conversation(u);
        const before = _name === 'a crashed generator' ? 2 : 0;
        h.llm.reset();
        await run(u, c);
        expect(await rowsOf(u, c)).toHaveLength(before);
        expect(await h.admission.lockHolder(u.id, c)).toBeNull();

        h.config.reset();
        h.llm.reset();
        h.llm.script({ text: 'works' });
        const next = await h.ask(u, c, { text: 'again' });
        expect(next.events.at(-1)!.event).toBe('done');
        // no dangling tool_use, no assistant message without its predecessor, no two user messages in a row
        const sent = h.llm.requests[0].messages;
        expect(sent.map((m) => m.role)).toEqual(
          before ? ['user', 'assistant', 'user'] : ['user'],
        );
      },
    );
  });
});
