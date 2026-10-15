import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { InvalidJobPayloadError } from '@app/infrastructure/jobs/job-errors';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { PayoutDestinationService } from './application/payout-destination.service';
import { RunRefused } from './domain/payout-errors';
import {
  PAYOUT_EVENTS,
  PAYOUT_JOBS,
  PAYOUT_LEDGER,
  PAYOUT_REPOSITORY,
  PayoutLedgerRefusal,
  PayoutLedgerUnavailable,
  type PayoutEventsPort,
  type PayoutJobsPort,
  type PayoutLedgerPort,
  type PayoutRepository,
} from './domain/payout-ports';
import {
  assertPayoutBooks,
  createPayoutApp,
  fund,
  payoutOf,
  payoutRows,
  PERIOD,
  RUN_AT,
  seller,
  shopBalance,
  tally,
  type PayoutTestApp,
} from './testing';
import { sql } from './testing/ledger-fixtures';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;
const DAY = 86_400_000;

describe('Payouts: weekly run, reserves and eligibility', () => {
  let t: PayoutTestApp;
  let ledgerPort: PayoutLedgerPort;
  let repository: PayoutRepository;
  let jobsPort: PayoutJobsPort;
  let eventsPort: PayoutEventsPort;

  beforeAll(async () => {
    t = await createPayoutApp();
    ledgerPort = t.app.get<PayoutLedgerPort>(PAYOUT_LEDGER, { strict: false });
    repository = t.app.get<PayoutRepository>(PAYOUT_REPOSITORY, {
      strict: false,
    });
    jobsPort = t.app.get<PayoutJobsPort>(PAYOUT_JOBS, { strict: false });
    eventsPort = t.app.get<PayoutEventsPort>(PAYOUT_EVENTS, { strict: false });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    await t.reset();
    t.clock.set(RUN_AT);
  });

  /** A debit that commits on its own, as a charge from another request would (it must not join the run's transaction). */
  const chargeElsewhere = (shopId: string, amountMinor: number) =>
    t.runner.run(
      (tx) =>
        t.ledger.postJournal(
          {
            kind: 'ADJUSTMENT',
            reference: `charge-${uuidv4()}`,
            currency: 'EUR',
            lines: [
              { accountId: `SHOP_${shopId}`, amountMinor: -amountMinor },
              { accountId: 'PAYOUTS_SENT', amountMinor },
            ],
          },
          tx,
        ),
      { propagation: 'requires_new' },
    );

  it('S15 AS-01: a run pays every eligible seller once, with reserve, snapshot, journal, job, event and history', async () => {
    const a = await seller(t, { balance: 50_000 });
    const b = await seller(t, { balance: 20_000 });

    const summary = await t.run.run({});

    expect(summary).toMatchObject({
      periodStart: PERIOD,
      status: 'COMPLETED',
      created: 2,
      existing: 0,
      skipped: {},
    });
    const pa = await payoutOf(t, a.shopId);
    expect(pa).toMatchObject({
      status: 'PENDING',
      amountMinor: '45000',
      reserveHeldMinor: '5000',
      destinationSnapshot: a.accountId,
      payoutVersion: 1,
    });
    expect(await payoutOf(t, b.shopId)).toMatchObject({
      amountMinor: '18000',
      reserveHeldMinor: '2000',
    });
    expect(await tally(t)).toEqual({
      payouts: 2,
      journals: 2,
      sendJobs: 2,
      history: 2,
      events: { 'payout.created': 2 },
    });
    expect(await shopBalance(t, a.shopId)).toBe(5_000);
    expect(await shopBalance(t, b.shopId)).toBe(2_000);
    await assertPayoutBooks(t);
    expect(
      await sql(t.app, `SELECT * FROM "PayoutRun" WHERE "periodStart" = :p`, {
        p: PERIOD,
      }),
    ).toEqual([
      expect.objectContaining({ status: 'COMPLETED', created: 2, existing: 0 }),
    ]);
  });

  it('S15 AS-02: running the same period again adds no payout, journal, job or event', async () => {
    await seller(t, { balance: 50_000 });
    await seller(t, { balance: 20_000 });
    await t.run.run({});
    const before = await tally(t);

    const again = await t.run.run({});

    expect(again).toMatchObject({
      status: 'COMPLETED',
      created: 0,
      existing: 2,
    });
    expect(await tally(t)).toEqual(before);
    await assertPayoutBooks(t);
  });

  it('S15 AS-03: two runs at once create one payout, journal, job and event per shop, twenty times over', async () => {
    for (let repetition = 0; repetition < 20; repetition += 1) {
      await t.reset();
      t.clock.set(RUN_AT);
      for (let i = 0; i < 20; i += 1) await seller(t, { balance: 20_000 });

      const [first, second] = await Promise.all([t.run.run({}), t.run.run({})]);

      expect(first.created + second.created).toBe(20);
      expect(first.existing + second.existing).toBe(20);
      expect(await tally(t)).toEqual({
        payouts: 20,
        journals: 20,
        sendJobs: 20,
        history: 20,
        events: { 'payout.created': 20 },
      });
      await assertPayoutBooks(t);
    }
  }, 300_000);

  it('S15 AS-05: a per-shop reserve overrides the default, and 0 and 25% apply in one run', async () => {
    const none = await seller(t, { balance: 20_000, reserveBps: 0 });
    const quarter = await seller(t, { balance: 20_000, reserveBps: 2500 });
    const standard = await seller(t, { balance: 20_000 });

    await t.run.run({});

    expect(await payoutOf(t, none.shopId)).toMatchObject({
      amountMinor: '20000',
      reserveHeldMinor: '0',
    });
    expect(await payoutOf(t, quarter.shopId)).toMatchObject({
      amountMinor: '15000',
      reserveHeldMinor: '5000',
    });
    expect(await payoutOf(t, standard.shopId)).toMatchObject({
      amountMinor: '18000',
      reserveHeldMinor: '2000',
    });
    await assertPayoutBooks(t);
  });

  it('S15 AS-06: the minimum is inclusive, below it is not listed, and a payout under it after the reserve is skipped', async () => {
    const exact = await seller(t, { balance: 1000, reserveBps: 0 });
    const under = await seller(t, { balance: 999, reserveBps: 0 });
    const reserved = await seller(t, { balance: 1050 });
    const before = {
      under: await shopBalance(t, under.shopId),
      reserved: await shopBalance(t, reserved.shopId),
    };

    const summary = await t.run.run({});

    expect(summary.created).toBe(1);
    expect(summary.skipped).toEqual({ below_minimum: 1 });
    expect(await payoutOf(t, exact.shopId)).toMatchObject({
      amountMinor: '1000',
    });
    expect(await payoutRows(t, `"shopId" = :s`, { s: under.shopId })).toEqual(
      [],
    );
    expect(
      await payoutRows(t, `"shopId" = :s`, { s: reserved.shopId }),
    ).toEqual([]);
    expect(await shopBalance(t, under.shopId)).toBe(before.under);
    expect(await shopBalance(t, reserved.shopId)).toBe(before.reserved);

    // next week the balance has grown and the shop is paid
    await fund(t, reserved.shopId, 200);
    t.clock.set(new Date(RUN_AT.getTime() + 7 * DAY));
    const next = await t.run.run({});
    expect(next.created).toBe(1);
    expect(await payoutOf(t, reserved.shopId, '2026-10-12')).toMatchObject({
      amountMinor: '1125',
      reserveHeldMinor: '125',
    });
  });

  it('S15 AS-07: the cap limits one payout, holds no reserve for the rest, and the next week pays it', async () => {
    const exact = await seller(t, { balance: 5_000_000, reserveBps: 0 });
    const over = await seller(t, { balance: 6_000_000, reserveBps: 0 });

    await t.run.run({});

    expect(await payoutOf(t, exact.shopId)).toMatchObject({
      amountMinor: '5000000',
    });
    expect(await payoutOf(t, over.shopId)).toMatchObject({
      amountMinor: '5000000',
      reserveHeldMinor: '0',
    });
    expect(await shopBalance(t, over.shopId)).toBe(1_000_000);

    t.clock.set(new Date(RUN_AT.getTime() + 7 * DAY));
    const next = await t.run.run({});
    expect(next.created).toBe(1);
    expect(await payoutOf(t, over.shopId, '2026-10-12')).toMatchObject({
      amountMinor: '1000000',
    });
    await assertPayoutBooks(t);
  });

  it('S15 AS-08: a balance of zero, negative or under the minimum creates nothing and is not counted as a skip', async () => {
    await seller(t, { balance: 0 });
    const negative = await seller(t, { balance: 0 });
    await fund(t, negative.shopId, -500);
    await seller(t, { balance: 500 });

    const summary = await t.run.run({});

    expect(summary).toMatchObject({ created: 0, existing: 0, skipped: {} });
    expect((await tally(t)).payouts).toBe(0);
  });

  it('S15 AS-09: a shop that is disabled, inactive, unknown, without a destination or cooling is skipped with its reason and keeps its balance', async () => {
    const shops = {
      payouts_disabled: await seller(t, {
        balance: 20_000,
        summary: { payoutsEnabled: false },
      }),
      shop_not_active: await seller(t, {
        balance: 20_000,
        summary: { status: 'SUSPENDED' },
      }),
      shop_unknown: await seller(t, { balance: 20_000, summary: null }),
      destination_missing: await seller(t, {
        balance: 20_000,
        destination: null,
      }),
      destination_cooling: await seller(t, {
        balance: 20_000,
        effectiveFrom: new Date(RUN_AT.getTime() + 3_600_000),
      }),
    };
    const before = Object.fromEntries(
      Object.keys(shops).map((reason) => [
        reason,
        metric('payout_skipped_total', { reason }),
      ]),
    );
    const log = jest.spyOn(Logger.prototype, 'log');

    const summary = await t.run.run({});

    expect(summary.created).toBe(0);
    expect(summary.skipped).toEqual({
      payouts_disabled: 1,
      shop_not_active: 1,
      shop_unknown: 1,
      destination_missing: 1,
      destination_cooling: 1,
    });
    for (const [reason, s] of Object.entries(shops)) {
      expect(await shopBalance(t, s.shopId)).toBe(20_000);
      expect(metric('payout_skipped_total', { reason })).toBe(
        before[reason] + 1,
      );
    }
    expect(await tally(t)).toMatchObject({ payouts: 0, journals: 0 });
    const line = log.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('payout.run.finished'));
    expect(JSON.parse(line!)).toMatchObject({
      event: 'payout.run.finished',
      skipped: summary.skipped,
    });
    await assertPayoutBooks(t);
  });

  it('S15 AS-10: the payout is decided on the authoritative balance, and a charge that lands after the read skips only that shop', async () => {
    const early = await seller(t, { balance: 50_000 });
    const other = await seller(t, { balance: 20_000 });
    // a charge of 10 000 lands after the listing and before the creation step
    const original = t.creation.createFor.bind(t.creation);
    jest
      .spyOn(t.creation, 'createFor')
      .mockImplementation(async (shopId, period, input) => {
        if (shopId === early.shopId) await chargeElsewhere(shopId, 10_000);
        return original(shopId, period, input);
      });

    await t.run.run({});

    expect(await payoutOf(t, early.shopId)).toMatchObject({
      amountMinor: '36000',
      reserveHeldMinor: '4000',
    });
    expect(await payoutOf(t, other.shopId)).toMatchObject({
      amountMinor: '18000',
    });
    await assertPayoutBooks(t);
  });

  it('S15 AS-10: a charge between the balance read and the posting is refused by the ledger, rolled back, and the others proceed', async () => {
    const racing = await seller(t, { balance: 50_000 });
    const other = await seller(t, { balance: 20_000 });
    const read = ledgerPort.balances.bind(ledgerPort);
    jest
      .spyOn(ledgerPort, 'balances')
      .mockImplementation(async (ids, currency, tx) => {
        const result = await read(ids, currency, tx);
        if (tx && ids.includes(racing.shopId))
          await chargeElsewhere(racing.shopId, 45_000);
        return result;
      });

    const summary = await t.run.run({});

    expect(summary.skipped).toEqual({ insufficient_balance: 1 });
    expect(summary.created).toBe(1);
    expect(await payoutRows(t, `"shopId" = :s`, { s: racing.shopId })).toEqual(
      [],
    );
    expect(await shopBalance(t, racing.shopId)).toBe(5_000);
    expect(await payoutOf(t, other.shopId)).toMatchObject({
      amountMinor: '18000',
    });
    await assertPayoutBooks(t);
  });

  it('S15 AS-11: a failing balance listing fails the run as ledger_unavailable with nothing created, and the retry pays', async () => {
    await seller(t, { balance: 20_000 });
    jest
      .spyOn(ledgerPort, 'listSellerBalances')
      .mockRejectedValueOnce(new PayoutLedgerUnavailable());

    await expect(t.run.run({})).rejects.toBeInstanceOf(PayoutLedgerUnavailable);

    expect(
      await sql(t.app, `SELECT "status", "failureCode" FROM "PayoutRun"`),
    ).toEqual([{ status: 'FAILED', failureCode: 'ledger_unavailable' }]);
    expect((await tally(t)).payouts).toBe(0);

    const retry = await t.run.run({});
    expect(retry).toMatchObject({ status: 'COMPLETED', created: 1 });
    expect(
      await sql(t.app, `SELECT "status", "failureCode" FROM "PayoutRun"`),
    ).toEqual([{ status: 'COMPLETED', failureCode: null }]);
  });

  it('S15 AS-11: a busy ledger skips that shop as ledger_busy and the next run pays it', async () => {
    const busy = await seller(t, { balance: 20_000 });
    const fine = await seller(t, { balance: 20_000 });
    const post = ledgerPort.postCreated.bind(ledgerPort);
    jest.spyOn(ledgerPort, 'postCreated').mockImplementation(async (p, tx) => {
      if (p.shopId === busy.shopId)
        throw new PayoutLedgerRefusal('ledger_busy');
      return post(p, tx);
    });

    const first = await t.run.run({});
    expect(first.skipped).toEqual({ ledger_busy: 1 });
    expect(first.created).toBe(1);
    expect(await payoutRows(t, `"shopId" = :s`, { s: busy.shopId })).toEqual(
      [],
    );

    jest.restoreAllMocks();
    const second = await t.run.run({});
    expect(second).toMatchObject({ created: 1, existing: 1 });
    expect(await payoutOf(t, busy.shopId)).toMatchObject({
      amountMinor: '18000',
    });
    expect(await payoutOf(t, fine.shopId)).toBeDefined();
    await assertPayoutBooks(t);
  });

  it('S15 AS-12: 450 shops are read in pages of 200 with three tenancy calls and no per-shop lookup', async () => {
    const ids: string[] = [];
    for (let batch = 0; batch < 450; batch += 25) {
      const made = await Promise.all(
        Array.from({ length: 25 }, () => seller(t, { balance: 20_000 })),
      );
      ids.push(...made.map((m) => m.shopId));
    }
    t.shops.calls.length = 0;
    const listing = jest.spyOn(ledgerPort, 'listSellerBalances');

    const summary = await t.run.run({});

    expect(summary.created).toBe(450);
    expect(listing).toHaveBeenCalledTimes(3);
    expect(t.shops.calls.map((c) => c.length)).toEqual([200, 200, 50]);
    expect((await tally(t)).payouts).toBe(450);
    await assertPayoutBooks(t);
  }, 600_000);

  it.each([
    ['not a Monday', '2026-10-06'],
    ['in the future', '2026-10-12'],
    ['malformed', 'next-monday'],
    ['older than 52 weeks', '2025-09-29'],
  ])(
    'S15 AS-13: a period that is %s is refused and nothing is created',
    async (_label, period) => {
      await seller(t, { balance: 20_000 });

      await expect(t.run.run({ periodStart: period })).rejects.toBeInstanceOf(
        RunRefused,
      );

      expect((await tally(t)).payouts).toBe(0);
      expect(await sql(t.app, `SELECT * FROM "PayoutRun"`)).toEqual([]);
    },
  );

  it('S15 AS-13: a valid earlier Monday is paid for that period', async () => {
    const s = await seller(t, { balance: 20_000 });
    await t.run.run({ periodStart: '2026-09-28' });
    expect(await payoutOf(t, s.shopId, '2026-09-28')).toBeDefined();
  });

  it('S15 AS-14: the weekly schedule is registered once at Monday 06:00 Warsaw, re-registering changes nothing, a bad payload is refused', async () => {
    await t.reset();
    await t.jobs.onApplicationBootstrap();
    await t.jobs.onApplicationBootstrap();

    const rows = await sql<{ cron: string; timezone: string; jobType: string }>(
      t.app,
      `SELECT "cron", "timezone", "jobType" FROM "JobSchedule" WHERE "name" = 'payouts.run-weekly'`,
    );
    expect(rows).toEqual([
      {
        cron: '0 6 * * 1',
        timezone: 'Europe/Warsaw',
        jobType: 'payouts.run-weekly',
      },
    ]);
    await expect(
      t.app
        .get(JobsService)
        .enqueue('payouts.run-weekly', { periodStart: 'not-a-date' }),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
  });

  it('S15 AS-14: in the week the clocks change the run is due at 05:00Z, one hour later than the week before', async () => {
    await t.reset();
    t.clock.set(new Date('2026-10-20T00:00:00.000Z'));
    await t.jobs.onApplicationBootstrap();
    const [row] = await sql<{ nextFireAt: Date }>(
      t.app,
      `SELECT "nextFireAt" FROM "JobSchedule" WHERE "name" = 'payouts.run-weekly'`,
    );
    expect(new Date(row.nextFireAt).toISOString()).toBe(
      '2026-10-26T05:00:00.000Z',
    );
  });

  it('S15 AS-15: a run stopped after two payouts resumes: the retry finds two and creates the rest, with totals of an uninterrupted run', async () => {
    for (let i = 0; i < 5; i += 1) await seller(t, { balance: 20_000 });
    const stop = new AbortController();
    const original = t.creation.createFor.bind(t.creation);
    let done = 0;
    jest.spyOn(t.creation, 'createFor').mockImplementation(async (...args) => {
      const result = await original(...args);
      done += 1;
      if (done === 2) stop.abort();
      return result;
    });

    const first = await t.run.run({ signal: stop.signal });
    expect(first).toMatchObject({
      status: 'FAILED',
      failureCode: 'interrupted',
      created: 2,
    });

    jest.restoreAllMocks();
    const retry = await t.run.run({});
    expect(retry).toMatchObject({
      status: 'COMPLETED',
      existing: 2,
      created: 3,
    });
    expect(await tally(t)).toEqual({
      payouts: 5,
      journals: 5,
      sendJobs: 5,
      history: 5,
      events: { 'payout.created': 5 },
    });
    await assertPayoutBooks(t);
  });

  it.each([
    ['the payout insert', () => jest.spyOn(repository, 'insertIfAbsent')],
    ['the journal posting', () => jest.spyOn(ledgerPort, 'postCreated')],
    ['the history row', () => jest.spyOn(repository, 'appendHistory')],
    ['the event append', () => jest.spyOn(eventsPort, 'append')],
    ['the job enqueue', () => jest.spyOn(jobsPort, 'enqueueSend')],
  ])(
    'S15 AS-16: a failure at %s leaves no payout, journal, history, event or job, and no provider call',
    async (_label, spy) => {
      const s = await seller(t, { balance: 20_000 });
      spy().mockRejectedValue(new Error('forced failure'));

      const summary = await t.run.run({});

      expect(summary.created).toBe(0);
      expect(summary.skipped).toEqual({ internal_error: 1 });
      expect(await tally(t)).toEqual({
        payouts: 0,
        journals: 0,
        sendJobs: 0,
        history: 0,
        events: {},
      });
      expect(await shopBalance(t, s.shopId)).toBe(20_000);
      expect(t.provider.calls).toEqual([]);
      await assertPayoutBooks(t);
    },
  );

  it('S15 AS-39: a destination changed at T is skipped as cooling until T+48h and then paid to the new account', async () => {
    const s = await seller(t, { balance: 20_000 });
    const changedAt = new Date('2026-10-03T10:00:00.000Z');
    t.clock.set(changedAt);
    const newAccount = 'acct_NEWACCOUNT12345';
    await t.app
      .get(PayoutDestinationService, { strict: false })
      .set(s.shopId, newAccount, 'admin-1');

    t.clock.set(new Date(changedAt.getTime() + 48 * 3_600_000 - 60_000));
    const early = await t.run.run({ periodStart: PERIOD });
    expect(early.skipped).toEqual({ destination_cooling: 1 });
    expect((await tally(t)).payouts).toBe(0);

    t.clock.set(new Date(changedAt.getTime() + 48 * 3_600_000));
    const later = await t.run.run({ periodStart: PERIOD });
    expect(later.created).toBe(1);
    expect(await payoutOf(t, s.shopId)).toMatchObject({
      destinationSnapshot: newAccount,
    });
  });
});
