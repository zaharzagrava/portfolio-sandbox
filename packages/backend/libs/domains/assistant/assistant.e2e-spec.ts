import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { readSse, SseEvent } from '@app/test/utils/sse-client';
import { waitFor } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { AuthApiModule, UserModel as User } from '@app/domains/identity';
import { issueSession } from '@app/test/seeds/session.fixture';
import { getModelToken } from '@nestjs/sequelize';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ApiConfigService } from '@app/common/config';
import { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { AssistantModule } from './assistant.module';
import { ConversationStore } from './infra/conversation.store';
import { LLM_PROVIDER } from './infra/llm/llm-provider';
import { ScriptedLlmProvider } from './infra/llm/scripted.provider';
import { compareStreamIds } from './infra/generation-buffer';
import { types } from 'cassandra-driver';

const TERMINAL = ['done', 'error', 'refusal'];
const data = (e: SseEvent) => JSON.parse(e.data ?? '{}');
const textOf = (events: SseEvent[]) =>
  events
    .filter((e) => e.event === 'text')
    .map((e) => data(e).t)
    .join('');

/**
 * SD-42 against real Redis (turn lock, stream buffer, quotas), Scylla
 * (transcript) and Postgres (product_details tool); the model is the scripted
 * provider, so specs assert exactly what was SENT to it.
 */
describe('Shopping assistant (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let seeds: SeedsService;
  let llm: ScriptedLlmProvider;
  let redis: RedisService;
  let config: MockApiConfigService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [AssistantModule, AuthApiModule, SeedsModule],
      { stores: ['redis', 'cassandra'] },
    );
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
    seeds = app.get(SeedsService);
    llm = app.get(LLM_PROVIDER);
    redis = app.get(RedisService);
    config = app.get(ApiConfigService) as MockApiConfigService;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    llm.reset();
    config.reset();
  });

  const user = async () => {
    const created = await app
      .get<typeof User>(getModelToken(User))
      .create({ email: `a-${v4()}@mail.com` });
    const { bearer } = await issueSession(app, created);
    expect(bearer).toMatch(/^Bearer /);
    return {
      id: created.id,
      auth: { Authorization: bearer },
    };
  };

  const conversation = async (u: { auth: Record<string, string> }) =>
    (
      await http()
        .post('/api/assistant/conversations')
        .set(u.auth)
        .send({})
        .expect(201)
    ).body.id as string;

  const ask = (
    u: { auth: Record<string, string> },
    conversationId: string,
    body: object,
    opts: { count?: number; timeoutMs?: number } = {},
  ) =>
    readSse(`${baseUrl}/assistant/conversations/${conversationId}/messages`, {
      method: 'POST',
      body,
      headers: u.auth,
      count: opts.count ?? 1_000,
      until: TERMINAL,
      timeoutMs: opts.timeoutMs ?? 10_000,
    });

  it('streams the reply in order (meta → text… → done) and persists the turn', async () => {
    const u = await user();
    const c = await conversation(u);
    llm.script({
      text: 'The Pixel 10 has the best camera under €800.',
      chunks: 6,
    });

    const { status, events } = await ask(u, c, {
      text: 'Best camera phone under 800?',
    });

    expect(status).toBe(200);
    expect(events[0].event).toBe('meta');
    expect(events.at(-1)!.event).toBe('done');
    expect(textOf(events)).toBe('The Pixel 10 has the best camera under €800.');
    // Every event carries a stream id, strictly increasing: what Last-Event-ID resumes from.
    const ids = events.map((e) => e.id!);
    expect([...ids].sort(compareStreamIds)).toEqual(ids);

    const history = (
      await http()
        .get(`/api/assistant/conversations/${c}/messages`)
        .set(u.auth)
        .expect(200)
    ).body;
    expect(
      history.messages.map((m: { role: string; text: string }) => [
        m.role,
        m.text,
      ]),
    ).toEqual([
      ['user', 'Best camera phone under 800?'],
      ['assistant', 'The Pixel 10 has the best camera under €800.'],
    ]);
  });

  it('tool loop: product_details runs against the catalogue, its result goes back in one user message, then the model answers', async () => {
    const u = await user();
    const c = await conversation(u);
    const [product] = await seeds.createTreelike([
      {
        __type__: TableName.Product,
        title: 'Pixel 10 Pro',
        price: 79_900,
        quantity: 3,
      },
    ]);
    llm.script(
      {
        toolUses: [
          { name: 'product_details', input: { product_id: product.id } },
          {
            name: 'pickup_near_me',
            input: { query: 'pixel', radius_km: null },
          },
        ],
      },
      { text: 'Pixel 10 Pro is €799 and in stock.' },
    );

    const { events } = await ask(u, c, { text: 'Tell me about it' });

    expect(
      events
        .filter((e) => e.event === 'tool')
        .map((e) => [data(e).name, data(e).status]),
    ).toEqual(
      expect.arrayContaining([
        ['product_details', 'running'],
        ['product_details', 'done'],
        ['pickup_near_me', 'failed'],
      ]),
    );
    expect(events.at(-1)!.event).toBe('done');

    const second = llm.requests[1].messages;
    const toolResults = second.at(-1)!;
    expect(toolResults.role).toBe('user');
    const blocks = toolResults.content as {
      type: string;
      content: string;
      is_error?: boolean;
    }[];
    expect(blocks.map((b) => b.type)).toEqual(['tool_result', 'tool_result']);
    expect(JSON.parse(blocks[0].content)).toMatchObject({
      id: product.id,
      title: 'Pixel 10 Pro',
      inStock: true,
    });
    // No location in the request → the tool refuses instead of guessing where the user is.
    expect(blocks[1]).toMatchObject({
      is_error: true,
      content: 'The user has not shared a location.',
    });
  });

  it('malformed tool input is returned as an error tool_result, never executed', async () => {
    const u = await user();
    const c = await conversation(u);
    llm.script(
      {
        toolUses: [
          { name: 'product_details', input: { product_id: 'not-a-uuid' } },
        ],
      },
      { text: 'Sorry.' },
    );

    await ask(u, c, { text: 'x' });

    const result = (
      llm.requests[1].messages.at(-1)!.content as {
        content: string;
        is_error: boolean;
      }[]
    )[0];
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content)).toHaveProperty('INVALID_INPUT');
  });

  it('the next turn replays the history byte-identically (append-only: cache prefix + thinking blocks stay valid); system and tools never change', async () => {
    const u = await user();
    const c = await conversation(u);
    const [product] = await seeds.createTreelike([
      { __type__: TableName.Product, title: 'Kindle' },
    ]);
    llm.script(
      {
        toolUses: [
          { name: 'product_details', input: { product_id: product.id } },
        ],
      },
      { text: 'It is a Kindle.' },
      { text: 'Yes, it is waterproof.' },
    );

    await ask(u, c, { text: 'What is it?' });
    await ask(u, c, { text: 'Waterproof?' });

    const [first, second, third] = llm.requests;
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    expect(
      third.messages.slice(0, second.messages.length + 1).map((m) => m.role),
    ).toEqual([...second.messages.map((m) => m.role), 'assistant']);
    expect(
      JSON.stringify(third.messages.slice(0, second.messages.length)),
    ).toBe(JSON.stringify(second.messages));
    for (const r of [second, third]) {
      expect(JSON.stringify(r.system)).toBe(JSON.stringify(first.system));
      expect(JSON.stringify(r.tools)).toBe(JSON.stringify(first.tools));
    }
  });

  it('client disconnect aborts the provider call after the grace period and frees the conversation', async () => {
    config.set('assistant_detach_grace_ms', 500);
    const u = await user();
    const c = await conversation(u);
    llm.script({ text: 'Let me think', hang: true, delayMs: 20 });

    await ask(u, c, { text: 'long answer please' }, { count: 3 }); // reads 3 events, then hangs up

    await waitFor(async () => llm.aborted === 1, {
      description: 'provider call aborted',
      timeoutMs: 5_000,
    });
    llm.script({ text: 'ok' });
    const next = await waitFor(
      async () => {
        const r = await ask(u, c, { text: 'again' });
        return r.status === 200 && r;
      },
      { description: 'turn lock released' },
    );
    expect(next.events.at(-1)!.event).toBe('done');
    // The aborted partial answer is not part of the history.
    const history = (
      await http()
        .get(`/api/assistant/conversations/${c}/messages`)
        .set(u.auth)
        .expect(200)
    ).body;
    expect(
      history.messages
        .filter((m: { role: string }) => m.role === 'assistant')
        .map((m: { text: string }) => m.text),
    ).toEqual(['ok']);
  });

  it('reconnect with Last-Event-ID resumes without gaps or duplicates; the stop button cancels', async () => {
    config.set('assistant_detach_grace_ms', 5_000);
    const u = await user();
    const c = await conversation(u);
    llm.script({ text: 'abcdefghij', chunks: 10, delayMs: 30, hang: true });

    const first = await ask(u, c, { text: 'go' }, { count: 4 });
    const messageId = data(first.events[0]).messageId as string;
    const lastId = first.events.at(-1)!.id!;

    const resumed = readSse(
      `${baseUrl}/assistant/messages/${messageId}/stream`,
      {
        headers: { ...u.auth, 'last-event-id': lastId },
        count: 1_000,
        until: TERMINAL,
        timeoutMs: 8_000,
      },
    );
    await new Promise((r) => setTimeout(r, 600));
    await http()
      .post(`/api/assistant/messages/${messageId}/cancel`)
      .set(u.auth)
      .expect(202);
    const { events } = await resumed;

    const all = [...first.events, ...events];
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect(textOf(all).startsWith('abcdefghij')).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: 'error' });
    expect(data(events.at(-1)!)).toEqual({ code: 'CANCELLED' });
    expect(llm.aborted).toBe(1);
  });

  it('isolation: another user gets 404 for the conversation and 403 for the generation stream', async () => {
    const [alice, bob] = [await user(), await user()];
    const c = await conversation(alice);
    llm.script({ text: 'hi' });
    const { events } = await ask(alice, c, { text: 'hello' });
    const messageId = data(events[0]).messageId;

    expect((await ask(bob, c, { text: 'hello' })).status).toBe(404);
    await http()
      .get(`/api/assistant/conversations/${c}/messages`)
      .set(bob.auth)
      .expect(404);
    expect(
      (
        await readSse(`${baseUrl}/assistant/messages/${messageId}/stream`, {
          headers: bob.auth,
          count: 1,
        })
      ).status,
    ).toBe(403);
    await http()
      .post(`/api/assistant/messages/${messageId}/cancel`)
      .set(bob.auth)
      .expect(403);
  });

  it('one reply at a time per conversation: a second message while generating is 409', async () => {
    config.set('assistant_detach_grace_ms', 5_000);
    const u = await user();
    const c = await conversation(u);
    llm.script({ text: 'slow', hang: true });

    const first = await ask(u, c, { text: 'one' }, { count: 2 });
    const second = await ask(u, c, { text: 'two' });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('assistant_turn_in_progress');
    await http()
      .post(`/api/assistant/messages/${data(first.events[0]).messageId}/cancel`)
      .set(u.auth)
      .expect(202);
  });

  it('monthly allowance used up → 429 before the provider is called; usage is charged per turn', async () => {
    const u = await user();
    const c = await conversation(u);
    llm.script({ text: 'answer' });
    await ask(u, c, { text: 'q' });
    const usage = (
      await http().get('/api/assistant/usage').set(u.auth).expect(200)
    ).body;
    expect(usage.used).toBeGreaterThan(0);

    const month = `${new Date().getUTCFullYear()}${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    await redis.client.set(
      `assistant:tokens:{${u.id}}:${month}`,
      String(usage.allowance),
    );
    const calls = llm.requests.length;

    const res = await ask(u, c, { text: 'q2' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('assistant_quota_exceeded');
    expect(llm.requests.length).toBe(calls);
  });

  it('requests per minute per user are limited (llm.messages policy)', async () => {
    const u = await user();
    const c = await conversation(u);
    let limited: number | undefined;
    for (let i = 0; i < 25 && !limited; i++) {
      llm.script({ text: `a${i}` });
      const r = await ask(u, c, { text: `q${i}` });
      if (r.status === 429) limited = i;
    }
    expect(limited).toBe(20);
  });

  it('refusal: a refusal event, and the declined output never enters the history', async () => {
    const u = await user();
    const c = await conversation(u);
    llm.script({ text: '', stopReason: 'refusal' });

    const { events } = await ask(u, c, { text: 'something disallowed' });

    expect(events.at(-1)).toMatchObject({ event: 'refusal' });
    const history = (
      await http()
        .get(`/api/assistant/conversations/${c}/messages`)
        .set(u.auth)
        .expect(200)
    ).body;
    expect(history.messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
    ]);
  });

  it('primary model overloaded before the first token → the fallback model answers', async () => {
    const u = await user();
    const c = await conversation(u);
    llm.script({ unavailable: true }, { text: 'from the fallback' });

    const { events } = await ask(u, c, { text: 'hi' });

    expect(textOf(events)).toBe('from the fallback');
    expect(llm.requests.map((r) => r.model)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ]);
  });

  it('tool loop is bounded: the 5th round runs with tools disabled', async () => {
    const u = await user();
    const c = await conversation(u);
    const search = {
      name: 'search_products',
      input: { query: 'x', max_price: null, category: null, limit: null },
    };
    llm.script(...Array.from({ length: 4 }, () => ({ toolUses: [search] })), {
      text: 'Here is what I found.',
    });

    const { events } = await ask(u, c, { text: 'find everything' });

    expect(events.at(-1)!.event).toBe('done');
    expect(llm.requests.map((r) => !!r.toolsDisabled)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('a long conversation is compacted into ONE summary at the start of a turn; nothing before it is replayed again', async () => {
    const u = await user();
    const c = await conversation(u);
    const store = app.get(ConversationStore);
    const filler = 'x'.repeat(30_000);
    for (let i = 0; i < 10; i++) {
      await store.append(c, types.TimeUuid.now().toString(), [
        {
          role: 'user',
          content: [{ type: 'text', text: `question ${i} ${filler}` }],
        },
        { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] },
      ]);
    }
    llm.script(
      { text: 'Shopper wants a phone under €800.' },
      { text: 'Sure.' },
    );

    const { events } = await ask(u, c, { text: 'and cases?' });

    expect(events.at(-1)!.event).toBe('done');
    const [summaryCall, chat] = llm.requests;
    expect(summaryCall.model).toBe('claude-haiku-4-5');
    expect(chat.messages).toHaveLength(2);
    expect(JSON.stringify(chat.messages[0])).toContain(
      '<conversation_summary>\\nShopper wants a phone under €800.',
    );
    expect(JSON.stringify(chat.messages[1])).toContain('and cases?');

    // Next turn: summary + post-compaction turns only.
    llm.script({ text: 'Yes.' });
    await ask(u, c, { text: 'more?' });
    expect(llm.requests[2].messages.slice(0, 3)).toEqual([
      ...chat.messages,
      expect.objectContaining({ role: 'assistant' }),
    ]);
  });
});
