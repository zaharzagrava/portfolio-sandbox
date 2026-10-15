import { v4 } from 'uuid';
import {
  assistantConversationListSchema,
  assistantConversationSchema,
  assistantHistorySchema,
  assistantStreamEventSchema,
} from '@marketplace-sandbox/contracts';
import { waitFor } from '@app/test/utils/async-helpers';
import { readSse } from '@app/test/utils/sse-client';
import { compareStreamIds } from './domain/stream-id';
import {
  bootAssistant,
  data,
  textOf,
  type Harness,
  type TestUser,
} from './testing/assistant.harness';

/**
 * S46 US1 and US8: turns, conversations and idempotency, against real Redis (generations, admission) and Scylla (the
 * transcript). The model is the scripted provider, so specs assert exactly what was sent to it.
 */
describe('Shopping assistant: turns, conversations, idempotency', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootAssistant();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  /** Starts a reply that never ends on its own and returns its message id (the viewer is gone after `meta`). */
  const startHanging = async (u: TestUser, c: string) => {
    h.config.set('assistant_detach_grace_ms', 60_000);
    h.llm.script({ text: 'thinking', hang: true, delayMs: 20 });
    const { events } = await h.ask(u, c, { text: 'hold on' }, { count: 1 });
    // the provider call starts just after `meta`; later counts of requests must not include it
    await waitFor(async () => h.llm.requests.length >= 1, {
      description: 'provider call started',
    });
    return data(events[0]).messageId as string;
  };
  const stopHanging = async (u: TestUser, messageId: string) => {
    await h
      .http()
      .post(`/api/assistant/messages/${messageId}/cancel`)
      .set(u.auth);
    await waitFor(
      async () =>
        (await h.generations.meta(u.id, messageId))?.state === 'error',
      {
        description: 'cancelled generation ends',
      },
    );
  };

  it('S46 AS-01: streams meta → text… → done in order and persists the turn', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.llm.script({ text: 'Hello there', chunks: 3 });

    const { status, events } = await h.ask(u, c, { text: 'hi' });

    expect(status).toBe(200);
    expect(events[0].event).toBe('meta');
    expect(data(events[0])).toEqual({
      messageId: expect.any(String),
      conversationId: c,
    });
    expect(events.at(-1)!.event).toBe('done');
    expect(events.slice(1, -1).every((e) => e.event === 'text')).toBe(true);
    expect(textOf(events)).toBe('Hello there');
    const done = data(events.at(-1)!);
    expect(done).toEqual({
      stopReason: 'end_turn',
      truncated: false,
      usage: {
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      },
      allowance: { used: expect.any(Number), limit: 1_000_000 },
    });
    // every event parses with the shared contract schema
    for (const e of events)
      expect(
        assistantStreamEventSchema.safeParse({ event: e.event, ...data(e) })
          .success,
      ).toBe(true);
    const ids = events.map((e) => e.id!);
    for (let i = 1; i < ids.length; i++)
      expect(compareStreamIds(ids[i - 1], ids[i])).toBeLessThan(0);

    const history = assistantHistorySchema.parse(
      (
        await h
          .http()
          .get(`/api/assistant/conversations/${c}/messages`)
          .set(u.auth)
          .expect(200)
      ).body,
    );
    expect(history.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello there'],
    ]);
    // the turn is exactly the user message and the assistant message
    expect(await h.repository.messages(u.id, c)).toHaveLength(2);
    expect(await h.repository.messageCount(u.id, c)).toBe(2);
  });

  it('S46 AS-02: headers, retry hint, heartbeat, strictly increasing ids, no cost in done', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.config.set('assistant_heartbeat_ms', 200);
    h.llm.script({ text: 'slow answer', chunks: 2, delayMs: 700 });

    const res = await h.ask(u, c, { text: 'hi' });

    expect(res.headers['content-type']).toBe(
      'text/event-stream; charset=utf-8',
    );
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.frames[0].retry).toBe(2000);
    expect(res.comments).toContain('ping');
    // heartbeats carry no id and are not events
    expect(
      res.frames
        .filter((f) => f.comments.includes('ping'))
        .every((f) => f.id === undefined),
    ).toBe(true);
    expect(new Set(res.events.map((e) => e.event))).toEqual(
      new Set(['meta', 'text', 'done']),
    );
    const done = data(res.events.at(-1)!);
    expect(Object.keys(done).sort()).toEqual([
      'allowance',
      'stopReason',
      'truncated',
      'usage',
    ]);
    expect(Object.keys(done.usage).sort()).toEqual([
      'inputTokens',
      'outputTokens',
    ]);
    const resume = await readSse(
      `${h.baseUrl}/assistant/messages/${data(res.events[0]).messageId}/stream`,
      { headers: u.auth, count: 100, until: ['done'], timeoutMs: 5_000 },
    );
    expect(resume.headers['content-type']).toBe(
      'text/event-stream; charset=utf-8',
    );
    expect(resume.frames[0].retry).toBe(2000);
  });

  describe('S46 AS-03: invalid input is a 400 naming the field, with no side effect', () => {
    const cases: [string, object, string][] = [
      ['text missing', {}, 'text'],
      ['text empty', { text: '' }, 'text'],
      ['text only whitespace', { text: '   \n\t ' }, 'text'],
      ['text of 4001 characters', { text: 'a'.repeat(4001) }, 'text'],
      ['lat without lng', { text: 'hi', lat: 10 }, 'lng'],
      ['lng without lat', { text: 'hi', lng: 10 }, 'lat'],
      ['lat above 90', { text: 'hi', lat: 90.0001, lng: 0 }, 'lat'],
      ['lng below -180', { text: 'hi', lat: 0, lng: -180.0001 }, 'lng'],
      ['lat not a number', { text: 'hi', lat: 'north', lng: 0 }, 'lat'],
      ['unknown field model', { text: 'hi', model: 'x' }, 'model'],
      ['unknown field system', { text: 'hi', system: 'x' }, 'system'],
      ['unknown field tools', { text: 'hi', tools: [] }, 'tools'],
    ];
    it.each(cases)('%s', async (_name, body, field) => {
      const u = await h.user();
      const c = await h.conversation(u);
      const res = await h.ask(u, c, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(
        field,
      );
      expect(h.llm.requests).toHaveLength(0);
      expect(await h.repository.messages(u.id, c)).toHaveLength(0);
      expect(await h.admission.lockHolder(u.id, c)).toBeNull();
      expect(await h.admission.slotMembers(u.id)).toEqual([]);
    });

    it('a conversation id that is not a time-based UUID', async () => {
      const u = await h.user();
      const res = await h.ask(u, 'not-a-uuid', { text: 'hi' });
      expect(res.status).toBe(400);
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(
        'id',
      );
    });

    it.each([
      ['longer than 128 characters', 'k'.repeat(129)],
      ['characters outside the allowed set', 'key with spaces'],
    ])('Idempotency-Key %s', async (_name, key) => {
      const u = await h.user();
      const c = await h.conversation(u);
      const res = await h.ask(u, c, { text: 'hi' }, { key });
      expect(res.status).toBe(400);
      expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(
        'Idempotency-Key',
      );
      expect(h.llm.requests).toHaveLength(0);
    });

    it('4000 characters are accepted', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      const res = await h.ask(u, c, { text: 'a'.repeat(4000) });
      expect(res.status).toBe(200);
      expect(res.events.at(-1)!.event).toBe('done');
    });

    it.each([
      ['empty title', { title: '' }],
      ['title of 121 characters', { title: 't'.repeat(121) }],
    ])('conversation with %s is a 400', async (_name, body) => {
      const u = await h.user();
      await h
        .http()
        .post('/api/assistant/conversations')
        .set(u.auth)
        .send(body)
        .expect(400);
    });

    it('a title is trimmed and defaults to "New chat"', async () => {
      const u = await h.user();
      const trimmed = await h
        .http()
        .post('/api/assistant/conversations')
        .set(u.auth)
        .send({ title: '  Phones  ' })
        .expect(201);
      expect(trimmed.body.title).toBe('Phones');
      const defaulted = await h
        .http()
        .post('/api/assistant/conversations')
        .set(u.auth)
        .send({})
        .expect(201);
      expect(defaulted.body.title).toBe('New chat');
    });
  });

  describe('S46 AS-04: every route needs a signed-in user', () => {
    const id = v4();
    const routes: [string, string, string][] = [
      ['post', '/api/assistant/conversations', 'create'],
      ['get', '/api/assistant/conversations', 'list'],
      ['delete', `/api/assistant/conversations/${id}`, 'delete'],
      ['get', `/api/assistant/conversations/${id}/messages`, 'history'],
      ['post', `/api/assistant/conversations/${id}/messages`, 'send'],
      ['get', `/api/assistant/messages/${id}/stream`, 'stream'],
      ['post', `/api/assistant/messages/${id}/cancel`, 'cancel'],
      ['get', '/api/assistant/usage', 'usage'],
    ];
    it.each(routes)(
      '%s %s (%s) answers 401 and does nothing',
      async (method, path) => {
        const res = await (h.http() as any)
          [method](path)
          .set({ 'Idempotency-Key': 'k1' })
          .send({ text: 'hi' });
        expect(res.status).toBe(401);
        expect(res.body.status).toBe(401);
        expect(h.llm.requests).toHaveLength(0);
      },
    );

    it('an invalid token is a 401 too', async () => {
      const res = await h
        .http()
        .get('/api/assistant/usage')
        .set({ Authorization: 'Bearer nonsense' });
      expect(res.status).toBe(401);
    });
  });

  it('S46 AS-05: another user gets 404 for conversation, history, delete, stream and cancel', async () => {
    const u = await h.user();
    const v = await h.user();
    const c = await h.conversation(u);
    const g = await startHanging(u, c);
    const requestsBefore = h.llm.requests.length;
    const fresh = v4();
    const unknownConversation = `${fresh.slice(0, 14)}1${fresh.slice(15)}`;
    const unknownGeneration = unknownConversation;

    const shape = (res: { status: number; body: Record<string, unknown> }) => ({
      status: res.status,
      code: res.body.code,
      title: res.body.title,
      detail: res.body.detail,
    });
    const send = (conversationId: string) =>
      h.ask(v, conversationId, { text: 'hello' });

    const foreign = [
      await send(c),
      await h
        .http()
        .get(`/api/assistant/conversations/${c}/messages`)
        .set(v.auth),
      await h.http().delete(`/api/assistant/conversations/${c}`).set(v.auth),
      await h.http().get(`/api/assistant/messages/${g}/stream`).set(v.auth),
      await h.http().post(`/api/assistant/messages/${g}/cancel`).set(v.auth),
    ].map((r) => shape(r as never));
    const unknown = [
      await send(unknownConversation),
      await h
        .http()
        .get(`/api/assistant/conversations/${unknownConversation}/messages`)
        .set(v.auth),
      await h
        .http()
        .delete(`/api/assistant/conversations/${unknownConversation}`)
        .set(v.auth),
      await h
        .http()
        .get(`/api/assistant/messages/${unknownGeneration}/stream`)
        .set(v.auth),
      await h
        .http()
        .post(`/api/assistant/messages/${unknownGeneration}/cancel`)
        .set(v.auth),
    ].map((r) => shape(r as never));

    expect(foreign.map((f) => f.status)).toEqual([404, 404, 404, 404, 404]);
    expect(foreign).toEqual(unknown);
    expect(foreign.slice(0, 3).every((f) => f.code === 'not_found')).toBe(true);
    // nothing of U's changed, no provider call was made for V, and U's generation keeps running
    expect(h.llm.requests).toHaveLength(requestsBefore);
    expect((await h.generations.meta(u.id, g))?.state).toBe('running');
    expect(await h.repository.find(u.id, c)).not.toBeNull();
    await stopHanging(u, g);
  });

  it('S46 AS-07: creates and lists conversations with a keyset cursor', async () => {
    const u = await h.user();
    const other = await h.user();
    await h.conversation(other);
    const created = await h
      .http()
      .post('/api/assistant/conversations')
      .set(u.auth)
      .send({ title: 'Phones' })
      .expect(201);
    expect(assistantConversationSchema.parse(created.body)).toMatchObject({
      title: 'Phones',
      messageCount: 0,
    });
    const ids = [created.body.id as string];
    for (let i = 0; i < 24; i++) ids.push(await h.conversation(u));
    const newestFirst = [...ids].reverse();

    const first = assistantConversationListSchema.parse(
      (
        await h
          .http()
          .get('/api/assistant/conversations?limit=10')
          .set(u.auth)
          .expect(200)
      ).body,
    );
    expect(first.items.map((i) => i.id)).toEqual(newestFirst.slice(0, 10));
    expect(first.nextCursor).not.toBeNull();

    // a conversation created between page requests does not shift or repeat the next pages
    await h.conversation(u);
    const second = assistantConversationListSchema.parse(
      (
        await h
          .http()
          .get(
            `/api/assistant/conversations?limit=10&cursor=${first.nextCursor}`,
          )
          .set(u.auth)
          .expect(200)
      ).body,
    );
    expect(second.items.map((i) => i.id)).toEqual(newestFirst.slice(10, 20));
    const third = assistantConversationListSchema.parse(
      (
        await h
          .http()
          .get(
            `/api/assistant/conversations?limit=10&cursor=${second.nextCursor}`,
          )
          .set(u.auth)
          .expect(200)
      ).body,
    );
    expect(third.items.map((i) => i.id)).toEqual(newestFirst.slice(20));
    expect(third.nextCursor).toBeNull();

    const defaulted = await h
      .http()
      .get('/api/assistant/conversations')
      .set(u.auth)
      .expect(200);
    expect(defaulted.body.items).toHaveLength(20);

    const bad = await h
      .http()
      .get('/api/assistant/conversations?cursor=%25%25%25')
      .set(u.auth);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_cursor');
    await h
      .http()
      .get('/api/assistant/conversations?limit=51')
      .set(u.auth)
      .expect(400);
  });

  it('S46 AS-08: history hides thinking, the context block and tool output', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.llm.script(
      {
        text: 'Let me look.',
        toolUses: [{ name: 'product_details', input: { product_id: v4() } }],
      },
      { text: 'Nothing found.' },
    );
    const { events } = await h.ask(u, c, {
      text: 'find a phone',
      lat: 52.5,
      lng: 13.4,
    });
    expect(events.at(-1)!.event).toBe('done');

    const body = (
      await h
        .http()
        .get(`/api/assistant/conversations/${c}/messages`)
        .set(u.auth)
        .expect(200)
    ).body;
    const history = assistantHistorySchema.parse(body);
    expect(history.messages.map((m) => [m.role, m.text, m.tools])).toEqual([
      ['user', 'find a phone', []],
      ['assistant', 'Let me look.', ['product_details']],
      ['assistant', 'Nothing found.', []],
    ]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('<context>');
    expect(raw).not.toContain('No product with that id');
    expect(raw).not.toContain('52.5');
    expect(new Set(history.messages.map((m) => m.turnId)).size).toBe(1);
  });

  it('S46 AS-09: deletes its own conversation; 409 while generating; 404 for a second delete', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    for (const text of ['one', 'two', 'three']) {
      h.llm.script({ text: `answer ${text}` });
      expect((await h.ask(u, c, { text })).events.at(-1)!.event).toBe('done');
    }
    expect(await h.repository.messages(u.id, c)).toHaveLength(6);

    await h
      .http()
      .delete(`/api/assistant/conversations/${c}`)
      .set(u.auth)
      .expect(204);
    await h
      .http()
      .get(`/api/assistant/conversations/${c}/messages`)
      .set(u.auth)
      .expect(404);
    expect(await h.repository.messages(u.id, c)).toHaveLength(0);
    const list = await h
      .http()
      .get('/api/assistant/conversations')
      .set(u.auth)
      .expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(c);
    await h
      .http()
      .delete(`/api/assistant/conversations/${c}`)
      .set(u.auth)
      .expect(404);

    const busy = await h.conversation(u);
    const g = await startHanging(u, busy);
    const refused = await h
      .http()
      .delete(`/api/assistant/conversations/${busy}`)
      .set(u.auth);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('turn_in_progress');
    expect(await h.repository.find(u.id, busy)).not.toBeNull();
    await stopHanging(u, g);
  });

  describe('idempotent sends', () => {
    const used = async (u: TestUser) =>
      (await h.http().get('/api/assistant/usage').set(u.auth).expect(200)).body
        .used as number;

    it('S46 AS-63: the same key and body replay the stored events; no model call, charge or second turn', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.llm.script({ text: 'once only', chunks: 2 });
      const key = v4();
      const original = await h.ask(u, c, { text: 'hello' }, { key });
      expect(original.events.at(-1)!.event).toBe('done');
      const charged = await used(u);

      const replay = await h.ask(u, c, { text: 'hello' }, { key });

      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(original.headers['idempotent-replay']).toBeUndefined();
      expect(replay.events.map((e) => [e.id, e.event, e.data])).toEqual(
        original.events.map((e) => [e.id, e.event, e.data]),
      );
      expect(h.llm.requests).toHaveLength(1);
      expect(await used(u)).toBe(charged);
      expect(await h.repository.messages(u.id, c)).toHaveLength(2);
    });

    it('S46 AS-64: the same key while the reply is generating is 409 idempotency_in_flight with the message id', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.config.set('assistant_detach_grace_ms', 60_000);
      h.llm.script({ text: 'slow', hang: true, delayMs: 20 });
      const key = v4();
      const first = await h.ask(u, c, { text: 'hello' }, { key, count: 1 });
      const g = data(first.events[0]).messageId as string;

      const again = await h.ask(u, c, { text: 'hello' }, { key });

      expect([again.status, again.body.code, again.body.messageId]).toEqual([
        409,
        'idempotency_in_flight',
        g,
      ]);
      expect(h.llm.requests).toHaveLength(1);
      await stopHanging(u, g);
    });

    it.each([
      ['another text', { text: 'something else' }, false],
      ['another location', { text: 'hello', lat: 1, lng: 2 }, false],
      ['another conversation', { text: 'hello' }, true],
    ])(
      'S46 AS-65: the same key with %s is 422 idempotency_key_reuse',
      async (_name, body, otherConversation) => {
        const u = await h.user();
        const c = await h.conversation(u);
        const key = v4();
        expect(
          (await h.ask(u, c, { text: 'hello' }, { key })).events.at(-1)!.event,
        ).toBe('done');
        const target = otherConversation ? await h.conversation(u) : c;

        const res = await h.ask(u, target, body, { key });

        expect([res.status, res.body.code]).toEqual([
          422,
          'idempotency_key_reuse',
        ]);
        expect(h.llm.requests).toHaveLength(1);
        expect(await h.repository.messages(u.id, target)).toHaveLength(
          target === c ? 2 : 0,
        );
      },
    );

    it.each([
      ['missing', null],
      ['empty', ''],
    ])(
      'S46 AS-66: a %s key is 422 idempotency_key_required',
      async (_name, key) => {
        const u = await h.user();
        const c = await h.conversation(u);
        const res = await h.ask(u, c, { text: 'hello' }, { key });
        expect([res.status, res.body.code]).toEqual([
          422,
          'idempotency_key_required',
        ]);
        expect(h.llm.requests).toHaveLength(0);
        expect(await h.repository.messages(u.id, c)).toHaveLength(0);
        expect(await h.admission.lockHolder(u.id, c)).toBeNull();
      },
    );

    it('S46 AS-67: keys are per user; a rejected send releases its key; a failed generation keeps it', async () => {
      const u = await h.user();
      const v = await h.user();
      const cu = await h.conversation(u);
      const cv = await h.conversation(v);
      const shared = v4();
      expect(
        (await h.ask(u, cu, { text: 'hello' }, { key: shared })).status,
      ).toBe(200);
      expect(
        (await h.ask(v, cv, { text: 'hello' }, { key: shared })).status,
      ).toBe(200);
      expect(h.llm.requests).toHaveLength(2);

      // rejected before generating (allowance used up): the key is free again once the cause is gone
      const released = v4();
      const c2 = await h.conversation(u);
      h.entitlements.limit = 0;
      const rejected = await h.ask(u, c2, { text: 'hello' }, { key: released });
      expect(rejected.status).toBe(429);
      h.entitlements.limit = 1_000_000;
      const retried = await h.ask(u, c2, { text: 'hello' }, { key: released });
      expect(retried.status).toBe(200);
      expect(retried.headers['idempotent-replay']).toBeUndefined();
      expect(retried.events.at(-1)!.event).toBe('done');

      // a send that started and failed stays bound to its outcome: the replay shows the same terminal event
      const c3 = await h.conversation(u);
      const failedKey = v4();
      h.llm.script({ rejected: true });
      const failed = await h.ask(u, c3, { text: 'hello' }, { key: failedKey });
      expect(data(failed.events.at(-1)!).code).toBe('INTERNAL');
      const requestsBefore = h.llm.requests.length;
      const replay = await h.ask(u, c3, { text: 'hello' }, { key: failedKey });
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(replay.events.at(-1)).toMatchObject({
        event: 'error',
        data: failed.events.at(-1)!.data,
      });
      expect(h.llm.requests).toHaveLength(requestsBefore);
    });
  });
});
