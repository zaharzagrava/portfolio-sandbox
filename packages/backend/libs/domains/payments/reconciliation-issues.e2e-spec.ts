import { v4 as uuidv4 } from 'uuid';
import {
  reconciliationIssuePageSchema,
  reconciliationIssueSchema,
  reconciliationRunPageSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { Role } from '@app/domains/identity';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { createLedgerApp, type LedgerTestApp } from './testing/ledger-app';
import { count, sql } from './testing/ledger-fixtures';
import { journalId } from './domain/journal';
import { JournalPostingService } from './application/journal-posting.service';
import type { TestUser } from '@app/test/utils/catalog-app';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Reconciliation: issue board and resolution', () => {
  let t: LedgerTestApp;
  let admin: TestUser;
  let admin2: TestUser;
  let admins: TestUser[];

  beforeAll(async () => {
    t = await createLedgerApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    jest.restoreAllMocks();
    admin = await t.newUser({ role: Role.ADMIN });
    admin2 = await t.newUser({ role: Role.ADMIN });
    admins = [
      admin,
      admin2,
      await t.newUser({ role: Role.ADMIN }),
      await t.newUser({ role: Role.ADMIN }),
    ];
  });

  const seedRun = async (
    day: string,
    startedAt: Date,
    status = 'COMPLETED',
  ) => {
    const [row] = await sql<{ id: string }>(
      t.app,
      `INSERT INTO "ReconciliationRun" (provider, day, status, "startedAt", matched, issues, "finishedAt")
       VALUES ('stripe', :day, :status, :startedAt, 3, 0, :startedAt) RETURNING id`,
      { day, status, startedAt },
    );
    return row.id;
  };
  const seedIssue = async (
    runId: string,
    day: string,
    over: {
      kind?: string;
      reference?: string;
      createdAt?: Date;
      status?: string;
    } = {},
  ) => {
    const [row] = await sql<{ id: string }>(
      t.app,
      `INSERT INTO "ReconciliationIssue" ("runId", day, kind, reference, details, status, "createdAt")
       VALUES (:runId, :day, :kind, :reference, '{"type":"charge","providerAmount":100,"currency":"EUR"}', :status, :createdAt) RETURNING id`,
      {
        runId,
        day,
        kind: over.kind ?? 'MISSING_IN_LEDGER',
        reference: over.reference ?? `pi_${uuidv4().slice(0, 8)}`,
        status: over.status ?? 'OPEN',
        createdAt: over.createdAt ?? t.clock.now(),
      },
    );
    return row.id;
  };
  const resolve = (
    who: TestUser,
    id: string,
    body: unknown,
    key: string | null = `k-${uuidv4()}`,
  ) => {
    let req = t
      .as(who)
      .post(`/api/finance/reconciliation/issues/${id}/resolve`)
      .send(body as object);
    if (key !== null) req = req.set('Idempotency-Key', key);
    return req;
  };
  const issueRow = async (id: string) =>
    (
      await sql<Record<string, unknown>>(
        t.app,
        `SELECT status, resolution, note, "resolvedBy", "adjustmentJournalId" FROM "ReconciliationIssue" WHERE id = :id`,
        { id },
      )
    )[0];
  const adjustment = (over: Record<string, unknown> = {}) => ({
    currency: 'EUR',
    lines: [
      { accountId: 'PROVIDER_CLEARING', amountMinor: -100 },
      { accountId: 'CLEARING', amountMinor: 100 },
    ],
    ...over,
  });
  const books = async () => ({
    journals: await count(t.app, 'LedgerJournal'),
    entries: await count(t.app, 'LedgerEntry'),
    outbox: await count(t.app, 'Outbox', `"type" = 'ledger.journal_posted'`),
  });

  it('S14 AS-51: runs and issues list newest first by keyset with filters; bad input and tampered cursors are 400', async () => {
    const day = '2026-10-04';
    const base = t.clock.now().getTime();
    const runs = [
      await seedRun('2026-10-02', new Date(base - 3_000)),
      await seedRun('2026-10-03', new Date(base - 2_000)),
      await seedRun('2026-10-04', new Date(base - 1_000)),
    ];
    // the 45 rows have their own fixed times, so they are written together (was one by one)
    await Promise.all(
      Array.from({ length: 45 }, (_, i) =>
        seedIssue(runs[2], day, {
          kind: i % 3 === 0 ? 'AMOUNT_MISMATCH' : 'MISSING_IN_LEDGER',
          createdAt: new Date(base - 100_000 + i * 10),
        }),
      ),
    );

    const first = await t
      .as(admin)
      .get('/api/finance/reconciliation/runs?limit=2');
    expect(first.status).toBe(200);
    const page1 = reconciliationRunPageSchema.parse(first.body);
    expect(page1.items.map((r) => r.day)).toEqual(['2026-10-04', '2026-10-03']);
    expect(page1.nextCursor).not.toBeNull();
    const second = await t
      .as(admin)
      .get(
        `/api/finance/reconciliation/runs?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      );
    const page2 = reconciliationRunPageSchema.parse(second.body);
    expect(page2.items.map((r) => r.day)).toEqual(['2026-10-02']);
    expect(page2.nextCursor).toBeNull();

    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await t
        .as(admin)
        .get(
          `/api/finance/reconciliation/issues?status=OPEN&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
      expect(res.status).toBe(200);
      const page = reconciliationIssuePageSchema.parse(res.body);
      sizes.push(page.items.length);
      seen.push(...page.items.map((i) => i.id));
      await seedIssue(runs[2], day, {
        createdAt: new Date(base + 50_000 + sizes.length),
      }); // new issues keep arriving
      cursor = page.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([20, 20, 5]);
    expect(new Set(seen).size).toBe(45);

    const byKind = reconciliationIssuePageSchema.parse(
      (
        await t
          .as(admin)
          .get(
            '/api/finance/reconciliation/issues?kind=AMOUNT_MISMATCH&limit=200',
          )
      ).body,
    );
    expect(byKind.items).toHaveLength(15);
    expect(byKind.items.every((i) => i.kind === 'AMOUNT_MISMATCH')).toBe(true);
    const byDay = reconciliationIssuePageSchema.parse(
      (
        await t
          .as(admin)
          .get('/api/finance/reconciliation/issues?day=2026-10-03&limit=200')
      ).body,
    );
    expect(byDay.items).toHaveLength(0);

    for (const url of [
      '/api/finance/reconciliation/runs?limit=0',
      '/api/finance/reconciliation/runs?limit=201',
      '/api/finance/reconciliation/issues?limit=0',
      '/api/finance/reconciliation/issues?status=DONE',
      '/api/finance/reconciliation/issues?kind=NOPE',
      '/api/finance/reconciliation/issues?day=2026-02-30x',
    ])
      expect([url, (await t.as(admin).get(url)).status]).toEqual([url, 400]);
    const tampered = await t
      .as(admin)
      .get('/api/finance/reconciliation/runs?cursor=abc.def');
    expect(tampered.status).toBe(400);
    expect(tampered.body.code).toBe('invalid_cursor');
  });

  it('S14 AS-52: anonymous callers get 401 and a seller owner gets 403 without any run or issue data', async () => {
    const run = await seedRun('2026-10-04', t.clock.now());
    const id = await seedIssue(run, '2026-10-04', {
      reference: 'pi_secret_ref',
    });
    const seller = await t.newUser();
    await createShop(t.app, seller);
    const routes: Array<['get' | 'post', string]> = [
      ['get', '/api/finance/reconciliation/runs'],
      ['get', '/api/finance/reconciliation/issues'],
      ['post', `/api/finance/reconciliation/issues/${id}/resolve`],
    ];
    for (const [method, url] of routes) {
      expect((await t.http()[method](url).send({})).status).toBe(401);
      const denied = await t
        .as(seller)
        [method](url)
        .set('Idempotency-Key', 'k-1234567890')
        .send({ resolution: 'explained', note: 'x' });
      expect([url, denied.status]).toEqual([url, 403]);
      expect(denied.body.code).toBe('permission_denied');
      expect(JSON.stringify(denied.body)).not.toContain('pi_secret_ref');
    }
    expect((await issueRow(id)).status).toBe('OPEN');
  });

  it('S14 AS-53: resolving as explained records who, when and why without touching the books', async () => {
    const run = await seedRun('2026-10-04', t.clock.now());
    const id = await seedIssue(run, '2026-10-04');
    const res = await resolve(admin, id, {
      resolution: 'explained',
      note: 'Provider fee rounding, ticket 4411',
    });
    expect(res.status).toBe(200);
    const body = reconciliationIssueSchema.parse(res.body);
    expect(body).toMatchObject({
      id,
      status: 'RESOLVED',
      resolution: 'explained',
      resolvedBy: admin.id,
      note: 'Provider fee rounding, ticket 4411',
      adjustmentJournalId: null,
    });
    expect(body.resolvedAt).not.toBeNull();
    expect(await books()).toEqual({ journals: 0, entries: 0, outbox: 0 });
    expect(
      await count(
        t.app,
        'ReconciliationIssueHistory',
        `"issueId" = :id AND "to" = 'RESOLVED' AND actor = :a`,
        { id, a: admin.id },
      ),
    ).toBe(1);
    expect(
      metric('reconciliation_issues_open', { kind: 'MISSING_IN_LEDGER' }),
    ).toBe(0);
  });

  it('S14 AS-54: resolving as adjusted posts one balanced ADJUSTMENT now, for the closed day, in the same transaction; the day is untouched', async () => {
    const day = '2026-10-04';
    const run = await seedRun(day, t.clock.now());
    const id = await seedIssue(run, day);
    // an entry of the closed day exists and must not change
    await t.inTx((tx) =>
      t.ledger.postJournal(
        {
          kind: 'ADJUSTMENT',
          reference: 'day-entry',
          currency: 'EUR',
          lines: [
            { accountId: 'PAYOUTS_SENT', amountMinor: -5 },
            { accountId: 'PLATFORM_FEES', amountMinor: 5 },
          ],
        },
        tx,
      ),
    );
    const digest = () =>
      sql<{ d: string }>(
        t.app,
        `SELECT md5(string_agg(e::text, ',' ORDER BY e.id)) AS d FROM "LedgerEntry" e WHERE "journalId" = :j`,
        { j: journalId('ADJUSTMENT', 'day-entry') },
      );
    const runBefore = await sql(
      t.app,
      `SELECT matched, issues, status FROM "ReconciliationRun" WHERE id = :id`,
      { id: run },
    );
    const before = await digest();
    t.clock.advance(60_000);

    const res = await resolve(admin, id, {
      resolution: 'adjusted',
      note: 'Missing capture, booked by finance',
      adjustment: adjustment(),
    });
    expect(res.status).toBe(200);
    const expectedJournal = journalId('ADJUSTMENT', `issue:${id}`);
    expect(res.body.adjustmentJournalId).toBe(expectedJournal);
    const [header] = await sql<{
      kind: string;
      postedAt: Date;
      correctsDay: string;
    }>(
      t.app,
      `SELECT kind, "postedAt", "correctsDay"::text AS "correctsDay" FROM "LedgerJournal" WHERE id = :id`,
      { id: expectedJournal },
    );
    expect(header).toMatchObject({ kind: 'ADJUSTMENT', correctsDay: day });
    expect(header.postedAt.getTime()).toBe(t.clock.now().getTime()); // never backdated
    expect(
      await count(t.app, 'LedgerEntry', `"journalId" = :j`, {
        j: expectedJournal,
      }),
    ).toBe(2);
    expect(
      await count(
        t.app,
        'Outbox',
        `"type" = 'ledger.journal_posted' AND "aggregateId" = :j`,
        { j: expectedJournal },
      ),
    ).toBe(1);
    expect(
      await count(t.app, 'ReconciliationIssueHistory', `"issueId" = :id`, {
        id,
      }),
    ).toBe(1);
    expect(await digest()).toEqual(before);
    expect(
      await sql(
        t.app,
        `SELECT matched, issues, status FROM "ReconciliationRun" WHERE id = :id`,
        { id: run },
      ),
    ).toEqual(runBefore);

    // atomic: an adjustment the books refuse leaves the issue open and writes no history
    const other = await seedIssue(run, day);
    const refused = await resolve(admin, other, {
      resolution: 'adjusted',
      note: 'will fail',
      adjustment: adjustment({
        lines: [
          { accountId: 'PAYOUT_CLEARING', amountMinor: -100 },
          { accountId: 'PLATFORM_FEES', amountMinor: 100 },
        ],
      }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('insufficient_balance');
    expect((await issueRow(other)).status).toBe('OPEN');
    expect(
      await count(t.app, 'ReconciliationIssueHistory', `"issueId" = :id`, {
        id: other,
      }),
    ).toBe(0);
  });

  it('S14 AS-55: ten bad bodies are refused with their own status and change nothing', async () => {
    const run = await seedRun('2026-10-04', t.clock.now());
    const id = await seedIssue(run, '2026-10-04');
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        accountId: i === 0 ? 'PLATFORM_FEES' : 'PAYOUTS_SENT',
        amountMinor: i === 0 ? -(n - 1) : 1,
      }));
    const cases: Array<[string, unknown, number, string?]> = [
      [
        'adjusted without adjustment',
        { resolution: 'adjusted', note: 'n' },
        400,
      ],
      [
        'explained with adjustment',
        { resolution: 'explained', note: 'n', adjustment: adjustment() },
        400,
      ],
      ['an empty note', { resolution: 'explained', note: '' }, 400],
      [
        'a 501-character note',
        { resolution: 'explained', note: 'x'.repeat(501) },
        400,
      ],
      ['an unknown resolution', { resolution: 'ignored', note: 'n' }, 400],
      [
        'an unknown property',
        { resolution: 'explained', note: 'n', extra: 1 },
        400,
      ],
      [
        'a currency other than EUR',
        {
          resolution: 'adjusted',
          note: 'n',
          adjustment: adjustment({ currency: 'USD' }),
        },
        400,
      ],
      [
        'an unbalanced adjustment',
        {
          resolution: 'adjusted',
          note: 'n',
          adjustment: adjustment({
            lines: [
              { accountId: 'PLATFORM_FEES', amountMinor: -100 },
              { accountId: 'PAYOUTS_SENT', amountMinor: 99 },
            ],
          }),
        },
        422,
        'adjustment_unbalanced',
      ],
      [
        'an account outside the chart',
        {
          resolution: 'adjusted',
          note: 'n',
          adjustment: adjustment({
            lines: [
              { accountId: 'FOO', amountMinor: -100 },
              { accountId: 'PAYOUTS_SENT', amountMinor: 100 },
            ],
          }),
        },
        422,
        'adjustment_account_invalid',
      ],
      [
        'eleven lines',
        {
          resolution: 'adjusted',
          note: 'n',
          adjustment: adjustment({ lines: lines(11) }),
        },
        422,
        'adjustment_too_large',
      ],
    ];
    for (const [name, body, status, code] of cases) {
      const res = await resolve(admin, id, body);
      expect([name, res.status]).toEqual([name, status]);
      if (code) expect([name, res.body.code]).toEqual([name, code]);
      expect((await issueRow(id)).status).toBe('OPEN');
      expect(await books()).toEqual({ journals: 0, entries: 0, outbox: 0 });
    }
    expect(
      (
        await resolve(admin, 'not-a-uuid', {
          resolution: 'explained',
          note: 'n',
        })
      ).status,
    ).toBe(400);
  });

  it('S14 AS-56: a resolved issue (also an auto-resolved one) answers 409, an unknown id 404', async () => {
    const run = await seedRun('2026-10-04', t.clock.now());
    const id = await seedIssue(run, '2026-10-04');
    expect(
      (await resolve(admin, id, { resolution: 'explained', note: 'first' }))
        .status,
    ).toBe(200);
    const again = await resolve(admin, id, {
      resolution: 'explained',
      note: 'second',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('issue_already_resolved');
    expect((await issueRow(id)).note).toBe('first');

    const auto = await seedIssue(run, '2026-10-04');
    await sql(
      t.app,
      `UPDATE "ReconciliationIssue" SET status = 'RESOLVED', resolution = 'auto_matched', "resolvedBy" = 'system' WHERE id = :auto RETURNING id`,
      { auto },
    );
    expect(
      (await resolve(admin, auto, { resolution: 'explained', note: 'late' }))
        .body.code,
    ).toBe('issue_already_resolved');

    const missing = await resolve(admin, uuidv4(), {
      resolution: 'explained',
      note: 'x',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('reconciliation_issue_not_found');
  });

  it('S14 AS-57: the resolve request is idempotent: replay, in flight, other body, missing key', async () => {
    const run = await seedRun('2026-10-04', t.clock.now());
    const id = await seedIssue(run, '2026-10-04');
    const body = {
      resolution: 'adjusted',
      note: 'booked',
      adjustment: adjustment(),
    };
    const first = await resolve(admin, id, body, 'k1-key-00000001');
    expect(first.status).toBe(200);
    const replay = await resolve(admin, id, body, 'k1-key-00000001');
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(await count(t.app, 'LedgerJournal')).toBe(1);

    expect(
      (await resolve(admin, id, { ...body, note: 'other' }, 'k1-key-00000001'))
        .body.code,
    ).toBe('idempotency_key_reuse');
    expect((await resolve(admin, id, body, null)).body.code).toBe(
      'idempotency_key_required',
    );
    expect((await resolve(admin, id, body, '')).status).toBe(422);

    // while the first request is still running, a second with the same key is 409 with Retry-After
    const run2 = await seedRun('2026-10-05', t.clock.now());
    const id2 = await seedIssue(run2, '2026-10-05');
    const posting = t.app.get(JournalPostingService);
    const original = posting.post.bind(posting);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    jest.spyOn(posting, 'post').mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const slow = resolve(admin, id2, body, 'k2-key-00000002').then((r) => r);
    await inside;
    const concurrent = await resolve(admin, id2, body, 'k2-key-00000002');
    expect(concurrent.status).toBe(409);
    expect(concurrent.body.code).toBe('idempotency_in_flight');
    expect(concurrent.headers['retry-after']).toBeDefined();
    release();
    expect((await slow).status).toBe(200);
    expect(await count(t.app, 'LedgerJournal')).toBe(2);
  });

  it('S14 AS-58: two admins resolving the same issue at once (50 times): one 200, one 409, at most one journal, one history entry', async () => {
    const run = await seedRun('2026-10-04', t.clock.now());
    for (let round = 0; round < 50; round++) {
      const id = await seedIssue(run, '2026-10-04');
      const body = {
        resolution: 'adjusted',
        note: `round ${round}`,
        adjustment: adjustment(),
      };
      // four admins take turns, so none passes the 30-per-minute write limit of AS-59
      const [a, b] = await Promise.all([
        resolve(admins[(2 * round) % 4], id, body),
        resolve(admins[(2 * round + 1) % 4], id, body),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(
        await count(t.app, 'LedgerJournal', `"reference" = :r`, {
          r: `issue:${id}`,
        }),
      ).toBe(1);
      expect(
        await count(t.app, 'ReconciliationIssueHistory', `"issueId" = :id`, {
          id,
        }),
      ).toBe(1);
      expect(
        await count(
          t.app,
          'Outbox',
          `"type" = 'ledger.journal_posted' AND "aggregateId" = :j`,
          { j: journalId('ADJUSTMENT', `issue:${id}`) },
        ),
      ).toBe(1);
    }
  }, 180_000);

  it('S14 AS-59: the 31st resolve in a minute is 429 with Retry-After', async () => {
    const run = await seedRun('2026-10-04', t.clock.now());
    // 30 resolves at once (was one by one); every answer is still checked
    const answers = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const issueId = await seedIssue(run, '2026-10-04');
        return resolve(admin, issueId, {
          resolution: 'explained',
          note: `n${i}`,
        });
      }),
    );
    for (const answer of answers) expect(answer.status).toBe(200);
    const id = await seedIssue(run, '2026-10-04');
    const limited = await resolve(admin, id, {
      resolution: 'adjusted',
      note: 'n',
      adjustment: adjustment(),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await issueRow(id)).status).toBe('OPEN');
    expect(await count(t.app, 'LedgerJournal')).toBe(0);
  }, 120_000);

  // Last in the file: it boots a second app, and the models are bound to the newest connection.
  it('S14 AS-59: with the limiter store down a resolve is refused (fail closed) and no journal is posted', async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    const proxy = await TcpFaultProxy.start({
      host: redis.hostname,
      port: Number(redis.port || 6379),
    });
    const own = await createLedgerApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/${new URL(process.env.REDIS_URL ?? "redis://localhost:6400/0").pathname.slice(1) || "0"}`,
    });
    try {
      await own.reset();
      const who = await own.newUser({ role: Role.ADMIN });
      const [run] = await sql<{ id: string }>(
        own.app,
        `INSERT INTO "ReconciliationRun" (provider, day, status, "finishedAt") VALUES ('stripe', '2026-10-04', 'COMPLETED', now()) RETURNING id`,
      );
      const [issue] = await sql<{ id: string }>(
        own.app,
        `INSERT INTO "ReconciliationIssue" ("runId", day, kind, reference) VALUES (:r, '2026-10-04', 'MISSING_IN_LEDGER', 'pi_x') RETURNING id`,
        { r: run.id },
      );
      proxy.mode = 'refuse';
      proxy.sever();
      await new Promise((r) => setTimeout(r, 300));
      const res = await own
        .as(who)
        .post(`/api/finance/reconciliation/issues/${issue.id}/resolve`)
        .set('Idempotency-Key', 'k-down-000001')
        .send({ resolution: 'adjusted', note: 'n', adjustment: adjustment() });
      expect([429, 503]).toContain(res.status);
      expect(res.status).toBeGreaterThanOrEqual(429);
      expect(await count(own.app, 'LedgerJournal')).toBe(0);
    } finally {
      proxy.mode = 'pass';
      await own.close();
      await proxy.close();
    }
  }, 60_000);
});
