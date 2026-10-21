import { ClsService } from 'nestjs-cls';
import { v4 as uuidv4 } from 'uuid';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  GOOD_SOURCE,
  INVALID_OUTPUT_SOURCE,
  LOOP_SOURCE,
  THROW_SOURCE,
  caseOf,
  cartOf,
  createFunctionsApp,
  EMPTY_SOURCE,
  T0,
  type FunctionsTestApp,
  type SeededShop,
} from './testing/function-fixtures';
import { EVALUATION_OUTCOMES } from './application/shop-functions.metrics';
import { PgFunctionRepository } from './infra/pg-function.repository';

const MARKER = 'SECRET_SOURCE_MARKER_8f3a';
const MESSAGE_MARKER = 'DISCOUNT_MESSAGE_MARKER_77c1';
const markedSource = `function run(input) { /* ${MARKER} */ return { discounts: input.lines.filter(l => l.quantity >= 3).map(l => ({ lineIndex: input.lines.indexOf(l), type: 'fixedPerUnit', value: 200, message: '${MESSAGE_MARKER}' })) }; }`;
const markedSuite = () => [
  caseOf('3 cases', 3, [
    { lineIndex: 0, type: 'fixedPerUnit', value: 200, message: MESSAGE_MARKER },
  ]),
  caseOf('2 cases', 2),
];

describe('Shop functions: observability and schema invariants', () => {
  let t: FunctionsTestApp;
  let A: SeededShop;
  let cls: ClsService;

  beforeAll(async () => {
    t = await createFunctionsApp();
    cls = t.app.get(ClsService, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    A = await t.seedShop();
  });

  /** Runs `fn` inside a request context, as production work always is. */
  const inRequest = <T>(fn: () => Promise<T>, requestId = `req-${uuidv4()}`) =>
    cls.run(async () => {
      cls.set('requestId', requestId);
      return fn();
    });
  const evaluationCounts = () =>
    Object.fromEntries(
      EVALUATION_OUTCOMES.map((o) => [o, t.metrics.evaluation(o)]),
    );
  const delta = (before: Record<string, number>) =>
    Object.fromEntries(
      EVALUATION_OUTCOMES.map((o) => [
        o,
        t.metrics.evaluation(o) - before[o],
      ]).filter(([, n]) => n !== 0),
    );

  it('S45 AS-35: every event is counted once with closed labels, and logs and labels carry no source, message or id', async () => {
    const judged = {
      active: t.metrics.judge('active'),
      rejected: t.metrics.judge('rejected'),
      superseded: t.metrics.judge('superseded'),
      unavailable: t.metrics.judge('unavailable'),
    };
    const durations =
      MetricsRegistry.histogramValue(
        'shop_functions_evaluation_duration_seconds',
      )?.count ?? 0;
    const opened = t.metrics.breakerOpened();
    const before = evaluationCounts();

    // judge: active (AS-10), rejected (AS-13), superseded (AS-15), unavailable (runner down)
    const fn = await t.newFunction(A.admin, A.shopId, 'marked', markedSuite());
    await inRequest(async () => {
      await t.submit(A.admin, A.shopId, fn, markedSource).expect(202);
      await t.judge(fn);
      await t.submit(A.admin, A.shopId, fn, LOOP_SOURCE).expect(202);
      await t.judge(fn);
      await t.submit(A.admin, A.shopId, fn, markedSource).expect(202);
      await t.submit(A.admin, A.shopId, fn, markedSource).expect(202);
      await t.deliver({ functionId: fn, version: 4 });
      await t.deliver({ functionId: fn, version: 3 });
      await t.submit(A.admin, A.shopId, fn, markedSource).expect(202);
      await t.runner.stop();
      await t.judge(fn);
      await t.runner.start();
    });
    expect({
      active: t.metrics.judge('active') - judged.active,
      rejected: t.metrics.judge('rejected') - judged.rejected,
      superseded: t.metrics.judge('superseded') - judged.superseded,
      unavailable: t.metrics.judge('unavailable') - judged.unavailable,
    }).toEqual({ active: 2, rejected: 1, superseded: 1, unavailable: 1 });

    // evaluation: one counter per event
    const S2 = await t.seedShop({ entitled: false });
    const S3 = await t.seedShop();
    const S4 = await t.seedShop();
    await t.seedActive(S2.shopId, { source: GOOD_SOURCE });
    await t.seedActive(S3.shopId, { source: EMPTY_SOURCE });
    await t.seedActive(S4.shopId, { name: 'a', source: INVALID_OUTPUT_SOURCE });
    await t.seedActive(S4.shopId, { name: 'b', source: THROW_SOURCE });
    const cart = {
      currency: 'EUR',
      lines: [A, S2, S3, S4].flatMap((s) => cartOf(s.shopId).lines),
    };
    await inRequest(() => t.evaluate(cart));
    expect(delta(before)).toEqual({
      applied: 1,
      no_discount: 1,
      not_entitled: 1,
      invalid_output: 1,
      runtime: 1,
    });
    const failing = await t.seedActive(S3.shopId, {
      name: 'zz',
      source: THROW_SOURCE,
    });
    for (let i = 0; i < 6; i++)
      await inRequest(() => t.evaluate(cartOf(S3.shopId, 4 + i)));
    expect(failing.version).toBe(1);
    expect(t.metrics.breakerOpened()).toBe(opened + 1);
    expect(t.metrics.evaluation('breaker_open') - before.breaker_open).toBe(1);
    t.entitlements.failing = true;
    await inRequest(() => t.evaluate(cartOf(A.shopId)));
    t.entitlements.failing = false;
    await inRequest(() => t.evaluate({ currency: 'EUR', lines: [] }));
    expect(
      t.metrics.evaluation('entitlement_unavailable') -
        before.entitlement_unavailable,
    ).toBe(1);
    expect(t.metrics.evaluation('invalid_cart') - before.invalid_cart).toBe(1);
    const broken = jest
      .spyOn(t.app.get(PgFunctionRepository, { strict: false }), 'activeFor')
      .mockRejectedValue(new Error('down'));
    const S5 = await t.seedShop();
    await inRequest(() => t.evaluate(cartOf(S5.shopId)));
    broken.mockRestore();
    expect(
      t.metrics.evaluation('definitions_unavailable') -
        before.definitions_unavailable,
    ).toBe(1);

    // one observation per call
    const calls =
      (MetricsRegistry.histogramValue(
        'shop_functions_evaluation_duration_seconds',
      )?.count ?? 0) - durations;
    expect(calls).toBe(1 + 6 + 1 + 1 + 1);

    // closed labels, and nothing of the seller or the shop in any label
    for (const name of [
      'shop_functions_evaluations_total',
      'shop_functions_judge_total',
      'shop_functions_breaker_open_total',
      'shop_functions_evaluation_duration_seconds',
      'shop_functions_judge_backlog',
    ])
      for (const labels of MetricsRegistry.labelSets(name)) {
        expect(
          Object.keys(labels).every((k) => ['outcome', 'verdict'].includes(k)),
        ).toBe(true);
        const values = Object.values(labels).map(String);
        for (const value of values) {
          expect([
            ...EVALUATION_OUTCOMES,
            'active',
            'rejected',
            'superseded',
            'unavailable',
          ]).toContain(value);
        }
      }

    // logs: JSON with a correlation id; never source, test input, discount message, token or id
    const lines = t.logs();
    expect(lines.length).toBeGreaterThan(0);
    for (const { line } of lines.filter((l) => l.line.event)) {
      expect(line.requestId ?? line.traceId).toEqual(expect.any(String));
    }
    const everything =
      JSON.stringify(lines) +
      JSON.stringify([
        ...MetricsRegistry.labelSets('shop_functions_evaluations_total'),
      ]);
    expect(everything).not.toContain(MARKER);
    expect(everything).not.toContain(MESSAGE_MARKER);
    expect(everything).not.toContain(A.shopId);
    expect(everything).not.toContain(fn);
    expect(everything).not.toContain('Bearer');
    expect(everything.toLowerCase()).not.toContain('authorization');
    for (const status of [
      await t.as(A.admin).get(t.route(A.shopId, `/${uuidv4()}`)),
      await t
        .as(A.admin)
        .post(t.route(A.shopId, `/${fn}/versions`))
        .send({ source: 1 }),
    ])
      expect(JSON.stringify(status.body)).not.toContain(MARKER);
  });

  it('S45 AS-36: the backlog gauge counts QUEUED versions and the age of the oldest; an empty queue is zero', async () => {
    const fn = await t.newFunction(A.admin, A.shopId);
    await t.recovery.run();
    expect([t.metrics.backlog(), t.metrics.oldestQueuedAge()]).toEqual([0, 0]);

    for (const [version, age] of [
      [1, 10],
      [2, 90],
      [3, 5],
    ] as const) {
      await t.insertVersion(fn, version, 'QUEUED');
      await t.pg(
        `UPDATE "ShopFunctionVersion" SET "createdAt" = :at, "updatedAt" = :at WHERE "functionId" = :fn AND "version" = :version`,
        {
          at: new Date(T0.getTime() - age * 1000),
          fn,
          version,
        },
      );
    }
    await t.insertVersion(fn, 4, 'TESTING');

    await t.recovery.run();

    expect(t.metrics.backlog()).toBe(3);
    expect(Math.round(t.metrics.oldestQueuedAge())).toBe(90);
  });

  describe('S45 AS-37: errors and contracts', () => {
    const expectProblem = (
      res: {
        status: number;
        body: Record<string, unknown>;
        headers: Record<string, string>;
      },
      status: number,
      code: string,
    ) => {
      expect(res.status).toBe(status);
      expect(res.headers['content-type']).toContain('application/problem+json');
      const parsed = problemDetailsSchema.parse(res.body);
      expect(parsed.code).toBe(code);
      expect(parsed.status).toBe(status);
      const text = JSON.stringify(res.body).toLowerCase();
      for (const leak of [
        'select ',
        'insert ',
        'sequelize',
        'stack',
        'function run',
      ])
        expect(text).not.toContain(leak);
    };

    it('answers every code of FR-034 as problem+json', async () => {
      const staff = await t.member(A.shopId, 'STAFF');
      const B = await t.seedShop({ entitled: false });
      const fn = await t.newFunction(A.admin, A.shopId, 'f1');
      await t.newFunction(A.admin, A.shopId, 'f2');
      await t.newFunction(A.admin, A.shopId, 'f3');

      expectProblem(
        await t.as(A.admin).post(t.route(A.shopId)).send({}),
        400,
        'validation_failed',
      );
      expectProblem(
        await t.as(A.admin).get(`${t.route(A.shopId)}?cursor=bad`),
        400,
        'invalid_cursor',
      );
      expectProblem(
        await t
          .as(A.admin)
          .put(t.route(A.shopId, `/${fn}/tests`))
          .send({ tests: [caseOf('same', 3), caseOf('same', 2)] }),
        422,
        'invalid_test_case',
      );
      expectProblem(
        await t.as(A.admin).get(t.route(A.shopId, `/${uuidv4()}`)),
        404,
        'function_not_found',
      );
      expectProblem(
        await t.as(A.admin).get(t.route(A.shopId, `/${fn}/versions/9`)),
        404,
        'version_not_found',
      );
      expectProblem(
        await t.create(A.admin, A.shopId, { name: 'F1' }),
        409,
        'function_name_taken',
      );
      expectProblem(
        await t.create(A.admin, A.shopId, { name: 'f4' }),
        422,
        'function_limit_reached',
      );
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          t.insertVersion(fn, i + 1, 'REJECTED'),
        ),
      );
      expectProblem(
        await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE),
        422,
        'version_limit_reached',
      );
      expectProblem(
        await t.as(A.admin).post(t.route(A.shopId, `/${fn}/enable`)),
        409,
        'function_state_conflict',
      );
      expectProblem(
        await t
          .as(A.admin)
          .post(t.route(A.shopId, `/${fn}/versions/1/activate`)),
        409,
        'version_not_activatable',
      );
      expectProblem(
        await t.create(B.admin, B.shopId),
        403,
        'entitlement_required',
      );
      expectProblem(
        await t.as(staff).get(t.route(A.shopId)),
        403,
        'permission_denied',
      );
      // identity answers an anonymous caller with its own 401 code (the spec's `unauthenticated`)
      expectProblem(
        await t.http().get(t.route(A.shopId)),
        401,
        'invalid_token',
      );
      const rate = await t.seedShop();
      const rateFn = await t.newFunction(rate.admin, rate.shopId);
      for (let i = 0; i < 10; i++)
        await t
          .submit(rate.admin, rate.shopId, rateFn, GOOD_SOURCE)
          .expect(202);
      expectProblem(
        await t.submit(rate.admin, rate.shopId, rateFn, GOOD_SOURCE),
        429,
        'rate_limited',
      );
    });

    it('a 5xx carries a generic detail with no SQL, stack or engine message', async () => {
      const fn = await t.newFunction(A.admin, A.shopId);
      await t.failOutbox(true);

      const res = await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE);

      expectProblem(res, 500, 'internal_error');
      expect(res.body.detail).toBe(
        'The server could not complete the request. Please try again later.',
      );
      expect(JSON.stringify(res.body)).not.toContain('outbox');
      await t.failOutbox(false);
    });
  });

  describe('S45 AS-39: the store enforces the invariants', () => {
    const attempt = async (
      sql: string,
      replacements: Record<string, unknown> = {},
    ) => {
      try {
        await t.pg(sql, replacements);
        return null;
      } catch (error) {
        return String(
          (error as { original?: { message?: string } }).original?.message ??
            (error as Error).message,
        );
      }
    };
    const insert = (
      fn: string,
      version: number,
      status: string,
      source = 'function run(){}',
    ) =>
      attempt(
        `INSERT INTO "ShopFunctionVersion" ("functionId", "version", "source", "sourceHash", "status", "createdBy") VALUES (:fn, :version, :source, :hash, :status, :owner)`,
        { fn, version, source, hash: 'a'.repeat(64), status, owner: uuidv4() },
      );

    it('refuses a second ACTIVE version, a bad status, a repeated number, a bad pointer, a bad source and a repeated name', async () => {
      const { functionId: fn } = await t.seedActive(A.shopId, {
        name: 'Pointer',
        source: GOOD_SOURCE,
      });
      await t.insertVersion(fn, 2, 'SUPERSEDED');

      expect(await insert(fn, 3, 'ACTIVE')).toMatch(
        /ShopFunctionVersion_one_active_uq|duplicate key/,
      );
      expect(await insert(fn, 4, 'LIVE')).toMatch(/check constraint/);
      expect(await insert(fn, 1, 'REJECTED')).toMatch(/duplicate key/);
      expect(await insert(fn, 5, 'REJECTED', 'x'.repeat(20_001))).toMatch(
        /ShopFunctionVersion_source_len|check constraint/,
      );
      expect(await insert(fn, 6, 'REJECTED', '')).toMatch(
        /ShopFunctionVersion_source_len|check constraint/,
      );
      expect(await insert(fn, 0, 'REJECTED')).toMatch(
        /ShopFunctionVersion_version_pos|check constraint/,
      );

      // the pointer must name an ACTIVE version (deferred: refused at commit)
      for (const target of [2, 99]) {
        const error = await attempt(
          `BEGIN; UPDATE "ShopFunction" SET "activeVersion" = ${target} WHERE "id" = :fn; COMMIT;`,
          { fn },
        );
        expect(error).toMatch(/ShopFunction_active_version_fk|foreign key/);
      }
      expect(
        (
          await t.pg<{ activeVersion: number }>(
            `SELECT "activeVersion" FROM "ShopFunction" WHERE "id" = :fn`,
            { fn },
          )
        )[0].activeVersion,
      ).toBe(1);

      expect(
        await attempt(
          `INSERT INTO "ShopFunction" ("shopId", "name") VALUES (:shopId, 'pOINTER')`,
          { shopId: A.shopId },
        ),
      ).toMatch(/ShopFunction_shop_lower_name_uq|duplicate key/);
      expect(
        await attempt(
          `INSERT INTO "ShopFunction" ("shopId", "name") VALUES (:shopId, '')`,
          { shopId: A.shopId },
        ),
      ).toMatch(/ShopFunction_name_len|check constraint/);
    });

    it('has no foreign key to another domain, and deleting a function removes versions, history and cases together', async () => {
      const references = await t.pg<{ from: string; to: string }>(
        `SELECT conrelid::regclass::text AS "from", confrelid::regclass::text AS "to" FROM pg_constraint
         WHERE contype = 'f' AND (conrelid::regclass::text LIKE '"ShopFunction%' OR conrelid::regclass::text LIKE 'ShopFunction%')`,
      );
      const own = new Set([
        'ShopFunction',
        'ShopFunctionVersion',
        'ShopFunctionTestCase',
        'ShopFunctionVersionHistory',
      ]);
      expect(references.length).toBeGreaterThan(0);
      for (const ref of references) {
        expect(own.has(ref.from.replace(/"/g, ''))).toBe(true);
        expect(own.has(ref.to.replace(/"/g, ''))).toBe(true);
      }

      const fn = await t.newFunction(A.admin, A.shopId);
      await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
      await t.pg(`DELETE FROM "ShopFunction" WHERE "id" = :fn`, { fn });
      for (const table of [
        'ShopFunctionVersion',
        'ShopFunctionVersionHistory',
        'ShopFunctionTestCase',
      ])
        expect(
          (
            await t.pg<{ n: number }>(
              `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "functionId" = :fn`,
              { fn },
            )
          )[0].n,
        ).toBe(0);
    });
  });
});
