import { types } from 'cassandra-driver';
import { v4 } from 'uuid';
import { assistantUsageSchema } from '@marketplace-sandbox/contracts';
import { FakeClock, CLOCK } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import {
  StoreGuard,
  StoreUnavailableError,
} from '@app/infrastructure/rate-limit/store-guard';
import { waitFor } from '@app/test/utils/async-helpers';
import { inParallel } from '@app/test/utils/async-helpers';
import { QUOTA_COUNTER, type QuotaCounter } from './domain/assistant-ports';
import { monthKey } from './domain/month';
import {
  bootAssistant,
  data,
  type Harness,
  type TestUser,
} from './testing/assistant.harness';

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('Shopping assistant: quotas and limits', () => {
  let h: Harness;
  const clock = new FakeClock();
  let limiter: RateLimiterService;

  beforeAll(async () => {
    h = await bootAssistant({
      customize: (b) => b.overrideProvider(CLOCK).useValue(clock),
    });
    limiter = h.app.get(RateLimiterService);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    clock.set(new Date());
  });

  const usage = async (u: TestUser) =>
    assistantUsageSchema.parse(
      (await h.http().get('/api/assistant/usage').set(u.auth).expect(200)).body,
    );
  const rejected = (reason: string) =>
    MetricsRegistry.value('assistant_admission_rejected_total', { reason }) ??
    0;
  const messageId = (events: { data?: string }[]) =>
    JSON.parse(events[0].data!).messageId as string;
  const noSideEffect = async (u: TestUser, c: string) => {
    expect(h.llm.requests).toHaveLength(0);
    expect(await h.repository.messages(u.id, c)).toHaveLength(0);
  };

  describe('S46 AS-06: admission checks run in the documented order', () => {
    interface Cause {
      apply(u: TestUser, c: string): Promise<void>;
      undo(u: TestUser, c: string): Promise<void>;
    }
    const model = () => h.config.get('assistant_model');
    const causes: Record<string, Cause> = {
      rate: {
        apply: async (u) =>
          void (await limiter.check('llm.messages', u.id, 20)),
        undo: async (u) => limiter.refund('llm.messages', u.id, 20),
      },
      moderation: {
        apply: async () => void (h.moderation.flagInput = () => 'violence'),
        undo: async () => void (h.moderation.flagInput = null),
      },
      size: {
        apply: async (u, c) => {
          for (let i = 0; i < 4; i++)
            await h.repository.appendTurn(
              u.id,
              c,
              types.TimeUuid.now().toString(),
              Array.from({ length: 97 }, () => ({
                role: 'user' as const,
                content: '[]',
                visibleText: '',
                toolNames: [],
              })),
            );
        },
        undo: async (u, c) => void (await h.repository.remove(u.id, c)),
      },
      quota: {
        apply: async () => void (h.entitlements.limit = 0),
        undo: async () => void (h.entitlements.limit = 1_000_000),
      },
      lock: {
        apply: async (u, c) =>
          void (await h.admission.acquireLock(u.id, c, v4(), 60_000)),
        undo: async (u, c) => {
          const holder = await h.admission.lockHolder(u.id, c);
          if (holder) await h.admission.releaseLock(u.id, c, holder);
        },
      },
      slots: {
        apply: async (u) => {
          for (let i = 0; i < 3; i++)
            await h.admission.acquireSlot(u.id, v4(), 3, 60_000);
        },
        undo: async (u) => {
          for (const m of await h.admission.slotMembers(u.id))
            await h.admission.releaseSlot(u.id, m);
        },
      },
      budget: {
        apply: async () =>
          void (await limiter.check('llm.provider.tpm', model(), 2_000_000)),
        undo: async () => h.resetBudget(),
      },
      breakers: {
        apply: async () => {
          await h.admission.setCooldown(
            h.config.get('assistant_model'),
            60_000,
          );
          await h.admission.setCooldown(
            h.config.get('assistant_fallback_model'),
            60_000,
          );
        },
        undo: async () => {
          for (const k of await h.redis.client.keys('assistant:cooldown:*'))
            await h.redis.client.del(k);
        },
      },
    };
    const table: [string[], number, string][] = [
      [['quota', 'lock'], 429, 'quota_exceeded'],
      [['rate', 'moderation'], 429, 'rate_limited'],
      [['moderation', 'size'], 422, 'input_rejected'],
      [['size', 'quota'], 409, 'conversation_full'],
      [['lock', 'slots'], 409, 'turn_in_progress'],
      [['slots', 'budget'], 429, 'too_many_active_turns'],
      [['budget', 'breakers'], 429, 'assistant_busy'],
      [['breakers'], 503, 'assistant_unavailable'],
    ];
    it.each(table)(
      '%j fails with %i %s and leaves nothing behind',
      async (names, status, code) => {
        const u = await h.user();
        const c = await h.conversation(u);
        for (const name of names) await causes[name].apply(u, c);
        const key = v4();

        const res = await h.ask(u, c, { text: 'hello' }, { key });

        expect([res.status, res.body.code]).toEqual([status, code]);
        expect(h.llm.requests).toHaveLength(0);
        // nothing but the causes themselves is held: no slot beyond the arranged ones, no key
        const arranged = names.includes('slots') ? 3 : 0;
        expect(await h.admission.slotMembers(u.id)).toHaveLength(arranged);
        if (!names.includes('lock'))
          expect(await h.admission.lockHolder(u.id, c)).toBeNull();
        for (const name of names) await causes[name].undo(u, c);
        if (names.includes('size')) {
          // the conversation was removed to clear the cause; the key is checked on a fresh one below
          return;
        }
        const retry = await h.ask(u, c, { text: 'hello' }, { key });
        expect(retry.status).toBe(200);
        expect(retry.events.at(-1)!.event).toBe('done');
      },
    );

    it('a foreign conversation with an exhausted allowance is 404', async () => {
      const u = await h.user();
      const v = await h.user();
      const c = await h.conversation(v);
      h.entitlements.limit = 0;
      const res = await h.ask(u, c, { text: 'hello' });
      expect([res.status, res.body.code]).toEqual([404, 'not_found']);
    });

    it('a reused idempotency key on a foreign conversation is 422 before ownership', async () => {
      const u = await h.user();
      const v = await h.user();
      const mine = await h.conversation(u);
      const theirs = await h.conversation(v);
      const key = v4();
      expect(
        (await h.ask(u, mine, { text: 'first' }, { key })).events.at(-1)!.event,
      ).toBe('done');
      const res = await h.ask(u, theirs, { text: 'first' }, { key });
      expect([res.status, res.body.code]).toEqual([
        422,
        'idempotency_key_reuse',
      ]);
    });
  });

  it('S46 AS-32: an exhausted allowance is 429 quota_exceeded with Retry-After; 999 of 1000 is admitted', async () => {
    clock.set(day('2026-10-15'));
    const u = await h.user();
    const c = await h.conversation(u);
    h.entitlements.limit = 1000;
    h.entitlements.billedUsage = 1000;
    const key = v4();

    const res = await h.ask(u, c, { text: 'hello' }, { key });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      code: 'quota_exceeded',
      used: 1000,
      limit: 1000,
      resetsAt: '2026-11-01T00:00:00.000Z',
    });
    const untilNextMonth = Math.ceil(
      (Date.UTC(2026, 10, 1) - day('2026-10-15').getTime()) / 1000,
    );
    expect(res.headers['retry-after']).toBe(String(untilNextMonth));
    await noSideEffect(u, c);
    expect(await h.admission.lockHolder(u.id, c)).toBeNull();
    expect(await h.admission.slotMembers(u.id)).toEqual([]);

    const v = await h.user();
    const c2 = await h.conversation(v);
    h.entitlements.billedUsage = 999;
    const ok = await h.ask(v, c2, { text: 'hello' });
    expect(ok.status).toBe(200);
    expect(ok.events.at(-1)!.event).toBe('done');
  });

  describe('S46 AS-33: the limit comes from billing and billing failing closes the door', () => {
    it('uses the plan limit on every send', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.entitlements.limit = 2_000_000;
      expect((await usage(u)).limit).toBe(2_000_000);
      expect((await h.ask(u, c, { text: 'one' })).status).toBe(200);
      // a plan change takes effect on the next send
      h.entitlements.limit = 10;
      h.entitlements.billedUsage = 0;
      const res = await h.ask(u, c, { text: 'two' });
      expect([res.status, res.body.code, res.body.limit]).toEqual([
        429,
        'quota_exceeded',
        10,
      ]);
    });

    it('unreadable entitlements: 503 assistant_unavailable with Retry-After, no side effect, counted', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.entitlements.failGet = true;
      const before = rejected('entitlements_unavailable');
      const res = await h.ask(u, c, { text: 'hello' });
      expect([res.status, res.body.code]).toEqual([
        503,
        'assistant_unavailable',
      ]);
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(rejected('entitlements_unavailable')).toBe(before + 1);
      await noSideEffect(u, c);
      await h.http().get('/api/assistant/usage').set(u.auth).expect(503);
    });

    it('a cold counter is seeded once from billing usage; unreadable usage is 503', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.entitlements.billedUsage = 700;
      h.llm.script({ text: 'ab', usage: { inputTokens: 10, outputTokens: 5 } });
      expect((await h.ask(u, c, { text: 'one' })).status).toBe(200);
      expect((await usage(u)).used).toBe(715);
      h.llm.script({ text: 'ab', usage: { inputTokens: 10, outputTokens: 5 } });
      expect((await h.ask(u, c, { text: 'two' })).status).toBe(200);
      expect((await usage(u)).used).toBe(730);
      expect(h.entitlements.usageReads).toBe(1);

      const w = await h.user();
      const c2 = await h.conversation(w);
      h.entitlements.failUsage = true;
      const res = await h.ask(w, c2, { text: 'hello' });
      expect([res.status, res.body.code]).toEqual([
        503,
        'assistant_unavailable',
      ]);
    });
  });

  it('S46 AS-34: the allowance month rolls at 00:00 UTC', async () => {
    // the session is issued at the fake instant too, so it is valid on both sides of midnight
    clock.set(new Date('2026-10-31T23:59:59Z'));
    const u = await h.user();
    const c = await h.conversation(u);
    h.entitlements.limit = 1000;
    h.entitlements.billedUsage = 1000;
    const before = await h.ask(u, c, { text: 'hello' });
    expect([
      before.status,
      before.body.code,
      before.headers['retry-after'],
    ]).toEqual([429, 'quota_exceeded', '1']);

    h.entitlements.billedUsage = 0;
    clock.set(new Date('2026-11-01T00:00:00Z'));
    const after = await h.ask(u, c, { text: 'hello' });
    expect(after.status).toBe(200);
    expect(
      await h.redis.client.exists(`assistant:quota:{${u.id}}:202611`),
    ).toBe(1);
    expect(
      await h.redis.client.exists(`assistant:quota:{${u.id}}:202610`),
    ).toBe(1);
    expect(
      await h.redis.client.pttl(`assistant:quota:{${u.id}}:202610`),
    ).toBeGreaterThan(0);
  });

  describe('S46 AS-35: each model call is charged once', () => {
    it('charges every call with the billable formula, once per call id', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.llm.script(
        {
          toolUses: [{ name: 'product_details', input: { product_id: v4() } }],
          usage: {
            inputTokens: 1000,
            cacheWriteTokens: 500,
            outputTokens: 200,
            cacheReadTokens: 1001,
          },
        },
        { text: 'answer!', usage: { inputTokens: 10, outputTokens: 5 } },
      );
      const { events } = await h.ask(u, c, { text: 'go' });
      const m = messageId(events);
      expect(events.at(-1)!.event).toBe('done');

      // 1000 + 500 + 200 + ceil(1001 / 10) = 1801 for the first call, 15 for the second
      expect((await usage(u)).used).toBe(1801 + 15);
      expect(data(events.at(-1)!).allowance.used).toBe(1801 + 15);

      const counter = h.app.get<QuotaCounter>(QUOTA_COUNTER);
      const month = monthKey({
        now: () => clock.now(),
        nowMs: () => clock.nowMs(),
      });
      await counter.charge(u.id, month, `${m}:1`, 1801);
      await counter.charge(u.id, month, `${m}:1`, 1801);
      expect((await usage(u)).used).toBe(1801 + 15);
    });

    it('charges an aborted call an estimate and marks the record', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.llm.script({ text: 'streaming', hang: true, delayMs: 20 });
      const first = await h.ask(u, c, { text: 'go' }, { count: 3 });
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
      await waitFor(
        async () => (await outboxRowsFor(h.app, `${m}:1`)).length > 0,
        { description: 'record written' },
      );

      const [row] = await outboxRowsFor(h.app, `${m}:1`);
      const payload = ((row.payload as { payload?: Record<string, unknown> })
        .payload ?? row.payload) as Record<string, number | boolean | string>;
      expect(payload.outcome).toBe('aborted');
      expect(payload.usageEstimated).toBe(true);
      expect(payload.billableTokens).toBeGreaterThan(0);
      expect((await usage(u)).used).toBe(payload.billableTokens);
    });

    it('charges a refused call its real usage and a call that failed before any answer nothing', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.llm.script({
        text: '',
        stopReason: 'refusal',
        usage: { inputTokens: 40, outputTokens: 2 },
      });
      const refused = await h.ask(u, c, { text: 'go' });
      expect(refused.events.at(-1)!.event).toBe('refusal');
      expect((await usage(u)).used).toBe(42);

      const c2 = await h.conversation(u);
      h.llm.script({ rejected: true });
      const failed = await h.ask(u, c2, { text: 'go' });
      expect(data(failed.events.at(-1)!).code).toBe('INTERNAL');
      expect((await usage(u)).used).toBe(42);
    });
  });

  describe('S46 AS-36: requests per minute', () => {
    it('the 21st message in a minute is 429 rate_limited; another user is unaffected', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      for (let i = 0; i < 20; i++) {
        await h.resetBudget();
        const res = await h.ask(u, c, { text: `message ${i}` });
        expect(res.events.at(-1)!.event).toBe('done');
      }
      const key = v4();
      const res = await h.ask(u, c, { text: 'one too many' }, { key });
      expect([res.status, res.body.code]).toEqual([429, 'rate_limited']);
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(res.headers['ratelimit']).toContain('llm.messages');
      expect(res.headers['ratelimit-policy']).toContain('llm.messages');
      expect(await h.admission.lockHolder(u.id, c)).toBeNull();
      expect(await h.admission.slotMembers(u.id)).toEqual([]);

      const v = await h.user();
      const c2 = await h.conversation(v);
      expect((await h.ask(v, c2, { text: 'hello' })).status).toBe(200);
    });

    it('a limiter store that is down rejects the send (fail closed) and is counted', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      const guard = h.app.get(StoreGuard);
      const down = jest
        .spyOn(guard, 'run')
        .mockRejectedValue(new StoreUnavailableError('error'));
      const before =
        MetricsRegistry.value('rate_limit_store_unavailable_total', {
          policy: 'llm.messages',
          fail_mode: 'closed',
        }) ?? 0;
      try {
        const res = await h.ask(u, c, { text: 'hello' });
        expect([res.status, res.body.code]).toEqual([
          503,
          'rate_limiter_unavailable',
        ]);
      } finally {
        down.mockRestore();
      }
      expect(
        MetricsRegistry.value('rate_limit_store_unavailable_total', {
          policy: 'llm.messages',
          fail_mode: 'closed',
        }) ?? 0,
      ).toBeGreaterThan(before);
      await noSideEffect(u, c);
    });
  });

  describe('S46 AS-37: provider token budget', () => {
    it('an exhausted budget is 429 assistant_busy and releases the lock and slot', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      await limiter.check(
        'llm.provider.tpm',
        h.config.get('assistant_model'),
        2_000_000,
      );
      const res = await h.ask(u, c, { text: 'hello' });
      expect([res.status, res.body.code]).toEqual([429, 'assistant_busy']);
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      await noSideEffect(u, c);
      expect(await h.admission.lockHolder(u.id, c)).toBeNull();
      expect(await h.admission.slotMembers(u.id)).toEqual([]);
    });

    it('a budget limiter that is down fails open, counted', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      const guard = h.app.get(StoreGuard);
      const original = guard.run.bind(guard);
      // the first limiter call (llm.messages) goes through; the second (the provider budget) finds the store down
      const down = jest
        .spyOn(guard, 'run')
        .mockImplementationOnce(original)
        .mockRejectedValue(new StoreUnavailableError('error'));
      const before =
        MetricsRegistry.value('assistant_limiter_fail_open_total', {
          policy: 'llm.provider.tpm',
        }) ?? 0;
      try {
        const res = await h.ask(u, c, { text: 'hello' });
        expect(res.status).toBe(200);
        expect(res.events.at(-1)!.event).toBe('done');
      } finally {
        down.mockRestore();
      }
      expect(
        MetricsRegistry.value('assistant_limiter_fail_open_total', {
          policy: 'llm.provider.tpm',
        }),
      ).toBe(before + 1);
    });
  });

  it('S46 AS-39: four parallel sends accept exactly three; the slots return to zero', async () => {
    const u = await h.user();
    const conversations = await Promise.all(
      [1, 2, 3, 4].map(() => h.conversation(u)),
    );
    h.llm.script(
      ...Array.from({ length: 4 }, () => ({
        text: 'slow reply',
        chunks: 2,
        delayMs: 500,
      })),
    );

    const results = await inParallel(4, (i) =>
      h.ask(u, conversations[i], { text: 'go' }),
    );
    const settled = results.map(
      (r) =>
        (r as PromiseFulfilledResult<Awaited<ReturnType<Harness['ask']>>>)
          .value,
    );

    expect(settled.filter((r) => r.status === 200)).toHaveLength(3);
    const refused = settled.filter((r) => r.status === 429);
    expect(refused).toHaveLength(1);
    expect(refused[0].body.code).toBe('too_many_active_turns');
    expect(Number(refused[0].headers['retry-after'])).toBeGreaterThanOrEqual(1);
    await waitFor(
      async () => (await h.admission.slotMembers(u.id)).length === 0,
      { description: 'slots return to zero' },
    );
    // when one reply ends, a new send is accepted
    const next = await h.ask(u, conversations[3], { text: 'now?' });
    expect(next.status).toBe(200);
  });

  it('S46 AS-40: two sends to one conversation at once give one 200 and one 409', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.llm.script(
      { text: 'only one', chunks: 2, delayMs: 300 },
      { text: 'never used' },
    );

    const settled = (
      await inParallel(2, () => h.ask(u, c, { text: 'go' }))
    ).map(
      (r) =>
        (r as PromiseFulfilledResult<Awaited<ReturnType<Harness['ask']>>>)
          .value,
    );

    expect(settled.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(settled.find((r) => r.status === 409)!.body.code).toBe(
      'turn_in_progress',
    );
    expect(h.llm.requests).toHaveLength(1);
    await waitFor(
      async () => (await h.repository.messages(u.id, c)).length === 2,
      { description: 'one turn persisted' },
    );
    expect(await h.admission.slotMembers(u.id)).toEqual([]);

    h.llm.script({ text: 'hold', hang: true, delayMs: 20 });
    const first = await h.ask(u, c, { text: 'again' }, { count: 1 });
    const busy = await h.ask(u, c, { text: 'while running' });
    expect([busy.status, busy.body.code]).toEqual([409, 'turn_in_progress']);
    await h
      .http()
      .post(`/api/assistant/messages/${messageId(first.events)}/cancel`)
      .set(u.auth);
  });

  describe('S46 AS-41: conversation full', () => {
    const fill = async (u: TestUser, c: string, count: number) => {
      let left = count;
      while (left > 0) {
        const n = Math.min(left, 97);
        await h.repository.appendTurn(
          u.id,
          c,
          types.TimeUuid.now().toString(),
          Array.from({ length: n }, () => ({
            role: 'user' as const,
            content: JSON.stringify([{ type: 'text', text: 'm' }]),
            visibleText: 'm',
            toolNames: [],
          })),
        );
        left -= n;
      }
    };

    it('388 stored messages are refused, 387 accepted', async () => {
      const u = await h.user();
      const full = await h.conversation(u);
      await fill(u, full, 388);
      const res = await h.ask(u, full, { text: 'one more' });
      expect([res.status, res.body.code]).toEqual([409, 'conversation_full']);
      expect(h.llm.requests).toHaveLength(0);
      expect(await h.admission.lockHolder(u.id, full)).toBeNull();
      const history = await h
        .http()
        .get(`/api/assistant/conversations/${full}/messages`)
        .set(u.auth)
        .expect(200);
      expect(history.body.messages).toHaveLength(388);

      const almost = await h.conversation(u);
      await fill(u, almost, 387);
      const ok = await h.ask(u, almost, { text: 'one more' });
      expect(ok.status).toBe(200);
      expect(ok.events.at(-1)!.event).toBe('done');
    });
  });

  it('S46 AS-42: GET /assistant/usage reads the admission counter and limit for the caller only', async () => {
    clock.set(day('2026-10-15'));
    const u = await h.user();
    const c = await h.conversation(u);
    h.entitlements.limit = 5000;
    h.llm.script({ text: 'abcd', usage: { inputTokens: 20, outputTokens: 4 } });
    await h.ask(u, c, { text: 'go' });

    const body = await usage(u);
    expect(body).toEqual({
      used: 24,
      limit: 5000,
      resetsAt: '2026-11-01T00:00:00.000Z',
    });
    const other = await h.user();
    const res = await h
      .http()
      .get(`/api/assistant/usage?userId=${u.id}`)
      .set(other.auth)
      .expect(200);
    expect(res.body.used).toBe(0);
  });
});
