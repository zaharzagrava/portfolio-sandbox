import { v4 as uuidv4 } from 'uuid';
import {
  pageSchema,
  shopFunctionSchema,
  testsBodySchema,
} from '@marketplace-sandbox/contracts';
import {
  GOOD_SOURCE,
  LOOP_SOURCE,
  THROW_SOURCE,
  caseOf,
  cartOf,
  createFunctionsApp,
  thirdCaseSuite,
  type FunctionsTestApp,
  type SeededShop,
  type TestUser,
} from './testing/function-fixtures';

const functionPage = pageSchema(shopFunctionSchema);

describe('Shop functions: management (functions, suites, reads)', () => {
  let t: FunctionsTestApp;
  let A: SeededShop;

  beforeAll(async () => {
    t = await createFunctionsApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    A = await t.seedShop();
  });

  const problem = (
    res: { status: number; body: Record<string, unknown> },
    status: number,
    code: string,
  ) => {
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ status, code });
    for (const field of ['type', 'title', 'detail', 'instance', 'requestId'])
      expect(res.body[field]).toEqual(expect.any(String));
  };
  const strip = (body: Record<string, unknown>) => {
    const { instance: _i, requestId: _r, ...rest } = body;
    return rest;
  };
  const count = async (table: string, where = 'TRUE') =>
    (
      await t.pg<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "${table}" WHERE ${where}`,
      )
    )[0].n;

  it('S45 AS-01: an admin creates a function with its suite; no version and no judge task exist', async () => {
    const res = await t.create(A.admin, A.shopId, {
      name: 'third-case-discount',
    });

    expect(res.status).toBe(201);
    const body = shopFunctionSchema.parse(res.body);
    expect(body).toMatchObject({
      shopId: A.shopId,
      name: 'third-case-discount',
      enabled: true,
      activeVersion: null,
      latestVersion: null,
      testCount: 2,
      breaker: { state: 'CLOSED', openUntil: null, lastFailure: null },
    });
    expect(
      await count('ShopFunction', `"shopId" = '${A.shopId}' AND "enabled"`),
    ).toBe(1);
    expect(
      await count(
        'ShopFunctionTestCase',
        `"functionId" = '${body.id}' AND "version" IS NULL`,
      ),
    ).toBe(2);
    expect(await count('ShopFunctionVersion')).toBe(0);
    expect(await t.pendingRequests(body.id)).toHaveLength(0);
  });

  describe('S45 AS-02: validation classes', () => {
    const line = {
      productId: 'p1',
      category: 'cases',
      quantity: 3,
      unitPriceMinor: 1200,
    };
    const caseWith = (patch: Record<string, unknown>) => ({
      ...caseOf('x', 3),
      ...patch,
    });
    const inputWith = (patch: Record<string, unknown>) =>
      caseWith({ input: { currency: 'EUR', lines: [line], ...patch } });
    const lineWith = (patch: Record<string, unknown>) =>
      inputWith({ lines: [{ ...line, ...patch }] });

    it.each<[string, Record<string, unknown>, string]>([
      ['no name', { tests: thirdCaseSuite() }, 'name'],
      ['an empty name', { name: '', tests: thirdCaseSuite() }, 'name'],
      ['a whitespace name', { name: '   ', tests: thirdCaseSuite() }, 'name'],
      [
        'a name over 60',
        { name: 'n'.repeat(61), tests: thirdCaseSuite() },
        'name',
      ],
      ['no tests', { name: 'f' }, 'tests'],
      ['an empty tests', { name: 'f', tests: [] }, 'tests'],
      [
        'more than 50 tests',
        {
          name: 'f',
          tests: Array.from({ length: 51 }, (_, i) => caseOf(`c${i}`, 3)),
        },
        'tests',
      ],
      [
        'a test without a name',
        {
          name: 'f',
          tests: [{ input: caseOf('x', 1).input, expected: { discounts: [] } }],
        },
        'tests.0.name',
      ],
      [
        'a test name over 80',
        { name: 'f', tests: [caseWith({ name: 'n'.repeat(81) })] },
        'tests.0.name',
      ],
      [
        'no lines',
        { name: 'f', tests: [inputWith({ lines: [] })] },
        'tests.0.input.lines',
      ],
      [
        'more than 50 lines',
        {
          name: 'f',
          tests: [inputWith({ lines: Array.from({ length: 51 }, () => line) })],
        },
        'tests.0.input.lines',
      ],
      [
        'a fractional quantity',
        { name: 'f', tests: [lineWith({ quantity: 1.5 })] },
        'quantity',
      ],
      [
        'a negative quantity',
        { name: 'f', tests: [lineWith({ quantity: -1 })] },
        'quantity',
      ],
      [
        'a zero quantity',
        { name: 'f', tests: [lineWith({ quantity: 0 })] },
        'quantity',
      ],
      [
        'a quantity over 1000',
        { name: 'f', tests: [lineWith({ quantity: 1001 })] },
        'quantity',
      ],
      [
        'a fractional price',
        { name: 'f', tests: [lineWith({ unitPriceMinor: 1.5 })] },
        'unitPriceMinor',
      ],
      [
        'a negative price',
        { name: 'f', tests: [lineWith({ unitPriceMinor: -1 })] },
        'unitPriceMinor',
      ],
      [
        'a price over a billion',
        { name: 'f', tests: [lineWith({ unitPriceMinor: 1_000_000_001 })] },
        'unitPriceMinor',
      ],
      [
        'a lower-case currency',
        { name: 'f', tests: [inputWith({ currency: 'eur' })] },
        'currency',
      ],
      [
        'an unknown root property',
        { name: 'f', tests: thirdCaseSuite(), extra: 1 },
        'extra',
      ],
      [
        'an unknown test property',
        { name: 'f', tests: [caseWith({ extra: 1 })] },
        'extra',
      ],
      [
        'an unknown line property',
        { name: 'f', tests: [lineWith({ shopId: 'S1' })] },
        'shopId',
      ],
      [
        'a body over 256 KiB',
        {
          name: 'f',
          tests: [caseWith({ name: 'big', pad: 'x'.repeat(300 * 1024) })],
        },
        'tests',
      ],
    ])(
      '%s is 400 validation_failed naming the field and stores nothing',
      async (_name, body, field) => {
        const res = await t.as(A.admin).post(t.route(A.shopId)).send(body);

        problem(res, 400, 'validation_failed');
        const fields = (res.body.errors as Array<{ field: string }>).map(
          (e) => e.field,
        );
        expect(fields.some((f) => f.includes(field))).toBe(true);
        expect(await count('ShopFunction')).toBe(0);
        expect(await count('ShopFunctionTestCase')).toBe(0);
      },
    );

    it('two tests sharing a name are 422 invalid_test_case naming the duplicate', async () => {
      const res = await t
        .as(A.admin)
        .post(t.route(A.shopId))
        .send({
          name: 'f',
          tests: [caseOf('same', 3), caseOf('same', 2)],
        });

      problem(res, 422, 'invalid_test_case');
      expect(res.body.detail).toContain('same');
      expect(await count('ShopFunction')).toBe(0);
    });

    it.each<[string, Record<string, unknown>, string]>([
      [
        'an unknown type',
        {
          discounts: [{ lineIndex: 0, type: 'bogus', value: 1, message: 'm' }],
        },
        'expected.discounts.0.type',
      ],
      [
        'a zero value',
        {
          discounts: [
            { lineIndex: 0, type: 'fixedPerUnit', value: 0, message: 'm' },
          ],
        },
        'expected.discounts.0.value',
      ],
      [
        'a lineIndex outside the input lines',
        {
          discounts: [
            { lineIndex: 5, type: 'fixedPerUnit', value: 1, message: 'm' },
          ],
        },
        'expected.discounts.0.lineIndex',
      ],
      [
        'more than 50 discounts',
        {
          discounts: Array.from({ length: 51 }, () => ({
            lineIndex: 0,
            type: 'fixedPerUnit',
            value: 1,
            message: 'm',
          })),
        },
        'expected.discounts',
      ],
      [
        'a message over 80',
        {
          discounts: [
            {
              lineIndex: 0,
              type: 'fixedPerUnit',
              value: 1,
              message: 'm'.repeat(81),
            },
          ],
        },
        'expected.discounts.0.message',
      ],
    ])(
      'an expected output with %s is 422 invalid_test_case naming the test and the field',
      async (_name, expected, field) => {
        const res = await t
          .as(A.admin)
          .post(t.route(A.shopId))
          .send({
            name: 'f',
            tests: [{ ...caseOf('bad case', 3), expected }],
          });

        problem(res, 422, 'invalid_test_case');
        expect(res.body.detail).toContain('bad case');
        expect(res.body.detail).toContain(field);
        expect(await count('ShopFunction')).toBe(0);
      },
    );
  });

  it('S45 AS-03: the fourth function loses under concurrency, a name is unique per shop ignoring case', async () => {
    await t.create(A.admin, A.shopId, { name: 'one' }).expect(201);
    await t.create(A.admin, A.shopId, { name: 'two' }).expect(201);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        t.create(A.admin, A.shopId, { name: `race-${i}` }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const losers = results.filter((r) => r.status !== 201);
    expect(losers).toHaveLength(4);
    for (const loser of losers) problem(loser, 422, 'function_limit_reached');
    expect(await count('ShopFunction', `"shopId" = '${A.shopId}'`)).toBe(3);

    const B = await t.seedShop();
    await t
      .create(B.admin, B.shopId, { name: 'third-case-discount' })
      .expect(201);
    problem(
      await t.create(B.admin, B.shopId, { name: 'Third-Case-Discount' }),
      409,
      'function_name_taken',
    );
    const C = await t.seedShop();
    await t
      .create(C.admin, C.shopId, { name: 'Third-Case-Discount' })
      .expect(201);
    expect(await count('ShopFunction', `"shopId" = '${B.shopId}'`)).toBe(1);
  });

  describe('S45 AS-04: permission, tenant, authentication', () => {
    const routes = (shopId: string, fn: string) => [
      {
        name: 'create',
        call: (u?: TestUser) =>
          req(u)
            .post(t.route(shopId))
            .send({ name: `n-${uuidv4()}`, tests: thirdCaseSuite() }),
      },
      { name: 'list', call: (u?: TestUser) => req(u).get(t.route(shopId)) },
      {
        name: 'read',
        call: (u?: TestUser) => req(u).get(t.route(shopId, `/${fn}`)),
      },
      {
        name: 'enable',
        call: (u?: TestUser) => req(u).post(t.route(shopId, `/${fn}/enable`)),
      },
      {
        name: 'disable',
        call: (u?: TestUser) => req(u).post(t.route(shopId, `/${fn}/disable`)),
      },
      {
        name: 'tests read',
        call: (u?: TestUser) => req(u).get(t.route(shopId, `/${fn}/tests`)),
      },
      {
        name: 'tests replace',
        call: (u?: TestUser) =>
          req(u)
            .put(t.route(shopId, `/${fn}/tests`))
            .send({ tests: thirdCaseSuite() }),
      },
      {
        name: 'version submit',
        call: (u?: TestUser) =>
          req(u)
            .post(t.route(shopId, `/${fn}/versions`))
            .send({ source: GOOD_SOURCE }),
      },
      {
        name: 'version list',
        call: (u?: TestUser) => req(u).get(t.route(shopId, `/${fn}/versions`)),
      },
      {
        name: 'version read',
        call: (u?: TestUser) =>
          req(u).get(t.route(shopId, `/${fn}/versions/1`)),
      },
      {
        name: 'version activate',
        call: (u?: TestUser) =>
          req(u).post(t.route(shopId, `/${fn}/versions/1/activate`)),
      },
      {
        name: 'delete',
        call: (u?: TestUser) => req(u).delete(t.route(shopId, `/${fn}`)),
      },
    ];
    const req = (u?: TestUser) =>
      u
        ? t.as(u)
        : {
            get: (x: string) => t.http().get(x),
            post: (x: string) => t.http().post(x),
            put: (x: string) => t.http().put(x),
            delete: (x: string) => t.http().delete(x),
          };

    it('owner and admin reach every handler; staff and viewer get 403, a member of another shop 404, anonymous 401', async () => {
      const staff = await t.member(A.shopId, 'STAFF');
      const viewer = await t.member(A.shopId, 'VIEWER');
      const B = await t.seedShop();

      for (const manager of [A.owner, A.admin]) {
        const fn = await t.newFunction(manager, A.shopId);
        await t.submit(manager, A.shopId, fn, GOOD_SOURCE).expect(202);
        for (const route of routes(A.shopId, fn)) {
          const res = await route.call(manager);
          // the handler ran: neither the guard (401/403) nor the shop lookup (404 shop_not_found) answered
          expect([401, 403]).not.toContain(res.status);
          expect(res.body.code).not.toBe('shop_not_found');
          expect(res.status).toBeLessThan(500);
        }
      }

      const fn = await t.newFunction(A.admin, A.shopId);
      for (const route of routes(A.shopId, fn)) {
        for (const role of [staff, viewer]) {
          const res = await route.call(role);
          problem(res, 403, 'permission_denied');
        }
        const outsider = await route.call(B.admin);
        expect(outsider.status).toBe(404);
        expect(outsider.body.code).toBe('shop_not_found');
        const anonymous = await route.call(undefined);
        expect(anonymous.status).toBe(401);
      }
      expect(await count('ShopFunction', `"id" = '${fn}'`)).toBe(1);
    });

    it('a function of another shop answers the same 404 function_not_found as an unknown id and exposes nothing', async () => {
      const B = await t.seedShop();
      const fn = await t.newFunction(A.admin, A.shopId);
      await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);

      const foreign = await t.as(B.admin).get(t.route(B.shopId, `/${fn}`));
      const unknown = await t
        .as(B.admin)
        .get(t.route(B.shopId, `/${uuidv4()}`));
      const malformed = await t
        .as(B.admin)
        .get(t.route(B.shopId, '/not-a-uuid'));

      problem(foreign, 404, 'function_not_found');
      expect(strip(foreign.body)).toEqual(strip(unknown.body));
      expect(strip(malformed.body)).toEqual(strip(unknown.body));
      for (const path of [
        `/${fn}/tests`,
        `/${fn}/versions`,
        `/${fn}/versions/1`,
      ]) {
        const res = await t.as(B.admin).get(t.route(B.shopId, path));
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('function run');
      }
      expect(
        (await t.as(B.admin).delete(t.route(B.shopId, `/${fn}`))).status,
      ).toBe(404);
      expect(await count('ShopFunction', `"id" = '${fn}'`)).toBe(1);
    });
  });

  it('S45 AS-05: write routes need the shopFunctions entitlement; reads, disable and delete never do', async () => {
    const fn = await t.newFunction(A.admin, A.shopId);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    t.entitlements.granted.delete(A.shopId);
    const before = {
      functions: await count('ShopFunction'),
      versions: await count('ShopFunctionVersion'),
      cases: await count('ShopFunctionTestCase'),
    };

    const writes = [
      await t.create(A.admin, A.shopId),
      await t
        .as(A.admin)
        .put(t.route(A.shopId, `/${fn}/tests`))
        .send({ tests: [caseOf('only', 3)] }),
      await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE),
      await t.as(A.admin).post(t.route(A.shopId, `/${fn}/enable`)),
      await t.as(A.admin).post(t.route(A.shopId, `/${fn}/versions/1/activate`)),
    ];

    for (const res of writes) {
      problem(res, 403, 'entitlement_required');
      expect(res.body.feature).toBe('shopFunctions');
    }
    expect({
      functions: await count('ShopFunction'),
      versions: await count('ShopFunctionVersion'),
      cases: await count('ShopFunctionTestCase'),
    }).toEqual(before);

    expect((await t.as(A.admin).get(t.route(A.shopId))).status).toBe(200);
    expect((await t.as(A.admin).get(t.route(A.shopId, `/${fn}`))).status).toBe(
      200,
    );
    expect(
      (await t.as(A.admin).get(t.route(A.shopId, `/${fn}/tests`))).status,
    ).toBe(200);
    expect(
      (await t.as(A.admin).post(t.route(A.shopId, `/${fn}/disable`))).status,
    ).toBe(200);
    expect(
      (await t.as(A.admin).delete(t.route(A.shopId, `/${fn}`))).status,
    ).toBe(204);
  });

  it('S45 AS-06: replacing the suite changes the current cases only, never an existing version and never judges', async () => {
    const fn = await t.newFunction(A.admin, A.shopId);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    await t.submit(A.admin, A.shopId, fn, LOOP_SOURCE).expect(202);
    await t.judge(fn);
    const statuses = async () =>
      t.pg(
        `SELECT "version", "status" FROM "ShopFunctionVersion" WHERE "functionId" = :fn ORDER BY "version"`,
        { fn },
      );
    const frozen = async () =>
      t.pg(
        `SELECT "version", "name" FROM "ShopFunctionTestCase" WHERE "functionId" = :fn AND "version" IS NOT NULL ORDER BY "version", "name"`,
        { fn },
      );
    const before = { statuses: await statuses(), frozen: await frozen() };
    expect(before.statuses).toEqual([
      { version: 1, status: 'ACTIVE' },
      { version: 2, status: 'REJECTED' },
    ]);
    const outbox = (
      await t.pg<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "Outbox" WHERE "type" = 'shop_functions.judge_requested'`,
      )
    )[0].n;

    const res = await t
      .as(A.admin)
      .put(t.route(A.shopId, `/${fn}/tests`))
      .send({
        tests: [caseOf('a', 3), caseOf('b', 2), caseOf('c', 5)],
      });

    expect(res.status).toBe(200);
    expect(testsBodySchema.parse(res.body).tests.map((c) => c.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const current = await t.as(A.admin).get(t.route(A.shopId, `/${fn}/tests`));
    expect(
      testsBodySchema.parse(current.body).tests.map((c) => c.name),
    ).toEqual(['a', 'b', 'c']);
    expect(await statuses()).toEqual(before.statuses);
    expect(await frozen()).toEqual(before.frozen);
    expect(
      (
        await t.pg<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM "Outbox" WHERE "type" = 'shop_functions.judge_requested'`,
        )
      )[0].n,
    ).toBe(outbox);
    problem(
      await t
        .as(A.admin)
        .put(t.route(A.shopId, `/${fn}/tests`))
        .send({ tests: [] }),
      400,
      'validation_failed',
    );
  });

  it('S45 AS-07: lists page by (createdAt, id) descending with an opaque cursor; the breaker shows the last failure', async () => {
    const T = await t.seedShop();
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c'])
      ids.push(await t.newFunction(A.admin, A.shopId, name));
    await t.newFunction(T.admin, T.shopId, 'other');

    const first = await t.as(A.admin).get(`${t.route(A.shopId)}?limit=2`);
    expect(first.status).toBe(200);
    const page1 = functionPage.parse(first.body);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const second = functionPage.parse(
      (
        await t
          .as(A.admin)
          .get(
            `${t.route(A.shopId)}?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
          )
      ).body,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const seen = [...page1.items, ...second.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort()).toEqual([...ids].sort());
    const ordered = await t.pg<{ id: string }>(
      `SELECT "id" FROM "ShopFunction" WHERE "shopId" = :shopId ORDER BY "createdAt" DESC, "id" DESC`,
      { shopId: A.shopId },
    );
    expect(seen).toEqual(ordered.map((r) => r.id));
    for (const item of [...page1.items, ...second.items])
      expect(item.shopId).toBe(A.shopId);

    problem(
      await t.as(A.admin).get(`${t.route(A.shopId)}?limit=51`),
      400,
      'validation_failed',
    );
    problem(
      await t.as(A.admin).get(`${t.route(A.shopId)}?cursor=tampered`),
      400,
      'invalid_cursor',
    );
    const forged = Buffer.from(
      JSON.stringify({ createdAt: 'x', id: 'y' }),
    ).toString('base64url');
    problem(
      await t.as(A.admin).get(`${t.route(A.shopId)}?cursor=${forged}`),
      400,
      'invalid_cursor',
    );

    const failing = await t.seedActive(A.shopId, {
      name: 'failing',
      source: THROW_SOURCE,
    });
    await t.evaluate(cartOf(A.shopId));
    const read = await t
      .as(A.admin)
      .get(t.route(A.shopId, `/${failing.functionId}`));
    expect(shopFunctionSchema.parse(read.body).breaker.lastFailure).toEqual({
      reason: 'runtime',
      at: expect.any(String),
    });
  });

  it('S45 AS-08: delete removes the function with its versions, history and cases, drops the caches and makes a late judge a no-op', async () => {
    const fn = await t.newFunction(A.admin, A.shopId);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    await t.judge(fn);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    expect(await t.pendingRequests(fn)).toHaveLength(1);
    expect((await t.evaluate(cartOf(A.shopId))).shopDiscounts).toEqual([
      { shopId: A.shopId, discountMinor: 600 },
    ]);
    expect(await t.keys(`shopfn:active:${A.shopId}`)).toHaveLength(1);

    const res = await t.as(A.admin).delete(t.route(A.shopId, `/${fn}`));

    expect(res.status).toBe(204);
    for (const table of [
      'ShopFunction',
      'ShopFunctionVersion',
      'ShopFunctionVersionHistory',
      'ShopFunctionTestCase',
    ])
      expect(
        await count(
          table,
          table === 'ShopFunction'
            ? `"id" = '${fn}'`
            : `"functionId" = '${fn}'`,
        ),
      ).toBe(0);
    expect(await t.keys(`shopfn:active:${A.shopId}`)).toHaveLength(0);
    expect((await t.evaluate(cartOf(A.shopId))).shopDiscounts).toEqual([]);
    await expect(t.judge(fn)).resolves.toBeUndefined();
    expect(await count('ShopFunctionVersion', `"functionId" = '${fn}'`)).toBe(
      0,
    );
    problem(
      await t.as(A.admin).delete(t.route(A.shopId, `/${fn}`)),
      404,
      'function_not_found',
    );
  });

  it('S45 AS-09: disable and enable are conditional and take effect on the next evaluation', async () => {
    const { functionId } = await t.seedActive(A.shopId, {
      source: GOOD_SOURCE,
    });
    const applied = [{ shopId: A.shopId, discountMinor: 600 }];
    expect((await t.evaluate(cartOf(A.shopId))).shopDiscounts).toEqual(applied);

    const off = await t
      .as(A.admin)
      .post(t.route(A.shopId, `/${functionId}/disable`));
    expect(off.status).toBe(200);
    expect(shopFunctionSchema.parse(off.body)).toMatchObject({
      enabled: false,
      activeVersion: 1,
    });
    expect((await t.evaluate(cartOf(A.shopId))).shopDiscounts).toEqual([]);
    expect(
      (
        await t.pg<{ status: string }>(
          `SELECT "status" FROM "ShopFunctionVersion" WHERE "functionId" = :functionId`,
          { functionId },
        )
      )[0].status,
    ).toBe('ACTIVE');
    problem(
      await t.as(A.admin).post(t.route(A.shopId, `/${functionId}/disable`)),
      409,
      'function_state_conflict',
    );

    const on = await t
      .as(A.admin)
      .post(t.route(A.shopId, `/${functionId}/enable`));
    expect(on.status).toBe(200);
    expect(shopFunctionSchema.parse(on.body).enabled).toBe(true);
    expect((await t.evaluate(cartOf(A.shopId))).shopDiscounts).toEqual(applied);
    problem(
      await t.as(A.admin).post(t.route(A.shopId, `/${functionId}/enable`)),
      409,
      'function_state_conflict',
    );
  });
});
