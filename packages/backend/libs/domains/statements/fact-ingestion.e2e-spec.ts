import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  DS1,
  ledgerJournal,
  orderPaid,
  payoutPaid,
} from '@app/test/fixtures/statements';
import { WatermarkService } from './application/watermark.service';
import {
  createStatementsApp,
  type StatementsTestApp,
} from './testing/statements-app';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Statements: fact ingestion (R3 consumers)', () => {
  let t: StatementsTestApp;
  let shopA: string;
  let shopB: string;

  beforeAll(async () => {
    t = await createStatementsApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(new Date('2026-04-03T10:00:00Z'));
    shopA = (await t.shopWithOwner()).shopId;
    shopB = (await t.shopWithOwner()).shopId;
  });

  const saleFacts = (where = 'true') =>
    t.sql<Record<string, unknown>>(
      `SELECT *, "paidAt"::text AS "paidAtText", "recordedAt"::text AS "recordedAtText" FROM "StatementSaleFact" WHERE ${where} ORDER BY "orderId", "lineId", "orderVersion"`,
    );
  const count = async (table: string) =>
    Number(
      (
        await t.sql<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`)
      )[0].n,
    );
  const ts = (iso: string) => Date.parse(iso);

  it('S16 AS-51: an order.paid becomes one fact per line, normalised, with the event time as recorded time and no buyer', async () => {
    const orderId = uuidv4();
    const message = orderPaid({
      orderId,
      orderVersion: 2,
      paidAt: '2026-03-15T12:00:00+02:00',
      occurredAt: '2026-03-15T10:00:01Z',
      lines: [
        {
          lineId: 'line-a',
          shopId: shopA,
          category: '  Electronics ',
          quantity: 2,
          unitPriceMinor: 1500,
          discountMinor: 500,
        },
        {
          lineId: 'line-b',
          shopId: shopA,
          category: 'books',
          unitPriceMinor: 700,
        },
      ],
    });
    const result = await t.sales.deliver(message);
    expect(result.counts).toEqual({ applied: 1, duplicate: 0, stale: 0 });
    expect(result.deadLetters).toEqual([]);

    const facts = await saleFacts();
    expect(facts).toHaveLength(2);
    const a = facts.find((f) => f.lineId === 'line-a')!;
    expect(a).toMatchObject({
      orderId,
      shopId: shopA,
      category: 'electronics',
      quantity: 2,
      orderVersion: 2,
      eventId: message.eventId,
    });
    expect(Number(a.unitPriceMinor)).toBe(1500);
    expect(Number(a.discountMinor)).toBe(500);
    expect(Number(a.lineTotalMinor)).toBe(2500);
    expect(ts(String(a.paidAt))).toBe(ts('2026-03-15T10:00:00Z'));
    expect(ts(String(a.recordedAt))).toBe(ts('2026-03-15T10:00:01Z'));
    expect(ts(String(a.appliedAt))).toBe(t.clock.now().getTime());

    // no buyer identifier is stored: no column could hold one, and no value contains it
    const columns = await t.sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('StatementSaleFact','StatementPayoutFact','StatementLedgerFact','StatementLedgerCredit')`,
    );
    expect(
      columns
        .map((c) => c.column_name)
        .filter((c) => /user|buyer|email|customer/i.test(c)),
    ).toEqual([]);
    const [leak] = await t.sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "StatementSaleFact" f WHERE row_to_json(f)::text LIKE '%buyer-%'`,
    );
    expect(leak.n).toBe('0');
    expect(
      metric('statements_events_applied_total', {
        stream: 'orders',
        outcome: 'applied',
      }),
    ).toBeGreaterThan(0);
  });

  it('S16 AS-52: the same event delivered twice, and at the same moment, has one effect', async () => {
    const message = orderPaid({
      paidAt: '2026-03-15T12:00:00Z',
      lines: [{ shopId: shopA, unitPriceMinor: 1000 }],
    });
    const first = await t.sales.deliver(message);
    const again = await t.sales.deliver(message);
    expect(first.counts.applied).toBe(1);
    expect(again.counts.duplicate).toBe(1);
    expect(again.counts.applied).toBe(0);
    expect(await count('StatementSaleFact')).toBe(1);

    const concurrent = orderPaid({
      paidAt: '2026-03-16T12:00:00Z',
      lines: [{ shopId: shopA, unitPriceMinor: 2000 }],
    });
    const both = await t.sales.deliverConcurrently(concurrent, concurrent);
    expect(both.counts.applied).toBe(1);
    expect(both.counts.duplicate).toBe(1);
    expect(await count('StatementSaleFact')).toBe(2);
    expect(
      metric('statements_events_applied_total', {
        stream: 'orders',
        outcome: 'duplicate',
      }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('S16 AS-53: a lower order version is discarded, a higher one replaces, a replay with a new event id changes nothing', async () => {
    const orderId = uuidv4();
    const line = (price: number) => ({
      lineId: 'l',
      shopId: shopA,
      unitPriceMinor: price,
    });
    await t.sales.deliver(
      orderPaid({
        orderId,
        orderVersion: 2,
        paidAt: '2026-03-15T12:00:00Z',
        lines: [line(2000)],
      }),
    );

    const lower = await t.sales.deliver(
      orderPaid({
        orderId,
        orderVersion: 1,
        paidAt: '2026-03-15T12:00:00Z',
        lines: [line(999)],
      }),
    );
    expect(lower.counts.stale).toBe(1);
    expect((await saleFacts()).map((f) => Number(f.lineTotalMinor))).toEqual([
      2000,
    ]);

    const replay = await t.sales.deliver(
      orderPaid({
        orderId,
        orderVersion: 2,
        paidAt: '2026-03-15T12:00:00Z',
        lines: [line(2000)],
      }),
    );
    expect(replay.counts.applied).toBe(0);
    expect(replay.counts.duplicate + replay.counts.stale).toBe(1);
    expect(await count('StatementSaleFact')).toBe(1);

    const higher = await t.sales.deliver(
      orderPaid({
        orderId,
        orderVersion: 3,
        paidAt: '2026-03-15T12:00:00Z',
        lines: [line(3000)],
      }),
    );
    expect(higher.counts.applied).toBe(1);
    const facts = await saleFacts();
    expect(
      facts.map((f) => [Number(f.orderVersion), Number(f.lineTotalMinor)]),
    ).toEqual([
      [2, 2000],
      [3, 3000],
    ]);
  });

  describe('S16 AS-54 invalid payloads', () => {
    const base = () =>
      orderPaid({
        paidAt: '2026-03-15T12:00:00Z',
        lines: [{ lineId: 'l1', shopId: shopA, unitPriceMinor: 1000 }],
      });
    const withLine = (
      patch: Record<string, unknown>,
      top: Record<string, unknown> = {},
    ) => {
      const message = base();
      const payload = message.payload as { lines: Record<string, unknown>[] };
      return {
        ...message,
        payload: {
          ...payload,
          ...top,
          lines: [{ ...payload.lines[0], ...patch }],
        },
      };
    };

    it.each([
      [
        'a line without lineId',
        () => withLine({ lineId: undefined }),
        'missing_line_id',
      ],
      [
        'a line with an empty lineId',
        () => withLine({ lineId: '' }),
        'missing_line_id',
      ],
      ['a null shopId', () => withLine({ shopId: null }), 'missing_shop'],
      [
        'a shopId that is not a UUID',
        () => withLine({ shopId: 'not-a-uuid' }),
        'missing_shop',
      ],
      [
        'a negative price',
        () => withLine({ unitPriceMinor: -1, lineTotalMinor: -1 }),
        'invalid_payload',
      ],
      [
        'a fractional price',
        () => withLine({ unitPriceMinor: 10.5 }),
        'invalid_payload',
      ],
      [
        'an empty category',
        () => withLine({ category: '   ' }),
        'invalid_payload',
      ],
      [
        'a missing category',
        () => withLine({ category: undefined }),
        'invalid_payload',
      ],
      [
        'a 65-character category',
        () => withLine({ category: 'c'.repeat(65) }),
        'invalid_payload',
      ],
      [
        'a paidAt that is not ISO-8601',
        () => withLine({}, { paidAt: 'yesterday' }),
        'invalid_payload',
      ],
      [
        'a paidAt without an offset',
        () => withLine({}, { paidAt: '2026-03-15T12:00:00' }),
        'invalid_payload',
      ],
      [
        'missing lines',
        () => ({
          ...base(),
          payload: {
            orderId: uuidv4(),
            orderVersion: 1,
            currency: 'EUR',
            paidAt: '2026-03-15T12:00:00Z',
          },
        }),
        'invalid_payload',
      ],
      [
        'a currency other than EUR',
        () => withLine({}, { currency: 'USD' }),
        'currency_not_eur',
      ],
      [
        'a line total that is not quantity x price - discount',
        () => withLine({ lineTotalMinor: 999 }),
        'line_total_mismatch',
      ],
      [
        'a line total above 1e12',
        () =>
          withLine({
            unitPriceMinor: 1_000_000_000_001,
            lineTotalMinor: 1_000_000_000_001,
          }),
        'amount_too_large',
      ],
    ])(
      'S16 AS-54: %s is dead-lettered as %s, writes nothing and the next valid event is applied',
      async (_name, build, reason) => {
        const before = metric('statements_events_rejected_total', {
          stream: 'orders',
          reason,
        });
        const valid = orderPaid({
          paidAt: '2026-03-16T12:00:00Z',
          lines: [{ lineId: 'ok', shopId: shopA, unitPriceMinor: 700 }],
        });
        const result = await t.sales.deliver(build() as never, valid);
        expect(result.deadLetters).toEqual([
          { code: 'HANDLER_FAILED', reason },
        ]);
        expect(result.counts.applied).toBe(1);
        expect((await saleFacts()).map((f) => f.lineId)).toEqual(['ok']);
        expect(
          metric('statements_events_rejected_total', {
            stream: 'orders',
            reason,
          }),
        ).toBe(before + 1);
      },
    );

    it('S16 AS-54: an unknown contract version is dead-lettered by the framework before any handler runs', async () => {
      const result = await t.sales.deliver({ ...base(), version: 7 });
      expect(result.deadLetters.map((d) => d.code)).toEqual([
        'UNSUPPORTED_VERSION',
      ]);
      expect(await count('StatementSaleFact')).toBe(0);
    });

    it('S16 AS-54: a ledger v1 payload is skipped and counted, not stored', async () => {
      const before = metric('statements_events_applied_total', {
        stream: 'ledger',
        outcome: 'legacy',
      });
      const result = await t.ledger.deliver(
        ledgerJournal({
          version: 1,
          postedAt: '2026-03-15T12:00:00Z',
          lines: [],
        }),
      );
      expect(result.deadLetters).toEqual([]);
      expect(await count('StatementLedgerFact')).toBe(0);
      expect(
        metric('statements_events_applied_total', {
          stream: 'ledger',
          outcome: 'legacy',
        }),
      ).toBe(before + 1);
    });

    it('S16 AS-54: an invalid ledger or payout payload is dead-lettered with its reason', async () => {
      const bad = ledgerJournal({
        postedAt: '2026-03-15T12:00:00Z',
        lines: [],
      });
      (bad.payload as { lines: unknown }).lines = 'nope';
      const ledger = await t.ledger.deliver(bad);
      expect(ledger.deadLetters).toEqual([
        { code: 'HANDLER_FAILED', reason: 'invalid_payload' },
      ]);

      const usd = await t.payouts.deliver(
        payoutPaid({
          shopId: shopA,
          amountMinor: 100,
          paidAt: '2026-03-30T10:00:00Z',
          currency: 'USD',
        }),
      );
      expect(usd.deadLetters).toEqual([
        { code: 'HANDLER_FAILED', reason: 'currency_not_eur' },
      ]);
      const broken = payoutPaid({
        shopId: shopA,
        amountMinor: 100,
        paidAt: '2026-03-30T10:00:00Z',
      });
      (broken.payload as { amountMinor: unknown }).amountMinor = -5;
      expect((await t.payouts.deliver(broken)).deadLetters).toEqual([
        { code: 'HANDLER_FAILED', reason: 'invalid_payload' },
      ]);
      expect(await count('StatementPayoutFact')).toBe(0);
    });
  });

  it('S16 AS-56: payout.paid is one fact with amount and paid day; other payout events do nothing; a lower version is discarded', async () => {
    const payoutId = uuidv4();
    const paid = payoutPaid({
      payoutId,
      shopId: shopA,
      amountMinor: 25000,
      paidAt: '2026-03-30T10:00:00Z',
      payoutVersion: 3,
    });
    const first = await t.payouts.deliver(paid);
    const again = await t.payouts.deliver(paid);
    expect(first.counts.applied).toBe(1);
    expect(again.counts.duplicate).toBe(1);
    const [fact] = await t.sql<Record<string, unknown>>(
      `SELECT * FROM "StatementPayoutFact"`,
    );
    expect(fact).toMatchObject({ payoutId, shopId: shopA, payoutVersion: 3 });
    expect(Number(fact.amountMinor)).toBe(25000);
    expect(ts(String(fact.paidAt))).toBe(ts('2026-03-30T10:00:00Z'));

    for (const type of [
      'payout.failed',
      'payout.cancelled',
      'payout.created',
      'payout.in_doubt',
    ]) {
      const ignored = await t.payouts.deliver(
        payoutPaid({
          payoutId: uuidv4(),
          type,
          shopId: shopA,
          amountMinor: 999,
          paidAt: '2026-03-30T10:00:00Z',
        }),
      );
      expect(ignored.ignored).toBe(1);
    }
    const lower = await t.payouts.deliver(
      payoutPaid({
        payoutId,
        shopId: shopA,
        amountMinor: 1,
        paidAt: '2026-03-30T10:00:00Z',
        payoutVersion: 2,
      }),
    );
    expect(lower.counts.stale).toBe(1);
    expect(await count('StatementPayoutFact')).toBe(1);
    const [after] = await t.sql<{ amountMinor: string }>(
      `SELECT "amountMinor"::text FROM "StatementPayoutFact"`,
    );
    expect(after.amountMinor).toBe('25000');
  });

  it('S16 AS-57: a SALE journal is one fact with its credit lines and no shard; other kinds are ignored', async () => {
    const orderId = uuidv4();
    const journalId = uuidv4();
    const journal = ledgerJournal({
      journalId,
      orderId,
      postedAt: '2026-03-15T12:00:30Z',
      lines: [
        ['PAYMENTS_CLEARING', -3050],
        [`SHOP_${shopA}`, 2745],
        ['PLATFORM_FEES', 305],
      ],
    });
    const first = await t.ledger.deliver(journal);
    const again = await t.ledger.deliver(journal);
    expect(first.counts.applied).toBe(1);
    expect(again.counts.duplicate).toBe(1);

    const [fact] = await t.sql<Record<string, unknown>>(
      `SELECT * FROM "StatementLedgerFact"`,
    );
    expect(fact).toMatchObject({ journalId, orderId });
    const credits = await t.sql<{ accountId: string; amountMinor: string }>(
      `SELECT "accountId", "amountMinor"::text FROM "StatementLedgerCredit" ORDER BY "accountId"`,
    );
    expect(credits).toEqual([
      { accountId: 'PLATFORM_FEES', amountMinor: '305' },
      { accountId: `SHOP_${shopA}`, amountMinor: '2745' },
    ]);
    const columns = await t.sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name IN ('StatementLedgerFact','StatementLedgerCredit')`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('shard');

    const refund = await t.ledger.deliver(
      ledgerJournal({
        kind: 'REFUND',
        postedAt: '2026-03-16T12:00:00Z',
        lines: [[`SHOP_${shopA}`, 100]],
      }),
    );
    expect(refund.counts.applied).toBe(0);
    expect(await count('StatementLedgerFact')).toBe(1);
  });

  it('S16 AS-57: a SETTLEMENT journal is one fact with the shop credits and the commission (J01 G-10)', async () => {
    const orderId = uuidv4();
    const journalId = uuidv4();
    const settlement = ledgerJournal({
      kind: 'SETTLEMENT',
      journalId,
      orderId,
      postedAt: '2026-03-15T12:00:31Z',
      lines: [
        ['MARKETPLACE_CLEARING', -2500],
        [`SHOP_${shopA}`, 2250],
        ['PLATFORM_FEES', 250],
      ],
    });
    expect((await t.ledger.deliver(settlement)).counts.applied).toBe(1);
    expect((await t.ledger.deliver(settlement)).counts.duplicate).toBe(1);
    const credits = await t.sql<{ accountId: string; amountMinor: string }>(
      `SELECT "accountId", "amountMinor"::text FROM "StatementLedgerCredit" WHERE "journalId" = :journalId ORDER BY "accountId"`,
      { journalId },
    );
    expect(credits).toEqual([
      { accountId: 'PLATFORM_FEES', amountMinor: '250' },
      { accountId: `SHOP_${shopA}`, amountMinor: '2250' },
    ]);
  });

  it('S16 AS-58: each stream has a watermark, a stream more than 60 s behind raises the lag metric and nothing fails', async () => {
    const marks = t.app.get(WatermarkService);
    await t.sales.deliver(
      orderPaid({
        paidAt: '2026-03-31T23:40:00Z',
        lines: [{ shopId: shopA, unitPriceMinor: 100 }],
      }),
    );
    t.lag.set('orders', false);
    t.lag.set('payouts', false);
    t.lag.set('ledger', true);
    const behind = await marks.read();
    expect(behind.orders?.toISOString()).toBe('2026-03-31T23:40:00.000Z');
    expect(behind.payouts).toBeNull();
    expect(behind.ledger?.getTime()).toBe(t.clock.now().getTime() - 5000);
    expect(
      metric('statements_ingestion_lag_seconds', { stream: 'orders' }),
    ).toBeGreaterThan(60);
    expect(await marks.dataAsOf()).toBeNull();

    t.lag.set('orders', true);
    t.lag.set('payouts', true);
    const caught = await marks.read();
    expect(caught.orders?.getTime()).toBe(t.clock.now().getTime() - 5000);
    expect((await marks.dataAsOf())?.getTime()).toBe(
      t.clock.now().getTime() - 5000,
    );
    expect(
      metric('statements_ingestion_lag_seconds', { stream: 'orders' }),
    ).toBe(5);
  });

  it('S16 AS-60: a payout consumed before the order events of its month is applied on its own', async () => {
    await t.payouts.deliver(
      payoutPaid({
        shopId: shopA,
        amountMinor: 25000,
        paidAt: '2026-03-30T10:00:00Z',
      }),
    );
    expect(await count('StatementPayoutFact')).toBe(1);
    expect(await count('StatementSaleFact')).toBe(0);
    await t.sales.deliver(
      orderPaid({
        orderId: DS1.o1,
        paidAt: DS1.paidA,
        lines: [{ lineId: DS1.l1, shopId: shopA, unitPriceMinor: 10000 }],
      }),
    );
    expect(await count('StatementSaleFact')).toBe(1);
    expect(await count('StatementPayoutFact')).toBe(1);
    void shopB;
    void uuidv7;
  });
});
