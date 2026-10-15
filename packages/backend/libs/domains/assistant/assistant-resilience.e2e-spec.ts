import { CLOCK, FakeClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  bootAssistant,
  data,
  textOf,
  type Harness,
  type TestUser,
} from './testing/assistant.harness';

type Row = Record<string, string | number | boolean | null>;

describe('Shopping assistant: fallback model, breaker, timeouts', () => {
  let h: Harness;
  const clock = new FakeClock();

  beforeAll(async () => {
    h = await bootAssistant({
      customize: (b) => b.overrideProvider(CLOCK).useValue(clock),
    });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    clock.set(new Date());
  });

  const primary = () => h.config.get('assistant_model');
  const fallback = () => h.config.get('assistant_fallback_model');
  const models = () => h.llm.requests.map((r) => r.model);
  const messageId = (events: { data?: string }[]) =>
    JSON.parse(events[0].data!).messageId as string;
  const record = async (m: string, n: number): Promise<Row> => {
    const rows = await waitFor(
      async () => {
        const found = await outboxRowsFor(h.app, `${m}:${n}`);
        return found.length ? found : null;
      },
      { description: `record ${m}:${n}` },
    );
    const payload = rows[0].payload as { payload?: Row };
    return (payload.payload ?? payload) as Row;
  };
  const openState = (model: string) =>
    MetricsRegistry.value('assistant_breaker_state', { model, state: 'open' });
  const turn = async (
    u: TestUser,
    ...scripts: Parameters<Harness['llm']['script']>
  ) => {
    const c = await h.conversation(u);
    h.llm.script(...scripts);
    return h.ask(u, c, { text: 'hello' });
  };
  const failPrimary = () => ({ model: primary(), unavailable: true as const });
  const answerFallback = (text = 'from the fallback') => ({
    model: fallback(),
    text,
  });
  const noHold = async (u: TestUser) =>
    expect(await h.admission.slotMembers(u.id)).toEqual([]);

  it('S46 AS-38: a provider 429 with Retry-After cools the model down for every turn', async () => {
    const u = await h.user();
    h.llm.script(
      { model: primary(), rateLimited: { retryAfterMs: 600 } },
      answerFallback('first'),
    );
    const c = await h.conversation(u);
    const first = await h.ask(u, c, { text: 'one' });
    expect(first.events.at(-1)!.event).toBe('done');
    expect(models()).toEqual([primary(), fallback()]);
    const remaining = await h.admission.cooldownRemainingMs(primary());
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(600);

    // during the cooldown a new turn goes straight to the fallback without calling the primary
    h.llm.script(answerFallback('second'));
    const second = await h.ask(u, c, { text: 'two' });
    expect(textOf(second.events)).toBe('second');
    expect(models()).toEqual([primary(), fallback(), fallback()]);

    await waitFor(
      async () => (await h.admission.cooldownRemainingMs(primary())) === 0,
      { description: 'cooldown over' },
    );
    h.llm.script({ model: primary(), text: 'primary again' });
    const third = await h.ask(u, c, { text: 'three' });
    expect(textOf(third.events)).toBe('primary again');
    expect(models().at(-1)).toBe(primary());
  });

  it('S46 AS-38: a 429 without Retry-After cools the model for 5 seconds', async () => {
    const u = await h.user();
    await turn(
      u,
      { model: primary(), rateLimited: { retryAfterMs: null } },
      answerFallback(),
    );
    const remaining = await h.admission.cooldownRemainingMs(primary());
    expect(remaining).toBeGreaterThan(3_000);
    expect(remaining).toBeLessThanOrEqual(5_000);
  });

  it('S46 AS-43: the primary overloaded before the first token → the fallback answers; two records', async () => {
    const u = await h.user();
    const res = await turn(u, failPrimary(), answerFallback('fallback answer'));

    expect(res.events.at(-1)!.event).toBe('done');
    expect(textOf(res.events)).toBe('fallback answer');
    expect(models()).toEqual([primary(), fallback()]);
    const m = messageId(res.events);
    const failed = await record(m, 1);
    expect(failed).toMatchObject({
      outcome: 'failed',
      billableTokens: 0,
      model: primary(),
      requestedModel: primary(),
    });
    const answered = await record(m, 2);
    expect(answered).toMatchObject({
      outcome: 'completed',
      requestedModel: primary(),
      model: fallback(),
    });
    expect(answered.billableTokens).toBeGreaterThan(0);
  });

  it('S46 AS-44: a failure after the first token ends PROVIDER_UNAVAILABLE with no fallback', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.llm.script(
      { model: primary(), text: 'partial', failAfterText: true },
      answerFallback(),
    );

    const res = await h.ask(u, c, { text: 'hello' });

    expect(res.events.at(-1)!.event).toBe('error');
    expect(data(res.events.at(-1)!).code).toBe('PROVIDER_UNAVAILABLE');
    expect(models()).toEqual([primary()]);
    expect(await h.repository.messages(u.id, c)).toHaveLength(0);
    expect(await h.admission.lockHolder(u.id, c)).toBeNull();
    await noHold(u);
  });

  it('S46 AS-45: both models failing → PROVIDER_UNAVAILABLE after exactly two attempts, without a provider message', async () => {
    const u = await h.user();
    const res = await turn(u, failPrimary(), {
      model: fallback(),
      unavailable: true,
    });

    const last = res.events.at(-1)!;
    expect(last.event).toBe('error');
    expect(
      Object.keys(data(last)).every((k) =>
        ['code', 'retryAfterMs'].includes(k),
      ),
    ).toBe(true);
    expect(data(last).code).toBe('PROVIDER_UNAVAILABLE');
    expect(models()).toEqual([primary(), fallback()]);
    expect(last.data).not.toContain('scripted');
  });

  describe('S46 AS-46: the circuit breaker of a model', () => {
    const failedTurn = (u: TestUser) =>
      turn(u, failPrimary(), answerFallback());

    it('five consecutive failures open the primary: zero primary calls; one half-open probe closes or reopens it', async () => {
      const u = await h.user();
      for (let i = 0; i < 5; i++) await failedTurn(u);
      expect(models().filter((m) => m === primary())).toHaveLength(5);
      expect(openState(primary())).toBe(1);

      const skipped = await turn(u, answerFallback('while open'));
      expect(textOf(skipped.events)).toBe('while open');
      expect(models().filter((m) => m === primary())).toHaveLength(5);

      // after the cooldown one probe goes to the primary; a failing probe reopens the breaker for another cooldown
      clock.advance(30_000);
      await failedTurn(u);
      expect(models().filter((m) => m === primary())).toHaveLength(6);
      expect(openState(primary())).toBe(1);
      await turn(u, answerFallback());
      expect(models().filter((m) => m === primary())).toHaveLength(6);

      // a successful probe closes it: the primary answers again
      clock.advance(30_000);
      const probe = await turn(u, {
        model: primary(),
        text: 'primary is back',
      });
      expect(textOf(probe.events)).toBe('primary is back');
      expect(openState(primary())).toBe(0);
      const after = await turn(u, { model: primary(), text: 'and again' });
      expect(textOf(after.events)).toBe('and again');
    });

    it('while half-open, concurrent turns do not all probe: exactly one does', async () => {
      const u = await h.user();
      for (let i = 0; i < 5; i++) await failedTurn(u);
      clock.advance(30_000);
      const before = models().filter((m) => m === primary()).length;
      const conversations = await Promise.all(
        [1, 2, 3].map(() => h.conversation(u)),
      );
      h.llm.script(
        { model: primary(), text: 'probe', delayMs: 400 },
        answerFallback('f1'),
        answerFallback('f2'),
      );

      const results = await Promise.all(
        conversations.map((c) => h.ask(u, c, { text: 'go' })),
      );

      expect(results.every((r) => r.events.at(-1)!.event === 'done')).toBe(
        true,
      );
      expect(models().filter((m) => m === primary()).length - before).toBe(1);
    });

    it('a success resets the count: 4 + success + 4 failures leave it closed', async () => {
      const u = await h.user();
      for (let i = 0; i < 4; i++) await failedTurn(u);
      await turn(u, { model: primary(), text: 'ok' });
      for (let i = 0; i < 4; i++) await failedTurn(u);
      expect(openState(primary())).toBe(0);
      const next = await turn(u, {
        model: primary(),
        text: 'still the primary',
      });
      expect(textOf(next.events)).toBe('still the primary');
    });

    it('a user abort does not count as a failure', async () => {
      const u = await h.user();
      for (let i = 0; i < 4; i++) await failedTurn(u);
      for (let i = 0; i < 3; i++) {
        const c = await h.conversation(u);
        h.llm.script({ model: primary(), text: 'x', hang: true, delayMs: 20 });
        const first = await h.ask(u, c, { text: 'go' }, { count: 2 });
        const m = messageId(first.events);
        await h.http().post(`/api/assistant/messages/${m}/cancel`).set(u.auth);
        await waitFor(
          async () => (await h.generations.meta(u.id, m))?.state === 'error',
          { description: 'cancelled' },
        );
      }
      expect(openState(primary())).toBe(0);
    });
  });

  it('S46 AS-47: both breakers open → 503 assistant_unavailable with Retry-After, no side effect', async () => {
    const u = await h.user();
    // a reply that is already running is unaffected
    const runningConversation = await h.conversation(u);
    h.llm.script({
      model: primary(),
      text: 'running',
      hang: true,
      delayMs: 20,
    });
    const running = await h.ask(
      u,
      runningConversation,
      { text: 'go' },
      { count: 2 },
    );
    h.config.set('assistant_detach_grace_ms', 60_000);

    for (let i = 0; i < 5; i++)
      await turn(
        u,
        { model: primary(), unavailable: true },
        { model: fallback(), unavailable: true },
      );
    expect(openState(primary())).toBe(1);
    expect(openState(fallback())).toBe(1);
    const requestsBefore = h.llm.requests.length;

    const c = await h.conversation(u);
    const res = await h.ask(u, c, { text: 'hello' });
    expect([res.status, res.body.code]).toEqual([503, 'assistant_unavailable']);
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
    expect(h.llm.requests).toHaveLength(requestsBefore);
    expect(await h.repository.messages(u.id, c)).toHaveLength(0);
    expect(await h.admission.lockHolder(u.id, c)).toBeNull();
    expect(await h.admission.slotMembers(u.id)).toHaveLength(1);

    const m = messageId(running.events);
    expect((await h.generations.meta(u.id, m))?.state).toBe('running');
    await h.http().post(`/api/assistant/messages/${m}/cancel`).set(u.auth);
  });

  it('S46 AS-48: 400/401 answers are not retried, not fallen back, and not counted by the breaker', async () => {
    const u = await h.user();
    const before =
      MetricsRegistry.value('assistant_provider_errors_total', {
        kind: 'rejected',
      }) ?? 0;
    for (let i = 0; i < 5; i++) {
      const res = await turn(
        u,
        { model: primary(), rejected: true },
        answerFallback(),
      );
      expect(data(res.events.at(-1)!)).toEqual({ code: 'INTERNAL' });
    }
    expect(models()).toEqual(Array(5).fill(primary()));
    expect(openState(primary())).toBe(0);
    expect(
      MetricsRegistry.value('assistant_provider_errors_total', {
        kind: 'rejected',
      }),
    ).toBe(before + 5);
    const next = await turn(u, {
      model: primary(),
      text: 'primary still used',
    });
    expect(textOf(next.events)).toBe('primary still used');
  });

  describe('S46 AS-49: deadlines', () => {
    it('no first token within the deadline is a transient failure: one fallback attempt', async () => {
      const u = await h.user();
      h.config.set('assistant_first_token_timeout_ms', 300);
      const res = await turn(
        u,
        { model: primary(), text: 'too late', delayMs: 3_000 },
        answerFallback('in time'),
      );
      expect(res.events.at(-1)!.event).toBe('done');
      expect(textOf(res.events)).toBe('in time');
      expect(models()).toEqual([primary(), fallback()]);
      expect(h.llm.aborted).toBe(1);
    });

    it('a call that streams past the whole-call deadline is aborted and reported', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.config.set('assistant_call_timeout_ms', 1_000);
      h.llm.script(
        { model: primary(), text: 'starting', hang: true, delayMs: 20 },
        answerFallback(),
      );
      const res = await h.ask(u, c, { text: 'go' });
      expect(data(res.events.at(-1)!).code).toBe('PROVIDER_UNAVAILABLE');
      expect(models()).toEqual([primary()]);
      expect(await h.repository.messages(u.id, c)).toHaveLength(0);
    });

    it('a turn that outlives the turn deadline aborts everything and ends TURN_TIMEOUT', async () => {
      const u = await h.user();
      const c = await h.conversation(u);
      h.config.set('assistant_turn_timeout_ms', 1_500);
      h.llm.script({
        model: primary(),
        text: 'forever',
        hang: true,
        delayMs: 20,
      });
      const res = await h.ask(u, c, { text: 'go' });
      expect(data(res.events.at(-1)!).code).toBe('TURN_TIMEOUT');
      expect(h.llm.aborted).toBe(1);
      expect(await h.repository.messages(u.id, c)).toHaveLength(0);
      expect(await h.admission.lockHolder(u.id, c)).toBeNull();
      await noHold(u);
    });
  });

  it('S46 AS-51: a provider refusal ends with a refusal event and leaves a valid history', async () => {
    const u = await h.user();
    const c = await h.conversation(u);
    h.llm.script(
      { text: '', stopReason: 'refusal' },
      { text: 'a normal answer' },
    );

    const refused = await h.ask(u, c, { text: 'something unsafe' });
    const last = refused.events.at(-1)!;
    expect(last.event).toBe('refusal');
    expect(data(last)).toEqual({
      category: 'general_harms',
      source: 'provider',
    });
    expect(await h.repository.messages(u.id, c)).toHaveLength(0);
    expect(await h.admission.lockHolder(u.id, c)).toBeNull();
    await noHold(u);
    const m = messageId(refused.events);
    expect(await record(m, 1)).toMatchObject({ outcome: 'refused' });

    const next = await h.ask(u, c, { text: 'something fine' });
    expect(next.events.at(-1)!.event).toBe('done');
    // the next request carries only the new message: the refused turn left no trace
    const sent = h.llm.requests[1].messages;
    expect(sent).toHaveLength(1);
    expect(sent[0].role).toBe('user');
  });
});
