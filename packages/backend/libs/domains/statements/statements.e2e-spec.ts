import { orderPaid } from '@app/test/fixtures/statements';
import {
  createStatementsApp,
  type StatementsTestApp,
} from './testing/statements-app';
import {
  adjustmentsOf,
  closeMonth,
  createShops,
  rc1,
  readStatement,
  seedDs1,
  setClock,
  setRate,
  type Shops,
} from './testing/statements-flows';

/**
 * One journey across the whole capability (replaces the retired SD-41 spec, L-017): sale facts, the close, a retroactive
 * rate change, the correction and the seller's views. The detailed rules live in the eight focused specs next to it.
 */
describe('Statements: closed-month journey', () => {
  let t: StatementsTestApp;
  let shops: Shops;

  beforeAll(async () => {
    t = await createStatementsApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    setClock(t, '2026-04-01T00:30:00Z');
    shops = await createShops(t);
  });

  const csv = async (shopId: string, month: string) => {
    const owner = await t.member(shopId, 'OWNER');
    const res = await t
      .as(owner)
      .get(`/api/shops/${shopId}/statements/${month}/lines.csv`)
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => (data += chunk));
        r.on('end', () => cb(null, data));
      });
    return { status: res.status, body: String(res.body) };
  };

  it('S16 AS-16 AS-17 AS-18 AS-40: a retroactive rate cut leaves the closed month alone, books an adjustment, and "as known at" still answers the old truth', async () => {
    await seedDs1(t, shops);
    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    setClock(t, '2026-04-03T10:00:00Z');
    const closed = await readStatement(t, shops.a, '2026-03');
    const closedCsv = await csv(shops.a, '2026-03');
    expect(closed.status).toBe('CLOSED');
    expect(closed.own.commissionMinor).toBe(3050);
    expect(closedCsv.status).toBe(200);

    const change = await setRate(t, rc1(shops.a), '2026-04-05T09:00:00Z');
    expect(change.affectedClosedMonths).toEqual(['2026-03']);
    await t.drainJobs();
    setClock(t, '2026-04-20T10:00:00Z');

    // the closed month never changes, in the statement or in the file
    const after = await readStatement(t, shops.a, '2026-03');
    expect(after.own).toEqual(closed.own);
    expect((await csv(shops.a, '2026-03')).body).toBe(closedCsv.body);

    // the correction is one adjustment booked in the next month
    const booked = await adjustmentsOf(t, shops.a);
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({
      refersToMonth: '2026-03',
      bookedMonth: '2026-04',
      causeKind: 'rate_change',
      causeRef: change.changeId,
    });
    expect(Number(booked[0].commission)).toBe(-900);
    const april = await readStatement(t, shops.a, '2026-04');
    expect(april.total.commissionMinor).toBe(-900);

    // what was believed before the change is still answerable
    const before = await readStatement(
      t,
      shops.a,
      '2026-03',
      '?knownAt=2026-04-01T00:00:00Z',
    );
    expect(before.source).toBe('as_known_at');
    expect(before.own.commissionMinor).toBe(3050);
    const later = await readStatement(
      t,
      shops.a,
      '2026-03',
      '?knownAt=2026-04-06T00:00:00Z',
    );
    expect(later.own.commissionMinor).toBe(2150);
  });

  it('S16 AS-61 AS-64: the CSV of the month lists the sales and neutralises spreadsheet formulas', async () => {
    await t.sales.deliver(
      orderPaid({
        paidAt: '2026-03-10T10:00:00Z',
        lines: [
          { shopId: shops.a, unitPriceMinor: 1000, category: '=cmd|calc' },
        ],
      }),
    );
    const res = await csv(shops.a, '2026-03');
    expect(res.status).toBe(200);
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(res.body).toContain("'=cmd|calc");
    expect(res.body).not.toMatch(/(^|,)"?=cmd/m);
  });
});
