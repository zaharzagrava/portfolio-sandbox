import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  pageSchema,
  shopFunctionVersionSchema,
  shopFunctionVersionSummarySchema,
  submittedVersionSchema,
} from '@marketplace-sandbox/contracts';
import {
  EMPTY_SOURCE,
  GOOD_SOURCE,
  LOOP_SOURCE,
  REQUIRE_SOURCE,
  SYNTAX_SOURCE,
  cartOf,
  caseOf,
  createFunctionsApp,
  percentSource,
  T0,
  type FunctionsTestApp,
  type SeededShop,
} from './testing/function-fixtures';
import { JudgeJobs } from './infra/judge.jobs';

describe('Shop functions: submission, judge and versions', () => {
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
  };
  const versions = (fn: string) =>
    t.pg<{
      version: number;
      status: string;
      verdicts: Array<Record<string, unknown>> | null;
      judgeAttempts: number;
      rejectionReason: string | null;
    }>(
      `SELECT "version", "status", "verdicts", "judgeAttempts", "rejectionReason" FROM "ShopFunctionVersion" WHERE "functionId" = :fn ORDER BY "version"`,
      { fn },
    );
  const history = (fn: string, version?: number) =>
    t.pg<{
      version: number;
      fromStatus: string | null;
      toStatus: string;
      actorId: string | null;
      reason: string | null;
    }>(
      `SELECT "version", "fromStatus", "toStatus", "actorId", "reason" FROM "ShopFunctionVersionHistory"
       WHERE "functionId" = :fn ${version ? 'AND "version" = :version' : ''} ORDER BY "version", "at", "id"`,
      { fn, version },
    );
  const activeVersion = async (fn: string) =>
    (
      await t.pg<{ activeVersion: number | null }>(
        `SELECT "activeVersion" FROM "ShopFunction" WHERE "id" = :fn`,
        { fn },
      )
    )[0].activeVersion;
  const requests = async () =>
    (
      await t.pg<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "Outbox" WHERE "type" = 'shop_functions.judge_requested'`,
      )
    )[0].n;
  /** A function whose version 1 (the AS-01 suite and source) is judged and ACTIVE. */
  const withActiveV1 = async () => {
    const fn = await t.newFunction(A.admin, A.shopId);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    await t.judge(fn);
    expect((await versions(fn))[0].status).toBe('ACTIVE');
    return fn;
  };
  const message = (fn: string, version: number) => ({
    functionId: fn,
    version,
  });

  it('S45 AS-10: a submitted version is queued with one outbox request, judged to ACTIVE with verdicts and a timeline', async () => {
    const fn = await t.newFunction(A.admin, A.shopId);
    await t.redis.set(`shopfn:active:${A.shopId}`, '[]', 'EX', 60);

    const res = await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE);

    expect(res.status).toBe(202);
    expect(submittedVersionSchema.parse(res.body)).toMatchObject({
      functionId: fn,
      version: 1,
      status: 'QUEUED',
    });
    const [row] = await t.pg<{
      sourceHash: string;
      createdBy: string;
      status: string;
    }>(
      `SELECT "sourceHash", "createdBy", "status" FROM "ShopFunctionVersion" WHERE "functionId" = :fn`,
      { fn },
    );
    expect(row).toEqual({
      sourceHash: createHash('sha256').update(GOOD_SOURCE).digest('hex'),
      createdBy: A.admin.id,
      status: 'QUEUED',
    });
    expect(
      await t.pg(
        `SELECT "name" FROM "ShopFunctionTestCase" WHERE "functionId" = :fn AND "version" = 1 ORDER BY "name"`,
        { fn },
      ),
    ).toEqual([{ name: '2 cases' }, { name: '3 cases' }]);
    expect(await history(fn)).toEqual([
      {
        version: 1,
        fromStatus: null,
        toStatus: 'QUEUED',
        actorId: A.admin.id,
        reason: null,
      },
    ]);
    expect(await t.pendingRequests(fn)).toHaveLength(1);

    await t.judge(fn);

    const [judged] = await versions(fn);
    expect(judged.status).toBe('ACTIVE');
    expect(judged.verdicts).toEqual([
      { case: '2 cases', verdict: 'pass', ms: expect.any(Number) },
      { case: '3 cases', verdict: 'pass', ms: expect.any(Number) },
    ]);
    expect(await activeVersion(fn)).toBe(1);
    expect(
      (await history(fn)).map((h) => `${h.fromStatus}>${h.toStatus}`),
    ).toEqual(['null>QUEUED', 'QUEUED>TESTING', 'TESTING>ACTIVE']);
    expect(await t.keys(`shopfn:active:${A.shopId}`)).toHaveLength(0);
    const read = await t
      .as(A.admin)
      .get(t.route(A.shopId, `/${fn}/versions/1`));
    const body = shopFunctionVersionSchema.parse(read.body);
    expect(body).toMatchObject({
      source: GOOD_SOURCE,
      status: 'ACTIVE',
      judgeAttempts: 1,
      rejectionReason: null,
    });
    expect(body.timeline.map((x) => x.status)).toEqual([
      'QUEUED',
      'TESTING',
      'ACTIVE',
    ]);
    const list = pageSchema(shopFunctionVersionSummarySchema).parse(
      (await t.as(A.admin).get(t.route(A.shopId, `/${fn}/versions`))).body,
    );
    expect(list.items.map((v) => v.version)).toEqual([1]);
    expect(JSON.stringify(list)).not.toContain('function run');
  });

  describe('S45 AS-11: submit validation, limits, rate limit', () => {
    it.each<[string, Record<string, unknown>]>([
      ['no source', {}],
      ['an empty source', { source: '' }],
      ['a non-string source', { source: 12 }],
      ['a source over 20,000 characters', { source: 'x'.repeat(20_001) }],
      ['an unknown property', { source: GOOD_SOURCE, extra: true }],
    ])(
      '%s is 400 validation_failed and nothing is stored',
      async (_name, body) => {
        const fn = await t.newFunction(A.admin, A.shopId);

        const res = await t
          .as(A.admin)
          .post(t.route(A.shopId, `/${fn}/versions`))
          .send(body);

        problem(res, 400, 'validation_failed');
        expect(await versions(fn)).toHaveLength(0);
        expect(await requests()).toBe(0);
      },
    );

    it('a function with 100 versions refuses another with 422 version_limit_reached', async () => {
      const fn = await t.newFunction(A.admin, A.shopId);
      for (let v = 1; v <= 100; v++) await t.insertVersion(fn, v, 'REJECTED');

      problem(
        await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE),
        422,
        'version_limit_reached',
      );
      expect(await versions(fn)).toHaveLength(100);
    });

    it('the 11th submission in an hour is 429 with Retry-After and stores nothing', async () => {
      const fn = await t.newFunction(A.admin, A.shopId);
      for (let i = 0; i < 10; i++)
        await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);

      const res = await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE);

      problem(res, 429, 'rate_limited');
      expect(res.headers['retry-after']).toEqual(expect.any(String));
      expect(await versions(fn)).toHaveLength(10);
      const other = await t.seedShop();
      const otherFn = await t.newFunction(other.admin, other.shopId);
      await t
        .submit(other.admin, other.shopId, otherFn, GOOD_SOURCE)
        .expect(202);
    });

    it("an unknown function or another shop's function is 404; a broken source is accepted and judged", async () => {
      const B = await t.seedShop();
      const foreign = await t.newFunction(B.admin, B.shopId);

      problem(
        await t.submit(A.admin, A.shopId, uuidv4(), GOOD_SOURCE),
        404,
        'function_not_found',
      );
      problem(
        await t.submit(A.admin, A.shopId, foreign, GOOD_SOURCE),
        404,
        'function_not_found',
      );
      expect(await versions(foreign)).toHaveLength(0);

      const fn = await t.newFunction(A.admin, A.shopId);
      await t.submit(A.admin, A.shopId, fn, SYNTAX_SOURCE).expect(202);
      await t.submit(A.admin, A.shopId, fn, 'var x = 1;').expect(202);
      await t.judge(fn);
      const rows = await versions(fn);
      expect(rows.map((r) => r.status)).toEqual(['REJECTED', 'REJECTED']);
      expect(rows[0].verdicts?.map((v) => v.verdict)).toEqual([
        'compile-error',
        'compile-error',
      ]);
      expect(rows[1].verdicts?.map((v) => v.verdict)).toEqual([
        'entry-missing',
        'entry-missing',
      ]);
    });
  });

  it('S45 AS-12: ten concurrent submissions get distinct consecutive numbers and one request each', async () => {
    const fn = await t.newFunction(A.admin, A.shopId);
    for (const v of [1, 2, 3]) await t.insertVersion(fn, v, 'REJECTED');

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        t.submit(A.admin, A.shopId, fn, GOOD_SOURCE),
      ),
    );

    expect(results.map((r) => r.status)).toEqual(Array(10).fill(202));
    expect(results.map((r) => r.body.version).sort((a, b) => a - b)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    const rows = await versions(fn);
    expect(rows.filter((r) => r.status === 'QUEUED')).toHaveLength(10);
    expect(await t.pendingRequests(fn)).toHaveLength(10);
    expect(rows.filter((r) => r.status === 'ACTIVE')).toHaveLength(0);
  });

  it('S45 AS-13: looping, forbidden and wrong code is REJECTED with verdicts and the active version keeps serving', async () => {
    const fn = await withActiveV1();
    await t.submit(A.admin, A.shopId, fn, LOOP_SOURCE).expect(202);
    await t.submit(A.admin, A.shopId, fn, REQUIRE_SOURCE).expect(202);
    await t.submit(A.admin, A.shopId, fn, EMPTY_SOURCE).expect(202);

    const started = Date.now();
    await t.judge(fn);
    expect(Date.now() - started).toBeLessThan(6000);

    const rows = await versions(fn);
    expect(rows.map((r) => r.status)).toEqual([
      'ACTIVE',
      'REJECTED',
      'REJECTED',
      'REJECTED',
    ]);
    expect(rows[1].verdicts?.map((v) => v.verdict)).toEqual([
      'timeout',
      'timeout',
    ]);
    for (const v of rows[1].verdicts ?? [])
      expect(v.ms as number).toBeLessThanOrEqual(500);
    expect(rows[2].verdicts?.[0]).toMatchObject({
      verdict: 'runtime',
      detail: expect.stringMatching(/require is not defined/),
    });
    expect(rows[3].verdicts).toEqual([
      { case: '2 cases', verdict: 'pass', ms: expect.any(Number) },
      {
        case: '3 cases',
        verdict: 'wrong-output',
        actual: { discounts: [] },
        ms: expect.any(Number),
      },
    ]);
    expect(await activeVersion(fn)).toBe(1);
    for (const v of [2, 3, 4])
      expect(
        (await history(fn, v)).map((h) => `${h.fromStatus}>${h.toStatus}`),
      ).toEqual(['null>QUEUED', 'QUEUED>TESTING', 'TESTING>REJECTED']);
    expect((await t.evaluate(cartOf(A.shopId))).shopDiscounts).toEqual([
      { shopId: A.shopId, discountMinor: 600 },
    ]);
  });

  it('S45 AS-15: a passing version older than the active one is SUPERSEDED as stale and never replaces it', async () => {
    const fn = await withActiveV1();
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);

    await t.deliver(message(fn, 3));
    await t.deliver(message(fn, 2));

    const rows = await versions(fn);
    expect(rows.map((r) => r.status)).toEqual([
      'SUPERSEDED',
      'SUPERSEDED',
      'ACTIVE',
    ]);
    expect(rows[1].verdicts?.every((v) => v.verdict === 'pass')).toBe(true);
    expect(await activeVersion(fn)).toBe(3);
    const last = (await history(fn, 2)).pop();
    expect(last).toMatchObject({
      fromStatus: 'TESTING',
      toStatus: 'SUPERSEDED',
      reason: 'stale',
      actorId: null,
    });
  });

  it('S45 AS-16: two versions completing together leave exactly one ACTIVE', async () => {
    const fn = await t.newFunction(A.admin, A.shopId);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    await t.deliver(message(fn, 1));

    await Promise.all([t.deliver(message(fn, 2)), t.deliver(message(fn, 3))]);

    const rows = await versions(fn);
    expect(
      rows.filter((r) => r.status === 'ACTIVE').map((r) => r.version),
    ).toEqual([3]);
    expect(
      rows.filter((r) => r.status === 'SUPERSEDED').map((r) => r.version),
    ).toEqual([1, 2]);
    expect(await activeVersion(fn)).toBe(3);
  });

  describe('S45 AS-17: duplicate and crashed deliveries', () => {
    it('a second delivery, sequential or concurrent, changes nothing', async () => {
      const fn = await t.newFunction(A.admin, A.shopId);
      await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);

      await Promise.all([t.deliver(message(fn, 1)), t.deliver(message(fn, 1))]);
      await t.deliver(message(fn, 1));

      expect((await versions(fn))[0].status).toBe('ACTIVE');
      expect(
        (await history(fn)).map((h) => `${h.fromStatus}>${h.toStatus}`),
      ).toEqual(['null>QUEUED', 'QUEUED>TESTING', 'TESTING>ACTIVE']);
      expect((await versions(fn))[0].verdicts).toHaveLength(2);
    });

    it('a version left TESTING by a crashed worker is judged again and ends with one terminal history row', async () => {
      const fn = await t.newFunction(A.admin, A.shopId);
      await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
      // the worker died after QUEUED -> TESTING and before applying the result
      await t.pg(
        `UPDATE "ShopFunctionVersion" SET "status" = 'TESTING' WHERE "functionId" = :fn`,
        { fn },
      );
      await t.pg(
        `INSERT INTO "ShopFunctionVersionHistory" ("functionId", "version", "fromStatus", "toStatus", "at") VALUES (:fn, 1, 'QUEUED', 'TESTING', :now)`,
        { fn, now: T0 },
      );

      await t.deliver(message(fn, 1));

      expect((await versions(fn))[0].status).toBe('ACTIVE');
      const terminal = (await history(fn)).filter((h) =>
        ['ACTIVE', 'REJECTED', 'SUPERSEDED'].includes(h.toStatus),
      );
      expect(terminal).toHaveLength(1);
    });

    it('a delivery for a terminal version is acknowledged and changes nothing', async () => {
      const fn = await withActiveV1();
      await t.insertVersion(fn, 2, 'REJECTED');
      await t.insertVersion(fn, 3, 'SUPERSEDED');
      const before = await history(fn);
      const verdicts = await versions(fn);

      for (const v of [1, 2, 3]) await t.deliver(message(fn, v));

      expect(await history(fn)).toEqual(before);
      expect(await versions(fn)).toEqual(verdicts);
    });
  });

  it('S45 AS-18: invalid judge payloads are dead-lettered without effect; unknown targets are acknowledged', async () => {
    const fn = await t.newFunction(A.admin, A.shopId);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    const before = { v: await versions(fn), h: await history(fn) };
    const bad: unknown[] = [
      { version: 1 },
      { functionId: 'not-a-uuid', version: 1 },
      { functionId: fn },
      { functionId: fn, version: 0 },
      { functionId: fn, version: -2 },
      { functionId: fn, version: 1, extra: true },
      'not json at all',
    ];

    for (const body of bad) await t.deliver(body);

    expect(t.queue.deadLettered.map((d) => d.reason)).toEqual(
      Array(bad.length).fill('SCHEMA_INVALID'),
    );
    expect({ v: await versions(fn), h: await history(fn) }).toEqual(before);
    await t.deliver(message(uuidv4(), 1));
    await t.deliver(message(fn, 99));
    expect({ v: await versions(fn), h: await history(fn) }).toEqual(before);
    expect(t.queue.deadLettered).toHaveLength(bad.length);
    await t.deliver(message(fn, 1));
    expect((await versions(fn))[0].status).toBe('ACTIVE');
  });

  describe('S45 AS-19: stuck versions are recovered', () => {
    const ago = (ms: number) => new Date(T0.getTime() - ms);
    const age = (fn: string, version: number, ms: number, attempts?: number) =>
      t.pg(
        `UPDATE "ShopFunctionVersion" SET "updatedAt" = :at, "judgeAttempts" = COALESCE(:attempts, "judgeAttempts") WHERE "functionId" = :fn AND "version" = :version`,
        { at: ago(ms), fn, version, attempts: attempts ?? null },
      );

    it('re-requests a QUEUED and a TESTING version after 2 minutes, once, and leaves young ones alone', async () => {
      const fn = await t.newFunction(A.admin, A.shopId);
      await t.insertVersion(fn, 1, 'QUEUED');
      await t.insertVersion(fn, 2, 'TESTING');
      await t.insertVersion(fn, 3, 'QUEUED');
      await age(fn, 1, 180_000);
      await age(fn, 2, 180_000);
      await age(fn, 3, 30_000);

      const [first, second] = await Promise.all([
        t.recovery.run(),
        t.recovery.run(),
      ]);

      expect(first.rerequested + second.rerequested).toBe(2);
      expect(await t.pendingRequests(fn)).toHaveLength(2);
      expect((await versions(fn)).map((v) => v.judgeAttempts)).toEqual([
        2, 2, 1,
      ]);
      expect(await t.recovery.run()).toEqual({ rerequested: 0, rejected: 0 });
      expect(await t.pendingRequests(fn)).toHaveLength(2);
    });

    it('rejects a version at its fifth attempt as judge_unavailable with a system history row and no request', async () => {
      const fn = await t.newFunction(A.admin, A.shopId);
      await t.insertVersion(fn, 1, 'TESTING');
      await age(fn, 1, 180_000, 5);

      const result = await t.recovery.run();

      expect(result).toEqual({ rerequested: 0, rejected: 1 });
      expect((await versions(fn))[0]).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'judge_unavailable',
      });
      expect((await history(fn)).pop()).toMatchObject({
        fromStatus: 'TESTING',
        toStatus: 'REJECTED',
        actorId: null,
        reason: 'judge_unavailable',
      });
      expect(await t.pendingRequests(fn)).toHaveLength(0);
      const read = await t
        .as(A.admin)
        .get(t.route(A.shopId, `/${fn}/versions/1`));
      expect(shopFunctionVersionSchema.parse(read.body).rejectionReason).toBe(
        'judge_unavailable',
      );
    });

    it('runs as a schedule, once across the fleet, and a runner that is down leaves the version for recovery', async () => {
      // registered at boot, idempotent at every boot (the reset above wiped the table the first boot wrote)
      await t.app.get(JudgeJobs, { strict: false }).onApplicationBootstrap();
      await t.app.get(JudgeJobs, { strict: false }).onApplicationBootstrap();
      const [schedule] = await t.pg<{
        cron: string;
        jobType: string;
        enabled: boolean;
      }>(
        `SELECT "cron", "jobType", "enabled" FROM "JobSchedule" WHERE "name" = 'shop-functions.recover-stuck-versions'`,
      );
      expect(schedule).toEqual({
        cron: '* * * * *',
        jobType: 'shop-functions.recover-stuck-versions',
        enabled: true,
      });

      const fn = await t.newFunction(A.admin, A.shopId);
      await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
      await t.runner.stop();
      await t.judge(fn);
      expect((await versions(fn))[0].status).toBe('TESTING');
      await t.runner.start();
      await t.pg(
        `UPDATE "ShopFunctionVersion" SET "updatedAt" = :at WHERE "functionId" = :fn`,
        { at: ago(180_000), fn },
      );
      await t.recovery.run();
      await t.judge(fn);
      expect((await versions(fn))[0]).toMatchObject({
        status: 'ACTIVE',
        judgeAttempts: 2,
      });
    });
  });

  describe('S45 AS-20: rollback and illegal transitions', () => {
    const setup = async () => {
      const { functionId: fn } = await t.seedActive(A.shopId, {
        name: 'rollback',
        version: 3,
        source: percentSource(10),
      });
      await t.insertVersion(fn, 1, 'SUPERSEDED', { passed: false });
      await t.insertVersion(fn, 2, 'SUPERSEDED', { source: percentSource(50) });
      await t.insertVersion(fn, 4, 'REJECTED');
      await t.insertVersion(fn, 5, 'QUEUED');
      return fn;
    };

    it('activates a passing SUPERSEDED version atomically, with the caller in the history, and the next evaluation uses it', async () => {
      const fn = await setup();
      expect(
        (await t.evaluate(cartOf(A.shopId, 1, 1000))).shopDiscounts,
      ).toEqual([{ shopId: A.shopId, discountMinor: 100 }]);

      const res = await t
        .as(A.admin)
        .post(t.route(A.shopId, `/${fn}/versions/2/activate`));

      expect(res.status).toBe(200);
      expect(shopFunctionVersionSchema.parse(res.body)).toMatchObject({
        version: 2,
        status: 'ACTIVE',
      });
      expect((await versions(fn)).map((v) => v.status)).toEqual([
        'SUPERSEDED',
        'ACTIVE',
        'SUPERSEDED',
        'REJECTED',
        'QUEUED',
      ]);
      expect(await activeVersion(fn)).toBe(2);
      const rows = (await history(fn)).filter((h) => h.actorId === A.admin.id);
      expect(
        rows
          .map((h) => `${h.version}:${h.fromStatus}>${h.toStatus}:${h.reason}`)
          .sort(),
      ).toEqual(['2:SUPERSEDED>ACTIVE:rollback', '3:ACTIVE>SUPERSEDED:null']);
      expect(
        (await t.evaluate(cartOf(A.shopId, 1, 1000))).shopDiscounts,
      ).toEqual([{ shopId: A.shopId, discountMinor: 500 }]);
    });

    it.each<[string, number, number, string]>([
      ['a REJECTED version', 4, 409, 'version_not_activatable'],
      ['a QUEUED version', 5, 409, 'version_not_activatable'],
      ['the already ACTIVE version', 3, 409, 'version_not_activatable'],
      [
        'a SUPERSEDED version that never passed',
        1,
        409,
        'version_not_activatable',
      ],
      ['a version that does not exist', 99, 404, 'version_not_found'],
    ])(
      '%s is refused and nothing changes',
      async (_name, version, status, code) => {
        const fn = await setup();
        const before = {
          v: await versions(fn),
          h: await history(fn),
          a: await activeVersion(fn),
        };

        const res = await t
          .as(A.admin)
          .post(t.route(A.shopId, `/${fn}/versions/${version}/activate`));

        problem(res, status, code);
        expect({
          v: await versions(fn),
          h: await history(fn),
          a: await activeVersion(fn),
        }).toEqual(before);
      },
    );

    it('two identical requests at once: exactly one 200 and one 409, one ACTIVE version', async () => {
      const fn = await setup();

      const results = await Promise.all([
        t.as(A.admin).post(t.route(A.shopId, `/${fn}/versions/2/activate`)),
        t.as(A.owner).post(t.route(A.shopId, `/${fn}/versions/2/activate`)),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(
        (await versions(fn)).filter((v) => v.status === 'ACTIVE'),
      ).toHaveLength(1);
      expect(await activeVersion(fn)).toBe(2);
    });
  });

  it('S45 AS-22: each version is judged against the suite frozen at its submission', async () => {
    const pass = (name: string, quantity: number) =>
      quantity >= 3
        ? caseOf(name, quantity, [
            {
              lineIndex: 0,
              type: 'fixedPerUnit',
              value: 200,
              message: '3rd case off',
            },
          ])
        : caseOf(name, quantity);
    const fn = await t.newFunction(A.admin, A.shopId, 'frozen', [
      pass('A', 3),
      pass('B', 2),
    ]);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    await t
      .as(A.admin)
      .put(t.route(A.shopId, `/${fn}/tests`))
      .send({ tests: [pass('A', 3), pass('C', 4)] })
      .expect(200);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);

    await t.deliver(message(fn, 2));
    await t.deliver(message(fn, 1));
    await t
      .as(A.admin)
      .put(t.route(A.shopId, `/${fn}/tests`))
      .send({ tests: [pass('Z', 3)] })
      .expect(200);

    const rows = await versions(fn);
    expect(rows[0].verdicts?.map((v) => v.case)).toEqual(['A', 'B']);
    expect(rows[1].verdicts?.map((v) => v.case)).toEqual(['A', 'C']);
    expect(rows.map((r) => r.status)).toEqual(['SUPERSEDED', 'ACTIVE']);
    const counts = await t.pg(
      `SELECT "version", COUNT(*)::int AS n FROM "ShopFunctionTestCase" WHERE "functionId" = :fn AND "version" IS NOT NULL GROUP BY "version" ORDER BY "version"`,
      { fn },
    );
    expect(counts).toEqual([
      { version: 1, n: 2 },
      { version: 2, n: 2 },
    ]);
  });

  it('S45 AS-10: the version row, its frozen cases and the judge request commit together or not at all', async () => {
    const fn = await t.newFunction(A.admin, A.shopId);
    await t.failOutbox(true);

    const res = await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE);

    expect(res.status).toBe(500);
    await t.failOutbox(false);
    expect(await versions(fn)).toHaveLength(0);
    expect(await history(fn)).toHaveLength(0);
    expect(
      (
        await t.pg<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM "ShopFunctionTestCase" WHERE "functionId" = :fn AND "version" IS NOT NULL`,
          { fn },
        )
      )[0].n,
    ).toBe(0);
    await t.submit(A.admin, A.shopId, fn, GOOD_SOURCE).expect(202);
    expect((await versions(fn)).map((v) => v.version)).toEqual([1]);
  });
});
