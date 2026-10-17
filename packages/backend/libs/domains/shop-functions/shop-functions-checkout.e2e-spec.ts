import { v4 as uuidv4 } from 'uuid';
import { shopFunctionSchema } from '@marketplace-sandbox/contracts';
import { ShopFunctionsConfig } from './application/shop-functions.config';
import { RedisActiveSetCache } from './infra/redis-active-set.cache';
import { PgFunctionRepository } from './infra/pg-function.repository';
import { SANDBOX, type Sandbox } from './domain/ports';
import {
  ALLOCATE_SOURCE,
  EMPTY_SOURCE,
  GOOD_SOURCE,
  INVALID_OUTPUT_SOURCE,
  LOOP_SOURCE,
  THROW_SOURCE,
  cartOf,
  createFunctionsApp,
  fixedPerUnitSource,
  percentSource,
  T0,
  type FunctionsTestApp,
  type SeededShop,
} from './testing/function-fixtures';
import type { EvaluationOutcome } from './application/shop-functions.metrics';

const OUTCOMES: EvaluationOutcome[] = [
  'applied',
  'no_discount',
  'timeout',
  'memory',
  'runtime',
  'invalid_output',
  'breaker_open',
  'not_entitled',
  'entitlement_unavailable',
  'definitions_unavailable',
  'budget_exceeded',
  'invalid_cart',
];

describe('Shop functions: evaluation at checkout (fail-safe)', () => {
  let t: FunctionsTestApp;
  let A: SeededShop;
  let sandboxRuns: jest.SpyInstance;
  let realRun: Sandbox['run'];

  beforeAll(async () => {
    t = await createFunctionsApp();
    const sandbox = t.app.get<Sandbox>(SANDBOX, { strict: false });
    realRun = sandbox.run.bind(sandbox);
    sandboxRuns = jest.spyOn(sandbox, 'run');
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    sandboxRuns.mockClear();
    sandboxRuns.mockImplementation(realRun as never);
    A = await t.seedShop();
  });

  /** Counts of every outcome since the call, for the spec's `since()`. */
  const snapshot = () =>
    Object.fromEntries(
      OUTCOMES.map((o) => [o, t.metrics.evaluation(o)]),
    ) as Record<EvaluationOutcome, number>;
  const since = (before: Record<EvaluationOutcome, number>) =>
    Object.fromEntries(
      OUTCOMES.map((o) => [o, t.metrics.evaluation(o) - before[o]]).filter(
        ([, n]) => n !== 0,
      ),
    );
  const functionDto = async (fn: string) =>
    shopFunctionSchema.parse(
      (await t.as(A.admin).get(t.route(A.shopId, `/${fn}`))).body,
    );
  const amount = (shopId: string, discountMinor: number) => ({
    shopId,
    discountMinor,
  });

  it("S45 AS-24: a two-shop cart gets exactly the first shop's discount and nothing is written", async () => {
    const S2 = await t.seedShop();
    await t.seedActive(A.shopId, { source: GOOD_SOURCE });
    const cart = {
      currency: 'EUR',
      lines: [
        {
          productId: 'a',
          shopId: A.shopId,
          category: 'cases',
          quantity: 3,
          unitPriceMinor: 1200,
        },
        {
          productId: 'b',
          shopId: A.shopId,
          category: 'bottles',
          quantity: 1,
          unitPriceMinor: 500,
        },
        {
          productId: 'c',
          shopId: S2.shopId,
          category: 'cases',
          quantity: 3,
          unitPriceMinor: 1200,
        },
      ],
    };
    const tables = async () =>
      t.pg(
        `SELECT (SELECT COUNT(*) FROM "ShopFunction") AS f, (SELECT COUNT(*) FROM "ShopFunctionVersion") AS v,
                (SELECT COUNT(*) FROM "ShopFunctionVersionHistory") AS h, (SELECT COUNT(*) FROM "ShopFunctionTestCase") AS c,
                (SELECT COUNT(*) FROM "Outbox") AS o`,
      );
    const before = await tables();
    const metrics = snapshot();

    const result = await t.evaluate(cart);

    expect(result).toEqual({ shopDiscounts: [amount(A.shopId, 600)] });
    expect(await tables()).toEqual(before);
    expect(since(metrics)).toEqual({ applied: 1 });
  });

  it("S45 AS-25: a function sees only its own shop's lines, with no shop id, user or personal data", async () => {
    const S2 = await t.seedShop();
    const source = `function run(input) {
      var ok = Object.keys(input).sort().join() === 'currency,lines' && input.currency === 'EUR' &&
        input.lines.every(function (l) { return Object.keys(l).sort().join() === 'category,productId,quantity,unitPriceMinor'; });
      if (!ok) throw new Error('unexpected input shape');
      return { discounts: [{ lineIndex: 0, type: 'fixedPerUnit', value: input.lines.length * 100, message: 'x' }] };
    }`;
    await t.seedActive(A.shopId, { source });
    await t.seedActive(S2.shopId, { source });
    const line = (shopId: string, productId: string, quantity: number) => ({
      productId,
      shopId,
      category: 'c',
      quantity,
      unitPriceMinor: 1000,
    });

    const result = await t.evaluate({
      currency: 'EUR',
      lines: [
        line(A.shopId, 'a1', 2),
        line(A.shopId, 'a2', 1),
        line(S2.shopId, 's1', 1),
        line(S2.shopId, 's2', 1),
        line(S2.shopId, 's3', 1),
      ],
    });

    // S1 saw 2 lines (2 x 100 x quantity 2), S2 saw 3 (3 x 100 x quantity 1): neither saw the other's lines
    expect(result.shopDiscounts).toEqual([
      amount(A.shopId, 400),
      amount(S2.shopId, 300),
    ]);
  });

  it('S45 AS-27: the largest discount per line wins, in any order, and a failing function leaves the other', async () => {
    const cart = cartOf(A.shopId, 2, 1000);
    const f1 = await t.seedActive(A.shopId, {
      name: 'a-ten-percent',
      source: percentSource(10),
    });
    await t.seedActive(A.shopId, {
      name: 'b-fifty-fixed',
      source: fixedPerUnitSource(50),
    });
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 200),
    ]);

    const B = await t.seedShop();
    await t.seedActive(B.shopId, {
      name: 'a-fifty-fixed',
      source: fixedPerUnitSource(50),
    });
    await t.seedActive(B.shopId, {
      name: 'b-ten-percent',
      source: percentSource(10),
    });
    expect((await t.evaluate(cartOf(B.shopId, 2, 1000))).shopDiscounts).toEqual(
      [amount(B.shopId, 200)],
    );

    await t.pg(
      `UPDATE "ShopFunctionVersion" SET "source" = :source WHERE "functionId" = :fn`,
      { source: THROW_SOURCE, fn: f1.functionId },
    );
    await t.redis.del(`shopfn:active:${A.shopId}`);
    for (const memo of await t.keys('shopfn:memo:*'))
      await t.redis.del(memo.key); // the memo is keyed by version, not by edited source
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 100),
    ]);
  });

  describe('S45 AS-28: fail-safe, every failure class', () => {
    it.each<[string, string, EvaluationOutcome]>([
      ['loops forever', LOOP_SOURCE, 'timeout'],
      ['throws', THROW_SOURCE, 'runtime'],
      ['allocates without end', ALLOCATE_SOURCE, 'memory'],
      ['returns an invalid output', INVALID_OUTPUT_SOURCE, 'invalid_output'],
    ])(
      'a function that %s resolves with no discount and counts %s',
      async (_name, source, outcome) => {
        await t.seedActive(A.shopId, { source });
        // A heap bomb ends when the engine runs out of memory, which takes longer than the 5 ms checkout budget: give it room.
        const config = t.app.get(ShopFunctionsConfig, { strict: false });
        const original = {
          callBudgetMs: config.callBudgetMs,
          functionBudgetMs: config.functionBudgetMs,
        };
        if (outcome === 'memory')
          Object.assign(config, {
            callBudgetMs: 2_000,
            functionBudgetMs: 1_000,
          });
        const metrics = snapshot();
        const started = Date.now();

        const result = await t.evaluate(cartOf(A.shopId));
        Object.assign(config, original);

        expect(result).toEqual({ shopDiscounts: [] });
        expect(Date.now() - started).toBeLessThan(
          outcome === 'memory' ? 2_000 : 500,
        );
        expect(since(metrics)).toEqual({ [outcome]: 1 });
        const warning = t
          .logs()
          .find((l) => l.line.event === 'function_failed');
        expect(warning?.level).toBe('warn');
        expect(JSON.stringify(t.logs())).not.toContain('function run');
      },
    );

    it('an out-of-range line index or a fractional fixedPerUnit in the output is invalid_output', async () => {
      await t.seedActive(A.shopId, { source: fixedPerUnitSource(1.5) });
      const metrics = snapshot();

      expect(await t.evaluate(cartOf(A.shopId))).toEqual({ shopDiscounts: [] });
      expect(since(metrics)).toEqual({ invalid_output: 1 });
    });

    it('an unavailable entitlement lookup gives the shop no discount', async () => {
      await t.seedActive(A.shopId, { source: GOOD_SOURCE });
      t.entitlements.failing = true;
      const metrics = snapshot();

      expect(await t.evaluate(cartOf(A.shopId))).toEqual({ shopDiscounts: [] });
      expect(since(metrics)).toEqual({ entitlement_unavailable: 1 });
      expect(sandboxRuns).not.toHaveBeenCalled();
    });

    it('definitions that cannot be loaded cost only that shop, a failing function costs only itself', async () => {
      const S2 = await t.seedShop();
      await t.seedActive(A.shopId, { source: GOOD_SOURCE });
      await t.seedActive(S2.shopId, { source: GOOD_SOURCE });
      expect((await t.evaluate(cartOf(S2.shopId))).shopDiscounts).toEqual([
        amount(S2.shopId, 600),
      ]); // S2 warm
      const repo = t.app.get(PgFunctionRepository, { strict: false });
      const broken = jest
        .spyOn(repo, 'activeFor')
        .mockRejectedValue(new Error('db down'));
      const metrics = snapshot();

      const both = {
        currency: 'EUR',
        lines: [...cartOf(A.shopId).lines, ...cartOf(S2.shopId).lines],
      };
      const result = await t.evaluate(both);
      broken.mockRestore();

      expect(result.shopDiscounts).toEqual([amount(S2.shopId, 600)]);
      expect(since(metrics)).toEqual({
        definitions_unavailable: 1,
        applied: 1,
      });

      await t.seedActive(S2.shopId, {
        name: 'zz-throws',
        source: THROW_SOURCE,
      });
      await t.redis.del(`shopfn:active:${S2.shopId}`);
      expect((await t.evaluate(both)).shopDiscounts).toEqual([
        amount(A.shopId, 600),
        amount(S2.shopId, 600),
      ]);
    });

    it('a lost, failing or corrupt cache reads the stored definitions and still answers correctly', async () => {
      await t.seedActive(A.shopId, { source: GOOD_SOURCE });
      const expected = { shopDiscounts: [amount(A.shopId, 600)] };
      await t.redis.set(`shopfn:active:${A.shopId}`, 'not json {', 'EX', 60);
      expect(await t.evaluate(cartOf(A.shopId))).toEqual(expected);
      await t.redis.set(
        `shopfn:active:${A.shopId}`,
        JSON.stringify([{ id: 1 }]),
        'EX',
        60,
      );
      expect(await t.evaluate(cartOf(A.shopId))).toEqual(expected);
      await t.redis.del(`shopfn:active:${A.shopId}`);
      expect(await t.evaluate(cartOf(A.shopId))).toEqual(expected);
      const cache = t.app.get(RedisActiveSetCache, { strict: false });
      const failing = jest
        .spyOn(cache, 'getMany')
        .mockRejectedValue(new Error('redis down'));
      expect(await t.evaluate(cartOf(A.shopId))).toEqual(expected);
      failing.mockRestore();
      for (const key of await t.keys('shopfn:memo:*'))
        await t.redis.set(key.key, 'garbage', 'EX', 60);
      expect(await t.evaluate(cartOf(A.shopId))).toEqual(expected);
    });
  });

  describe('S45 AS-29: circuit breaker per function', () => {
    it('opens after five failures in 60 s, is shared through the store, and decides with one trial after 300 s', async () => {
      const { functionId } = await t.seedActive(A.shopId, {
        source: THROW_SOURCE,
      });
      const cart = cartOf(A.shopId);
      const opened = t.metrics.breakerOpened();

      for (let i = 0; i < 5; i++) await t.evaluate(cart);
      expect(sandboxRuns).toHaveBeenCalledTimes(5);
      expect(t.metrics.breakerOpened()).toBe(opened + 1);
      const breaker = (await functionDto(functionId)).breaker;
      expect(breaker.state).toBe('OPEN');
      expect(breaker.openUntil).toBe(
        new Date(T0.getTime() + 300_000).toISOString(),
      );
      expect(breaker.lastFailure).toEqual({
        reason: 'runtime',
        at: T0.toISOString(),
      });

      const metrics = snapshot();
      expect(await t.evaluate(cart)).toEqual({ shopDiscounts: [] });
      expect(sandboxRuns).toHaveBeenCalledTimes(5);
      expect(since(metrics)).toEqual({ breaker_open: 1 });

      t.clock.advance(300_000);
      A.admin = await t.reauth(A.admin); // an access token lasts 5 minutes of the frozen clock
      expect((await functionDto(functionId)).breaker.state).toBe('HALF_OPEN');
      sandboxRuns.mockClear();
      const metrics2 = snapshot();
      await Promise.all(Array.from({ length: 20 }, () => t.evaluate(cart)));
      expect(sandboxRuns).toHaveBeenCalledTimes(1);
      expect(since(metrics2)).toEqual({ runtime: 1, breaker_open: 19 });
      const reopened = (await functionDto(functionId)).breaker;
      expect(reopened.state).toBe('OPEN');
      expect(reopened.openUntil).toBe(
        new Date(T0.getTime() + 600_000).toISOString(),
      );

      // the seller fixes the code; the next trial succeeds and closes the breaker
      await t.pg(
        `UPDATE "ShopFunctionVersion" SET "source" = :source WHERE "functionId" = :functionId`,
        { source: GOOD_SOURCE, functionId },
      );
      await t.redis.del(`shopfn:active:${A.shopId}`);
      t.clock.advance(300_000);
      A.admin = await t.reauth(A.admin);
      expect((await t.evaluate(cart)).shopDiscounts).toEqual([
        amount(A.shopId, 600),
      ]);
      expect((await functionDto(functionId)).breaker.state).toBe('CLOSED');
      expect((await t.evaluate(cart)).shopDiscounts).toEqual([
        amount(A.shopId, 600),
      ]);
    });

    it('four failures, a success and a 61 s pause never open it; losing the state resets to CLOSED', async () => {
      const source = `function run(input) { if (input.lines[0].quantity === 1) throw new Error('no'); return { discounts: [] }; }`;
      const { functionId } = await t.seedActive(A.shopId, { source });
      for (let i = 0; i < 4; i++) await t.evaluate(cartOf(A.shopId, 1));
      await t.evaluate(cartOf(A.shopId, 3));
      t.clock.advance(61_000);
      await t.evaluate(cartOf(A.shopId, 1));
      expect((await functionDto(functionId)).breaker.state).toBe('CLOSED');

      for (let i = 0; i < 4; i++) await t.evaluate(cartOf(A.shopId, 1));
      expect((await functionDto(functionId)).breaker.state).toBe('OPEN');
      await t.redis.del(`shopfn:breaker:${functionId}`);
      expect((await functionDto(functionId)).breaker).toEqual({
        state: 'CLOSED',
        openUntil: null,
        lastFailure: null,
      });
    });

    it('a no_discount answer is not a failure', async () => {
      const { functionId } = await t.seedActive(A.shopId, {
        source: EMPTY_SOURCE,
      });
      for (let i = 0; i < 8; i++) await t.evaluate(cartOf(A.shopId, i + 1));
      expect((await functionDto(functionId)).breaker.state).toBe('CLOSED');
    });
  });

  it('S45 AS-30: results are memoized per version and canonical input for at most 60 s; failures never', async () => {
    const { functionId } = await t.seedActive(A.shopId, {
      source: GOOD_SOURCE,
    });
    const cart = cartOf(A.shopId);

    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 600),
    ]);
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 600),
    ]);
    expect(sandboxRuns).toHaveBeenCalledTimes(1);
    const [memo] = await t.keys(`shopfn:memo:${functionId}:1:*`);
    expect(memo.ttlMs).toBeGreaterThan(0);
    expect(memo.ttlMs).toBeLessThanOrEqual(60_000);

    const line = cart.lines[0];
    const variants = [
      { ...cart, lines: [{ ...line, quantity: 4 }] },
      { ...cart, lines: [{ ...line, unitPriceMinor: 1300 }] },
      { ...cart, lines: [{ ...line, category: 'bottles' }] },
      { ...cart, lines: [{ ...line, productId: 'other' }] },
      { ...cart, currency: 'USD' },
    ];
    for (const variant of variants) await t.evaluate(variant);
    expect(sandboxRuns).toHaveBeenCalledTimes(1 + variants.length);

    await t.redis.del(memo.key);
    sandboxRuns.mockClear();
    await t.evaluate(cart);
    expect(sandboxRuns).toHaveBeenCalledTimes(1);

    const failing = await t.seedActive(A.shopId, {
      name: 'zz-failing',
      source: THROW_SOURCE,
    });
    await t.redis.del(`shopfn:active:${A.shopId}`);
    sandboxRuns.mockClear();
    await t.evaluate(cart);
    await t.evaluate(cart);
    expect(sandboxRuns).toHaveBeenCalledTimes(2); // only the failing function ran again
    expect(await t.keys(`shopfn:memo:${failing.functionId}:*`)).toHaveLength(0);
  });

  it("S45 AS-30: a new version, a rollback or a disable is never answered from an older version's memo", async () => {
    const { functionId } = await t.seedActive(A.shopId, {
      source: percentSource(10),
      version: 3,
    });
    await t.insertVersion(functionId, 2, 'SUPERSEDED', {
      source: percentSource(50),
    });
    const cart = cartOf(A.shopId, 1, 1000);
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 100),
    ]);

    await t
      .as(A.admin)
      .post(t.route(A.shopId, `/${functionId}/versions/2/activate`))
      .expect(200);

    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 500),
    ]);
  });

  describe('S45 AS-31: time budgets', () => {
    it('stops a function at 5 ms and reports a timeout', async () => {
      await t.seedActive(A.shopId, { source: LOOP_SOURCE });
      const metrics = snapshot();
      const started = performance.now();

      await t.evaluate(cartOf(A.shopId));

      expect(performance.now() - started).toBeLessThan(100);
      expect(since(metrics)).toEqual({ timeout: 1 });
    });

    it('ten shops with three looping functions each resolve in under 200 ms', async () => {
      const shops: SeededShop[] = [];
      for (let i = 0; i < 10; i++) {
        const shop = await t.seedShop();
        shops.push(shop);
        for (const name of ['a', 'b', 'c'])
          await t.seedActive(shop.shopId, { name, source: LOOP_SOURCE });
      }
      const cart = {
        currency: 'EUR',
        lines: shops.flatMap((s) => cartOf(s.shopId).lines),
      };
      await t.evaluate(cart); // warm the isolate pool and the caches; the breakers stay closed (3 failures each)
      const started = performance.now();

      const result = await t.evaluate({
        ...cart,
        lines: cart.lines.map((l, i) => ({ ...l, productId: `p${i}` })),
      });

      expect(result).toEqual({ shopDiscounts: [] });
      expect(performance.now() - started).toBeLessThan(200);
    });

    it('a call that would exceed its budget returns the shops that finished and counts budget_exceeded for the rest', async () => {
      const config = t.app.get(ShopFunctionsConfig, { strict: false });
      const original = config.callBudgetMs;
      Object.assign(config, { callBudgetMs: 80 });
      // the looping functions of the nine slow shops answer only after 300 ms, as a loaded runtime would
      sandboxRuns.mockImplementation(async (source, input, timeoutMs) => {
        if (source !== LOOP_SOURCE) return realRun(source, input, timeoutMs);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          ok: false,
          error: 'timeout',
          detail: 'time limit exceeded',
          ms: 300,
        };
      });
      const good = await t.seedShop();
      await t.seedActive(good.shopId, { source: GOOD_SOURCE });
      const slow: SeededShop[] = [];
      for (let i = 0; i < 9; i++) {
        const shop = await t.seedShop();
        slow.push(shop);
        for (const name of ['a', 'b', 'c'])
          await t.seedActive(shop.shopId, { name, source: LOOP_SOURCE });
      }
      const cart = {
        currency: 'EUR',
        lines: [good, ...slow].flatMap((s) => cartOf(s.shopId).lines),
      };
      await t.evaluate(cart); // warm the definitions
      await new Promise((resolve) => setTimeout(resolve, 400)); // let the warm-up's stand-ins end
      sandboxRuns.mockClear();
      const metrics = snapshot();

      const result = await t.evaluate({
        ...cart,
        lines: cart.lines.map((l, i) => ({ ...l, productId: `q${i}` })),
      });
      Object.assign(config, { callBudgetMs: original });
      sandboxRuns.mockImplementation(realRun as never);

      expect(result.shopDiscounts).toEqual([amount(good.shopId, 600)]);
      expect(since(metrics).budget_exceeded).toBe(9);
      // the given-up shops start no further function; let the 300 ms stand-ins that were already running end
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(
        sandboxRuns.mock.calls.filter(([source]) => source === LOOP_SOURCE),
      ).toHaveLength(9);
    });
  });

  it('S45 AS-32: only entitled shops run, in one batch call, and regaining the entitlement applies again', async () => {
    const S2 = await t.seedShop({ entitled: false });
    await t.seedActive(A.shopId, { source: GOOD_SOURCE });
    await t.seedActive(S2.shopId, { source: GOOD_SOURCE });
    const cart = {
      currency: 'EUR',
      lines: [...cartOf(A.shopId).lines, ...cartOf(S2.shopId).lines],
    };
    const metrics = snapshot();

    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 600),
    ]);

    expect(since(metrics)).toEqual({ applied: 1, not_entitled: 1 });
    expect(t.entitlements.batches).toEqual([[A.shopId, S2.shopId]]);
    expect(sandboxRuns).toHaveBeenCalledTimes(1);

    t.entitlements.granted.add(S2.shopId);
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 600),
      amount(S2.shopId, 600),
    ]);
  });

  it('S45 AS-33: a judge activation, a rollback, a disable and a delete show on the very next evaluation', async () => {
    // one case: 1 unit at 1000 gets 10% off; version 2 differs from version 1 only for two or more units
    const suite = [
      {
        name: 'one',
        input: {
          currency: 'EUR',
          lines: [
            {
              productId: 'p1',
              category: 'cases',
              quantity: 1,
              unitPriceMinor: 1000,
            },
          ],
        },
        expected: {
          discounts: [
            { lineIndex: 0, type: 'percentage', value: 10, message: 'm' },
          ],
        },
      },
    ];
    const fn = await t.newFunction(A.admin, A.shopId, 'moving', suite);
    const v1 = `function run(i) { return { discounts: [{ lineIndex: 0, type: 'percentage', value: 10, message: 'm' }] }; }`;
    const v2 = `function run(i) { return { discounts: [{ lineIndex: 0, type: 'percentage', value: i.lines[0].quantity >= 2 ? 50 : 10, message: 'm' }] }; }`;
    await t.submit(A.admin, A.shopId, fn, v1).expect(202);
    const cart = cartOf(A.shopId, 2, 1000);
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([]); // warm: nothing active yet
    expect(await t.keys(`shopfn:active:${A.shopId}`)).toHaveLength(1);

    await t.judge(fn);
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 200),
    ]);

    await t.submit(A.admin, A.shopId, fn, v2).expect(202);
    await t.judge(fn);
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 1000),
    ]);

    await t
      .as(A.admin)
      .post(t.route(A.shopId, `/${fn}/versions/1/activate`))
      .expect(200);
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 200),
    ]);

    await t
      .as(A.admin)
      .post(t.route(A.shopId, `/${fn}/disable`))
      .expect(200);
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([]);
    await t
      .as(A.admin)
      .post(t.route(A.shopId, `/${fn}/enable`))
      .expect(200);
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([
      amount(A.shopId, 200),
    ]);

    const [active] = await t.keys(`shopfn:active:${A.shopId}`);
    expect(active.ttlMs).toBeLessThanOrEqual(60_000);
    await t
      .as(A.admin)
      .delete(t.route(A.shopId, `/${fn}`))
      .expect(204);
    expect((await t.evaluate(cart)).shopDiscounts).toEqual([]);
  });

  describe('S45 AS-34: invalid cart input', () => {
    const line = {
      productId: 'p',
      shopId: uuidv4(),
      category: 'c',
      quantity: 1,
      unitPriceMinor: 100,
    };
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...line, productId: `p${i}` }));
    it.each<[string, unknown]>([
      ['no lines', { currency: 'EUR', lines: [] }],
      [
        'a fractional price',
        { currency: 'EUR', lines: [{ ...line, unitPriceMinor: 10.5 }] },
      ],
      [
        'a negative price',
        { currency: 'EUR', lines: [{ ...line, unitPriceMinor: -1 }] },
      ],
      [
        'a non-finite price',
        { currency: 'EUR', lines: [{ ...line, unitPriceMinor: Infinity }] },
      ],
      [
        'a NaN price',
        { currency: 'EUR', lines: [{ ...line, unitPriceMinor: NaN }] },
      ],
      [
        'a fractional quantity',
        { currency: 'EUR', lines: [{ ...line, quantity: 1.5 }] },
      ],
      [
        'a zero quantity',
        { currency: 'EUR', lines: [{ ...line, quantity: 0 }] },
      ],
      [
        'a missing shop',
        { currency: 'EUR', lines: [{ ...line, shopId: undefined }] },
      ],
      ['a null shop', { currency: 'EUR', lines: [{ ...line, shopId: null }] }],
      ['a lower-case currency', { currency: 'eur', lines: [line] }],
      ['more than 50 lines', { currency: 'EUR', lines: many(51) }],
      [
        'more than 10 shops',
        {
          currency: 'EUR',
          lines: Array.from({ length: 11 }, (_, i) => ({
            ...line,
            shopId: `shop-${i}`,
          })),
        },
      ],
      ['null', null],
      ['a string', 'cart'],
    ])(
      '%s resolves with no discount, counts invalid_cart and runs no seller code',
      async (_name, cart) => {
        await t.seedActive(A.shopId, { source: GOOD_SOURCE });
        const metrics = snapshot();

        const result = await t.evaluate(cart as never);

        expect(result).toEqual({ shopDiscounts: [] });
        expect(since(metrics)).toEqual({ invalid_cart: 1 });
        expect(sandboxRuns).not.toHaveBeenCalled();
        expect(JSON.stringify(t.logs())).not.toContain('"productId"');
      },
    );

    it('a cart whose shops have no functions answers empty with no sandbox work', async () => {
      const result = await t.evaluate(cartOf(A.shopId));

      expect(result).toEqual({ shopDiscounts: [] });
      expect(sandboxRuns).not.toHaveBeenCalled();
    });
  });
});
