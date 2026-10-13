import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { createLedgerApp, type LedgerTestApp } from './testing/ledger-app';
import { count, sql } from './testing/ledger-fixtures';
import {
  FakeProviderStatement,
  statementLine,
} from './testing/fake-provider-statement';
import { PROVIDER_STATEMENT } from './domain/ledger-ports';
import { LedgerProcessingModule } from './ledger-processing.module';
import { ReconciliationJobs } from './infra/reconciliation.jobs';
import {
  ReconciliationRunService,
  type RunOutcome,
} from './application/reconciliation-run.service';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

const fake = new FakeProviderStatement();
const DAY = '2026-10-04';
const NEXT = '2026-10-05';
const T_RUN = new Date('2026-10-06T02:30:00.000Z'); // both days are closed

describe('Reconciliation: daily provider run', () => {
  let t: LedgerTestApp;
  let runs: ReconciliationRunService;
  let jobs: ReconciliationJobs;

  beforeAll(async () => {
    t = await createLedgerApp({
      extraImports: [LedgerProcessingModule],
      overrides: [{ provide: PROVIDER_STATEMENT, useValue: fake }],
    });
    runs = t.app.get(ReconciliationRunService, { strict: false });
    jobs = t.app.get(ReconciliationJobs, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    fake.reset();
    t.clock.set(T_RUN);
    jest.restoreAllMocks();
  });

  /** A captured sale posted at `at` (the journal's postedAt), with its provider reference. */
  const sale = async (
    paymentRef: string,
    amountMinor = 100,
    at = new Date(`${DAY}T12:00:00.000Z`),
    currency = 'EUR',
  ) => {
    const keep = t.clock.now();
    t.clock.set(at);
    try {
      return await t.inTx((tx) =>
        t.ledger.recordPaymentCaptured(
          {
            paymentId: uuidv4(),
            orderId: uuidv4(),
            paymentRef,
            userId: uuidv4(),
            amountMinor,
            currency,
          },
          tx,
        ),
      );
    } finally {
      t.clock.set(keep);
    }
  };
  const refund = async (
    paymentId: string,
    refundRef: string,
    amountMinor = 100,
    at = new Date(`${DAY}T13:00:00.000Z`),
  ) => {
    const keep = t.clock.now();
    t.clock.set(at);
    try {
      return await t.inTx((tx) =>
        t.ledger.recordPaymentRefunded(
          { paymentId, refundRef, amountMinor, currency: 'EUR' },
          tx,
        ),
      );
    } finally {
      t.clock.set(keep);
    }
  };
  const salePayment = async (
    paymentRef: string,
    amountMinor = 100,
    at?: Date,
  ) => {
    const paymentId = uuidv4();
    const keep = t.clock.now();
    t.clock.set(at ?? new Date(`${DAY}T12:00:00.000Z`));
    try {
      await t.inTx((tx) =>
        t.ledger.recordPaymentCaptured(
          {
            paymentId,
            orderId: uuidv4(),
            paymentRef,
            userId: uuidv4(),
            amountMinor,
            currency: 'EUR',
          },
          tx,
        ),
      );
    } finally {
      t.clock.set(keep);
    }
    return paymentId;
  };
  const run = (day = DAY, options = {}) => runs.runDay(day, options);
  const issues = (runDay = DAY) =>
    sql<{
      kind: string;
      reference: string;
      status: string;
      details: Record<string, unknown>;
      resolution: string | null;
      resolvedBy: string | null;
    }>(
      t.app,
      `SELECT kind, reference, status, details, resolution, "resolvedBy" FROM "ReconciliationIssue" WHERE day = :d ORDER BY kind, reference`,
      { d: runDay },
    );
  const runRow = async (day = DAY) =>
    (
      await sql<Record<string, unknown>>(
        t.app,
        `SELECT status, "failureCode", "providerLines", "ledgerJournals", matched, issues, skipped FROM "ReconciliationRun" WHERE day = :d`,
        { d: day },
      )
    )[0];
  const events = (type: string) =>
    sql<{ aggregateId: string; payload: { payload: Record<string, unknown> } }>(
      t.app,
      `SELECT "aggregateId", "payload" FROM "Outbox" WHERE "type" = :type ORDER BY "createdAt", "id"`,
      { type },
    );
  const completed = (o: RunOutcome) => {
    expect(o.outcome).toBe('completed');
    return o as Extract<RunOutcome, { outcome: 'completed' }>;
  };

  it('S14 AS-38: a clean day completes with every line matched, no issue, one completed event and a metric', async () => {
    const before = metric('reconciliation_runs_total', { status: 'completed' });
    const p1 = await salePayment('pi_1');
    await salePayment('pi_2', 200);
    await salePayment('pi_3', 300);
    await refund(p1, 're_1', 100);
    fake.lines = [
      statementLine({ reference: 'pi_1', amount: 100 }),
      statementLine({ reference: 'pi_2', amount: 200 }),
      statementLine({ reference: 'pi_3', amount: 300 }),
      statementLine({ type: 'refund', reference: 're_1', amount: -100 }),
    ];
    const outcome = completed(await run());
    expect(outcome.opened).toBe(0);
    expect(await runRow()).toMatchObject({
      status: 'COMPLETED',
      providerLines: 4,
      ledgerJournals: 4,
      matched: 4,
      issues: 0,
    });
    expect(await count(t.app, 'ReconciliationIssue')).toBe(0);
    const done = await events('ledger.reconciliation_completed');
    expect(done).toHaveLength(1);
    expect(done[0].payload.payload).toMatchObject({
      provider: 'stripe',
      day: DAY,
      status: 'COMPLETED',
      matched: 4,
      issueCount: 0,
    });
    expect(metric('reconciliation_runs_total', { status: 'completed' })).toBe(
      before + 1,
    );
  });

  it('S14 AS-39: missing, extra, different amount and different currency become four open issues with an event each', async () => {
    await salePayment('pi_b', 100);
    await salePayment('pi_c', 100);
    await salePayment('pi_d', 100);
    await salePayment('pi_e', 100);
    fake.lines = [
      statementLine({ reference: 'pi_a', amount: 100 }),
      statementLine({ reference: 'pi_c', amount: 150 }),
      statementLine({ reference: 'pi_d', amount: 100, currency: 'usd' }),
      statementLine({ reference: 'pi_e', amount: 100 }),
    ];
    completed(await run());
    const got = await issues();
    expect(got.map((i) => [i.kind, i.reference, i.status])).toEqual([
      ['AMOUNT_MISMATCH', 'pi_c', 'OPEN'],
      ['CURRENCY_MISMATCH', 'pi_d', 'OPEN'],
      ['MISSING_AT_PROVIDER', 'pi_b', 'OPEN'],
      ['MISSING_IN_LEDGER', 'pi_a', 'OPEN'],
    ]);
    expect(got.find((i) => i.reference === 'pi_a')!.details).toMatchObject({
      providerAmount: 100,
    });
    expect(got.find((i) => i.reference === 'pi_b')!.details).toMatchObject({
      ledgerAmount: 100,
    });
    expect(got.find((i) => i.reference === 'pi_c')!.details).toMatchObject({
      ledger: 100,
      provider: 150,
    });
    expect(await runRow()).toMatchObject({
      matched: 1,
      issues: 4,
      providerLines: 4,
      ledgerJournals: 4,
    });
    expect(await events('ledger.reconciliation_issue_opened')).toHaveLength(4);
    const open = (kind: string) =>
      metric('reconciliation_issues_open', { kind });
    expect([
      open('AMOUNT_MISMATCH'),
      open('CURRENCY_MISMATCH'),
      open('MISSING_AT_PROVIDER'),
      open('MISSING_IN_LEDGER'),
      open('DUPLICATE_AT_PROVIDER'),
    ]).toEqual([1, 1, 1, 1, 0]);
  });

  it('S14 AS-40: refunds, disputes and duplicates are typed issues, and the run never posts to the ledger', async () => {
    const p = await salePayment('pi_ours', 100);
    await refund(p, 're_1', 100);
    fake.lines = [
      statementLine({ reference: 'pi_ours', amount: 100 }),
      statementLine({ type: 'refund', reference: 're_x', amount: -40 }),
      statementLine({ type: 'dispute', reference: 'dp_1', amount: -2500 }),
      statementLine({ id: 'txn_dup1', reference: 'pi_dup', amount: 100 }),
      statementLine({ id: 'txn_dup2', reference: 'pi_dup', amount: 100 }),
    ];
    const entriesBefore = await count(t.app, 'LedgerEntry');
    completed(await run());
    const got = await issues();
    const find = (kind: string, reference: string) =>
      got.find((i) => i.kind === kind && i.reference === reference);
    expect(find('MISSING_IN_LEDGER', 're_x')!.details).toMatchObject({
      type: 'refund',
    });
    expect(find('MISSING_IN_LEDGER', 'dp_1')!.details).toMatchObject({
      type: 'dispute',
    });
    expect(find('DUPLICATE_AT_PROVIDER', 'pi_dup')!.details).toMatchObject({
      lineIds: ['txn_dup1', 'txn_dup2'],
    });
    expect(find('MISSING_AT_PROVIDER', 're_1')!.details).toMatchObject({
      type: 'refund',
    });
    expect(await count(t.app, 'LedgerEntry')).toBe(entriesBefore);
  });

  it('S14 AS-41: a completed day is final: a repeat (also two at once) makes no provider call and changes nothing', async () => {
    await salePayment('pi_1');
    fake.lines = [
      statementLine({ reference: 'pi_1' }),
      statementLine({ reference: 'pi_zz' }),
    ];
    completed(await run());
    const calls = fake.calls.length;
    const before = JSON.stringify([await runRow(), await issues()]);
    const again = await Promise.all([
      run(),
      run(),
      jobs.reconcile({ day: DAY }),
    ]);
    expect(again.flat().map((o) => o.outcome)).toEqual([
      'already_completed',
      'already_completed',
      'already_completed',
    ]);
    expect(fake.calls.length).toBe(calls);
    expect(JSON.stringify([await runRow(), await issues()])).toBe(before);
    expect(await count(t.app, 'ReconciliationRun')).toBe(1);
  });

  it('S14 AS-42: two workers at once: one reads the statement, the other is told it is running', async () => {
    await salePayment('pi_1');
    fake.lines = [statementLine({ reference: 'pi_1' })];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fake.beforePage = () => gate;
    const first = run();
    while (fake.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await run();
    expect(second.outcome).toBe('already_running');
    release();
    completed(await first);
    expect(fake.calls.filter((c) => c.op === 'list')).toHaveLength(1);
    expect(await count(t.app, 'ReconciliationRun')).toBe(1);
  });

  it('S14 AS-43: a crashed run restarts the day: exactly the correct issues, no duplicates, COMPLETED', async () => {
    fake.lines = [statementLine({ reference: 'pi_real', amount: 100 })];
    const runId = uuidv4();
    await sql(
      t.app,
      `INSERT INTO "ReconciliationRun" (id, provider, day, status, "startedAt", "leaseUntil") VALUES (:id, 'stripe', :d, 'RUNNING', :started, :lease) RETURNING id`,
      {
        id: runId,
        d: DAY,
        started: new Date(T_RUN.getTime() - 3_600_000),
        lease: new Date(T_RUN.getTime() - 60_000),
      },
    );
    for (const [kind, reference] of [
      ['MISSING_IN_LEDGER', 'pi_stale1'],
      ['MISSING_AT_PROVIDER', 'pi_stale2'],
      ['MISSING_IN_LEDGER', 'pi_real'],
    ])
      await sql(
        t.app,
        `INSERT INTO "ReconciliationIssue" ("runId", day, kind, reference, details) VALUES (:runId, :d, :kind, :reference, '{}') RETURNING id`,
        { runId, d: DAY, kind, reference },
      );
    await sql(
      t.app,
      `INSERT INTO "ReconciliationStaging" ("runId", kind, reference) VALUES (:runId, 'MISSING_IN_LEDGER', 'pi_old') RETURNING "runId"`,
      { runId },
    );

    completed(await run());
    const got = await issues();
    expect(got.map((i) => [i.kind, i.reference])).toEqual([
      ['MISSING_IN_LEDGER', 'pi_real'],
    ]);
    expect(await runRow()).toMatchObject({ status: 'COMPLETED', issues: 1 });
    expect(await count(t.app, 'ReconciliationStaging')).toBe(0);
    expect(await count(t.app, 'ReconciliationRun')).toBe(1);
  });

  it('S14 AS-44: 25 000 lines in 250 pages stream with backpressure, one page buffered, a heartbeat at least every 1 000 lines, repeated lines counted once', async () => {
    await sql(
      t.app,
      `INSERT INTO "LedgerJournal" (id, kind, reference, currency, "postedAt", fingerprint, "paymentId", "orderId", "paymentRef", "amountMinor", "clearingMinor")
       SELECT gen_random_uuid(), 'SALE', 'bulk-' || n, 'EUR', :at::timestamptz, repeat('0', 64), gen_random_uuid(), gen_random_uuid(), 'pi_bulk_' || n, 100, 50
         FROM generate_series(1, 25000) AS n RETURNING 1`,
      { at: `${DAY}T10:00:00.000Z` },
    );
    const unique = Array.from({ length: 25_000 }, (_, i) =>
      statementLine({
        id: `txn_bulk_${i}`,
        reference: `pi_bulk_${i + 1}`,
        amount: 100,
      }),
    );
    fake.lines = [
      ...unique.slice(0, 5_000),
      ...unique.slice(0, 100),
      ...unique.slice(5_000),
    ]; // page 51 repeats page 1
    const processed: number[] = [];
    const processedAtRequest: number[] = [];
    fake.beforePage = (page) =>
      void (processedAtRequest[page] = processed.length);
    let beats = 0;
    const outcome = completed(
      await run(DAY, {
        heartbeat: async () => void beats++,
        onPageProcessed: (n: number) => void processed.push(n),
      }),
    );
    for (let page = 1; page <= processed.length; page++)
      expect([page, processedAtRequest[page]]).toEqual([page, page - 1]);
    expect(processed).toHaveLength(251);
    expect(fake.maxOutstanding).toBeLessThanOrEqual(1);
    expect(beats).toBeGreaterThanOrEqual(25);
    expect(outcome.run).toMatchObject({
      providerLines: 25_000,
      matched: 25_000,
      issues: 0,
    });
    expect(await runRow()).toMatchObject({
      providerLines: 25_000,
      ledgerJournals: 25_000,
      matched: 25_000,
      issues: 0,
    });
  }, 240_000);

  it.each([
    ['timeout' as const],
    ['rate_limited' as const],
    ['unavailable' as const],
  ])(
    'S14 AS-45: a %s on page 3 fails the run as provider_unavailable with no issue stored, and attempt 2 completes the day',
    async (fault) => {
      const earlier = await sql<{ id: string }>(
        t.app,
        `INSERT INTO "ReconciliationRun" (provider, day, status, matched, issues, "finishedAt") VALUES ('stripe', :d, 'COMPLETED', 7, 0, now()) RETURNING id`,
        { d: '2026-10-03' },
      );
      fake.lines = Array.from({ length: 450 }, (_, i) =>
        statementLine({ id: `txn_${i}`, reference: `pi_p_${i}`, amount: 100 }),
      );
      fake.failOn(3, fault);
      const failedBefore = metric('reconciliation_runs_total', {
        status: 'failed',
      });
      await expect(run()).rejects.toThrow();
      expect(await runRow()).toMatchObject({
        status: 'FAILED',
        failureCode: 'provider_unavailable',
      });
      expect(await count(t.app, 'ReconciliationIssue')).toBe(0);
      expect(await count(t.app, 'ReconciliationStaging')).toBe(0);
      expect(metric('reconciliation_runs_total', { status: 'failed' })).toBe(
        failedBefore + 1,
      );
      expect(
        fake.calls.filter((c) => c.op === 'list' && c.page === 3),
      ).toHaveLength(1); // the adapter made no retry
      expect(await runRow('2026-10-03')).toMatchObject({
        status: 'COMPLETED',
        matched: 7,
      });
      expect(earlier).toHaveLength(1);

      completed(await run()); // attempt 2 of the job layer
      expect(await runRow()).toMatchObject({
        status: 'COMPLETED',
        failureCode: null,
      });
      expect(await count(t.app, 'ReconciliationRun')).toBe(2);
    },
  );

  it('S14 AS-45: the daily job allows three attempts', () => {
    expect(getJobTypeDeclaration('payments.reconcile-daily')?.maxAttempts).toBe(
      3,
    );
  });

  it('S14 AS-46: untrusted lines: invalid ones become position-only issues, unknown and payout types are skipped and counted, the run completes', async () => {
    const skippedUnknown = metric('reconciliation_lines_skipped_total', {
      type: 'unknown',
    });
    const skippedTransfer = metric('reconciliation_lines_skipped_total', {
      type: 'transfer',
    });
    fake.lines = [
      statementLine({ id: undefined, note: 'SECRET-BODY-1' }),
      statementLine({ amount: 12.5, note: 'SECRET-BODY-2' }),
      statementLine({ currency: 'euro', note: 'SECRET-BODY-3' }),
      statementLine({ type: 'adjustment_x' }),
      statementLine({ type: 'transfer' }),
    ];
    completed(await run());
    const got = await issues();
    expect(got.map((i) => [i.kind, i.reference])).toEqual([
      ['INVALID_PROVIDER_RECORD', 'position:1'],
      ['INVALID_PROVIDER_RECORD', 'position:2'],
      ['INVALID_PROVIDER_RECORD', 'position:3'],
    ]);
    expect(JSON.stringify(got)).not.toContain('SECRET-BODY');
    expect(got[0].details).toEqual({ position: 1 });
    expect(await runRow()).toMatchObject({
      status: 'COMPLETED',
      skipped: 2,
      providerLines: 5,
    });
    expect(
      metric('reconciliation_lines_skipped_total', { type: 'unknown' }),
    ).toBe(skippedUnknown + 1);
    expect(
      metric('reconciliation_lines_skipped_total', { type: 'transfer' }),
    ).toBe(skippedTransfer + 1);
  });

  it('S14 AS-47: a charge across midnight is matched by reference on both sides; a never-posted one is missing in the ledger', async () => {
    // provider charge 23:59:58 on DAY, journal posted 00:00:03 on NEXT
    await salePayment('pi_late', 100, new Date(`${NEXT}T00:00:03.000Z`));
    fake.lines = [
      statementLine({
        reference: 'pi_late',
        created: Date.parse(`${DAY}T23:59:58.000Z`) / 1000,
      }),
    ];
    fake.known.add('pi_late');
    completed(await run(DAY));
    expect(await issues(DAY)).toEqual([]);
    fake.lines = [];
    completed(await run(NEXT));
    expect(await issues(NEXT)).toEqual([]);

    // journal at DAY 23:59:59, provider charge created NEXT 00:00:02: neither run reports it missing at the provider
    await salePayment('pi_early', 100, new Date(`${DAY}T23:59:59.000Z`));
    fake.known.add('pi_early');
    await t.reset();
    fake.reset();
    t.clock.set(T_RUN);
    await salePayment('pi_early', 100, new Date(`${DAY}T23:59:59.000Z`));
    fake.known.add('pi_early');
    fake.lines = [];
    completed(await run(DAY));
    fake.lines = [
      statementLine({
        reference: 'pi_early',
        created: Date.parse(`${NEXT}T00:00:02.000Z`) / 1000,
      }),
    ];
    completed(await run(NEXT));
    expect(await count(t.app, 'ReconciliationIssue')).toBe(0);

    // never posted: reported for the day it was charged
    await t.reset();
    fake.reset();
    t.clock.set(T_RUN);
    fake.lines = [
      statementLine({
        reference: 'pi_never',
        created: Date.parse(`${DAY}T23:59:58.000Z`) / 1000,
      }),
    ];
    completed(await run(DAY));
    expect((await issues(DAY)).map((i) => [i.kind, i.reference])).toEqual([
      ['MISSING_IN_LEDGER', 'pi_never'],
    ]);
  });

  it('S14 AS-48: only closed days within 90 days may run; with no day it runs yesterday and catches up missing days oldest first', async () => {
    t.clock.set(new Date('2026-10-05T02:30:00.000Z'));
    for (const [day, code] of [
      ['2026-10-05', 'day_not_closed'],
      ['2026-10-06', 'day_not_closed'],
      ['2026-02-30', 'day_invalid'],
      ['2026-13-01', 'day_invalid'],
      ['banana', 'day_invalid'],
      ['2026-06-01', 'day_out_of_range'],
    ])
      await expect(jobs.reconcile({ day })).rejects.toThrow(code);
    expect(await count(t.app, 'ReconciliationRun')).toBe(0);

    const spy = jest.spyOn(runs, 'runDay');
    fake.lines = [];
    await jobs.reconcile({});
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);

    spy.mockClear();
    await t.reset();
    t.clock.set(new Date('2026-10-05T02:30:00.000Z'));
    for (const day of [
      '2026-09-28',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-04',
    ])
      await sql(
        t.app,
        `INSERT INTO "ReconciliationRun" (provider, day, status, "finishedAt") VALUES ('stripe', :day, 'COMPLETED', now()) RETURNING id`,
        { day },
      );
    await jobs.reconcile({});
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      '2026-09-29',
      '2026-10-03',
    ]);
  });

  it('S14 AS-49: an open timing issue of the last three days closes itself once the journal exists; others stay open', async () => {
    fake.lines = [
      statementLine({ reference: 'pi_a', amount: 100 }),
      statementLine({ reference: 'pi_b', amount: 100 }),
    ];
    completed(await run('2026-10-03'));
    expect((await issues('2026-10-03')).map((i) => i.status)).toEqual([
      'OPEN',
      'OPEN',
    ]);
    // an old issue (five days back) that matches by now is not looked at
    const oldRun = await sql<{ id: string }>(
      t.app,
      `INSERT INTO "ReconciliationRun" (provider, day, status, "finishedAt") VALUES ('stripe', '2026-09-28', 'COMPLETED', now()) RETURNING id`,
    );
    await sql(
      t.app,
      `INSERT INTO "ReconciliationIssue" ("runId", day, kind, reference, details) VALUES (:r, '2026-09-28', 'MISSING_IN_LEDGER', 'pi_old', '{"type":"charge","providerAmount":100,"currency":"EUR"}') RETURNING id`,
      { r: oldRun[0].id },
    );
    await salePayment('pi_a', 100, new Date(`${DAY}T01:00:00.000Z`));
    await salePayment('pi_old', 100, new Date(`${DAY}T01:00:00.000Z`));
    fake.lines = [];
    completed(await run(DAY));
    const third = await issues('2026-10-03');
    expect(third.find((i) => i.reference === 'pi_a')).toMatchObject({
      status: 'RESOLVED',
      resolution: 'auto_matched',
      resolvedBy: 'system',
    });
    expect(third.find((i) => i.reference === 'pi_b')!.status).toBe('OPEN');
    expect((await issues('2026-09-28'))[0].status).toBe('OPEN');
    expect(
      await count(
        t.app,
        'ReconciliationIssueHistory',
        `"resolution" = 'auto_matched' AND actor = 'system'`,
      ),
    ).toBe(1);
    expect(
      metric('reconciliation_issues_open', { kind: 'MISSING_IN_LEDGER' }),
    ).toBe(2); // pi_b and pi_old
  });

  it('S14 AS-50: a completed run is never rewritten by a second pass', async () => {
    await salePayment('pi_1');
    fake.lines = [
      statementLine({ reference: 'pi_1', amount: 100 }),
      statementLine({ reference: 'pi_x', amount: 50 }),
    ];
    completed(await run());
    const snapshot = JSON.stringify([await runRow(), await issues()]);
    fake.lines = []; // the provider now says something else: it does not matter
    expect((await run()).outcome).toBe('already_completed');
    expect(JSON.stringify([await runRow(), await issues()])).toBe(snapshot);
  });
});
