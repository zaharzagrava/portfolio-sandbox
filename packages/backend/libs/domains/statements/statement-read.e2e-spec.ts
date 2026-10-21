import { v4 as uuidv4 } from 'uuid';
import { getConnectionToken } from '@nestjs/sequelize';
import type { Sequelize } from 'sequelize';
import {
  statementPageSchema,
  statementSchema,
} from '@marketplace-sandbox/contracts';
import { READ_REPLICA_CONNECTION } from '@app/infrastructure/database/read-replica.provider';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  DS1,
  lateSaleL4,
  orderPaid,
  payoutPaid,
} from '@app/test/fixtures/statements';
import { commissionOf } from './domain/commission';
import {
  createStatementsApp,
  type StatementsTestApp,
} from './testing/statements-app';
import {
  closeMonth,
  createShops,
  rc1,
  readStatement,
  seedDs1,
  setClock,
  setRate,
  type Shops,
} from './testing/statements-flows';

describe('Statements: seller statement reads and as-known-at', () => {
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
    setClock(t, '2026-03-20T10:00:00Z');
    shops = await createShops(t);
  });

  const owner = (shopId: string) => t.member(shopId, 'OWNER');
  const get = async (shopId: string, path: string, who?: TestUser | null) => {
    const user = who === undefined ? await owner(shopId) : who;
    const url = `/api/shops/${shopId}/statements${path}`;
    return user ? t.as(user).get(url) : t.http().get(url);
  };
  const tableCounts = async () =>
    (
      await t.sql<{ n: string }>(
        `SELECT ((SELECT count(*) FROM "CommissionRate") + (SELECT count(*) FROM "StatementSaleFact") + (SELECT count(*) FROM "StatementPayoutFact")
               + (SELECT count(*) FROM "StatementSnapshot") + (SELECT count(*) FROM "StatementAdjustment") + (SELECT count(*) FROM "AccountingPeriod")
               + (SELECT count(*) FROM "StatementPeriodRun") + (SELECT count(*) FROM "Job") + (SELECT count(*) FROM "Outbox")
               + (SELECT count(*) FROM "StatementStreamWatermark"))::text AS n`,
      )
    )[0].n;
  /** The SQL both database handles run while `work` runs (the primary and the reporting replica). */
  const queriesDuring = async (work: () => Promise<unknown>) => {
    type Logged = { options: { logging: unknown } };
    const dbs = [
      t.app.get<Sequelize>(getConnectionToken()),
      t.app.get<Sequelize>(READ_REPLICA_CONNECTION, { strict: false }),
    ] as unknown as Logged[];
    const log: string[] = [];
    const saved = dbs.map((db) => db.options.logging);
    for (const db of dbs)
      db.options.logging = (sql: string) => void log.push(String(sql));
    try {
      await work();
    } finally {
      dbs.forEach((db, i) => (db.options.logging = saved[i]));
    }
    return log;
  };

  it('S16 AS-14: an open month is priced live, states how fresh it is, and writes nothing', async () => {
    await seedDs1(t, shops);
    const before = await tableCounts();
    const res = await get(shops.a, '/2026-03');
    expect(res.status).toBe(200);
    const body = statementSchema.parse(res.body);
    expect(body).toMatchObject({
      shopId: shops.a,
      month: '2026-03',
      currency: 'EUR',
      status: 'OPEN',
      source: 'live',
      own: {
        grossMinor: 30500,
        commissionMinor: 3050,
        netMinor: 27450,
        lineCount: 3,
        payoutsPaidMinor: 0,
      },
      adjustmentsBooked: [],
      adjustmentsReferencing: [],
      unpricedLineCount: 0,
    });
    expect(body.total).toEqual(body.own);
    expect(body.corrected).toEqual(body.own);
    expect(body.knownAt).toBe('2026-03-20T10:00:00.000Z');
    expect(body.dataAsOf).toBe('2026-03-20T09:59:55.000Z');
    expect(await tableCounts()).toBe(before);

    const b = statementSchema.parse((await get(shops.b, '/2026-03')).body);
    expect(b.own).toMatchObject({
      grossMinor: 4005,
      commissionMinor: 401,
      netMinor: 3604,
      lineCount: 1,
    });
  });

  it('S16 AS-15: a closed month is read from its snapshot and touches neither facts nor rates', async () => {
    setClock(t, '2026-04-01T00:30:00Z');
    await seedDs1(t, shops);
    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    setClock(t, '2026-04-10T10:00:00Z');
    const reader = await owner(shops.a);
    const log = await queriesDuring(async () => {
      const res = await t
        .as(reader)
        .get(`/api/shops/${shops.a}/statements/2026-03`);
      expect(res.status).toBe(200);
      const body = statementSchema.parse(res.body);
      expect(body).toMatchObject({
        status: 'CLOSED',
        source: 'snapshot',
        dataAsOf: null,
        own: {
          grossMinor: 30500,
          commissionMinor: 3050,
          netMinor: 27450,
          lineCount: 3,
        },
      });
      expect(Date.parse(body.knownAt)).toBe(Date.parse('2026-04-02T02:00:00Z'));
    });
    const touched = log.filter((sql) =>
      /StatementSaleFact|StatementPayoutFact|"CommissionRate"/.test(sql),
    );
    expect(touched).toEqual([]);
    expect(log.some((sql) => /"StatementSnapshot"/.test(sql))).toBe(true);
  });

  it('S16 AS-16: a closed month with a correction shows it beside the frozen figures', async () => {
    setClock(t, '2026-04-01T00:30:00Z');
    await seedDs1(t, shops);
    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    await setRate(t, rc1(shops.a), '2026-04-05T09:00:00Z');
    await t.drainJobs();
    const body = await readStatement(t, shops.a, '2026-03');
    expect(body.own.commissionMinor).toBe(3050);
    expect(body.adjustmentsReferencing).toHaveLength(1);
    expect(body.adjustmentsReferencing[0]).toMatchObject({
      refersToMonth: '2026-03',
      bookedMonth: '2026-04',
      causeKind: 'rate_change',
      commissionDeltaMinor: -900,
      grossDeltaMinor: 0,
      lineCountDelta: 0,
      payoutsPaidDeltaMinor: 0,
      reason: 'promo-2026-03',
    });
    expect(body.corrected).toEqual({
      grossMinor: 30500,
      commissionMinor: 2150,
      netMinor: 28350,
      lineCount: 3,
      payoutsPaidMinor: 0,
    });
    expect(body.total).toEqual(body.own);
    expect(body.adjustmentsBooked).toEqual([]);
  });

  it('S16 AS-17: the open month carries the adjustment booked into it', async () => {
    setClock(t, '2026-04-01T00:30:00Z');
    await seedDs1(t, shops);
    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    await setRate(t, rc1(shops.a), '2026-04-05T09:00:00Z');
    await t.drainJobs();
    setClock(t, '2026-04-20T10:00:00Z');
    const body = await readStatement(t, shops.a, '2026-04');
    expect(body.status).toBe('OPEN');
    expect(body.own).toEqual({
      grossMinor: 0,
      commissionMinor: 0,
      netMinor: 0,
      lineCount: 0,
      payoutsPaidMinor: 0,
    });
    expect(body.adjustmentsBooked).toHaveLength(1);
    expect(body.adjustmentsBooked[0].commissionDeltaMinor).toBe(-900);
    expect(body.total.commissionMinor).toBe(-900);
    expect(body.total.netMinor).toBe(900);
  });

  it('S16 AS-18: a month can be read as known at an instant, on both axes', async () => {
    setClock(t, '2026-04-01T00:30:00Z');
    await seedDs1(t, shops);
    await closeMonth(t, '2026-03', '2026-04-02T02:00:00Z');
    await setRate(t, rc1(shops.a), '2026-04-05T09:00:00Z');
    await t.drainJobs();
    setClock(t, '2026-04-20T10:00:00Z');

    const early = await readStatement(
      t,
      shops.a,
      '2026-03',
      '?knownAt=2026-04-01T00:00:00Z',
    );
    expect(early).toMatchObject({
      source: 'as_known_at',
      dataAsOf: null,
      status: 'CLOSED',
    });
    expect(early.knownAt).toBe('2026-04-01T00:00:00.000Z');
    expect(early.own.commissionMinor).toBe(3050);
    expect(early.adjustmentsBooked).toEqual([]);
    expect(early.adjustmentsReferencing).toEqual([]);
    expect(early.total).toEqual(early.own);
    expect(early.corrected).toEqual(early.own);

    const later = await readStatement(
      t,
      shops.a,
      '2026-03',
      '?knownAt=2026-04-06T00:00:00Z',
    );
    expect(later.own.commissionMinor).toBe(2150);
    expect(later.corrected).toEqual(later.own);
  });

  it('S16 AS-19: a fact is known from its event time, whenever it was applied', async () => {
    setClock(t, '2026-04-01T00:30:00Z');
    await seedDs1(t, shops);
    setClock(t, '2026-04-03T10:00:00Z');
    await t.sales.deliver(lateSaleL4(shops.a)); // occurred 2026-03-31T23:58Z, applied on the 3rd
    setClock(t, '2026-04-05T10:00:00Z');
    const lines = async (knownAt: string) =>
      (await readStatement(t, shops.a, '2026-03', `?knownAt=${knownAt}`)).own
        .lineCount;
    expect(await lines('2026-03-31T23:59:00Z')).toBe(4);
    expect(await lines('2026-04-04T00:00:00Z')).toBe(4);
    expect(await lines('2026-03-31T23:00:00Z')).toBe(3);
  });

  it('S16 AS-20: knownAt must be a full ISO instant, never in the future, and an early one gives zeros', async () => {
    await seedDs1(t, shops);
    const before = await tableCounts();
    for (const bad of ['yesterday', '2026-04-01', '', 'x'.repeat(40)]) {
      const res = await get(
        shops.a,
        `/2026-03?knownAt=${encodeURIComponent(bad)}`,
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    }
    const future = await get(shops.a, '/2026-03?knownAt=2030-01-01T00:00:00Z');
    expect(future.status).toBe(422);
    expect(future.body.code).toBe('known_at_in_future');
    const early = await get(shops.a, '/2026-03?knownAt=2020-01-01T00:00:00Z');
    expect(early.status).toBe(200);
    expect(early.body.own).toEqual({
      grossMinor: 0,
      commissionMinor: 0,
      netMinor: 0,
      lineCount: 0,
      payoutsPaidMinor: 0,
    });
    expect(await tableCounts()).toBe(before);
  });

  it('S16 AS-21: a month with no sales is zeros; unavailable months are 422; malformed ones are 400 without a query', async () => {
    const empty = await get(shops.c, '/2026-03');
    expect(empty.status).toBe(200);
    expect(empty.body.own).toEqual({
      grossMinor: 0,
      commissionMinor: 0,
      netMinor: 0,
      lineCount: 0,
      payoutsPaidMinor: 0,
    });
    for (const month of ['2026-04', '2019-12', '2030-01']) {
      const res = await get(shops.a, `/${month}`);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('month_not_available');
    }
    const reader = await owner(shops.a);
    const log = await queriesDuring(async () => {
      for (const month of [
        '2026-13',
        '2026-00',
        '2026-3',
        '202603',
        '2026-03-01',
        'abc',
        'x'.repeat(30),
      ]) {
        const res = await t
          .as(reader)
          .get(`/api/shops/${shops.a}/statements/${month}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      }
      const badShop = await t
        .as(reader)
        .get('/api/shops/not-a-uuid/statements/2026-03');
      expect(badShop.status).toBe(400);
    });
    expect(
      log.filter((sql) =>
        /Statement|AccountingPeriod|CommissionRate/.test(sql),
      ),
    ).toEqual([]);
  });

  it('S16 AS-22: the months list is keyset-paged, newest first, and every item equals the single read', async () => {
    const months: string[] = [];
    for (let i = 0; i < 14; i++)
      months.push(
        `${i < 12 ? 2025 : 2026}-${String((i % 12) + 1).padStart(2, '0')}`,
      );
    setClock(t, '2026-03-01T00:00:00Z');
    await t.sales.deliver(
      ...months.map((m, i) =>
        orderPaid({
          paidAt: `${m}-10T10:00:00Z`,
          lines: [{ shopId: shops.a, unitPriceMinor: (i + 1) * 1000 }],
        }),
      ),
    );
    for (const m of months) await closeMonth(t, m, '2026-03-02T02:00:00Z');
    setClock(t, '2026-04-15T10:00:00Z');

    const first = await get(shops.a, '?limit=12');
    expect(first.status).toBe(200);
    const page1 = statementPageSchema.parse(first.body);
    expect(page1.items).toHaveLength(12);
    expect(page1.items[0]).toMatchObject({ month: '2026-04', status: 'OPEN' });
    const second = statementPageSchema.parse(
      (
        await get(
          shops.a,
          `?limit=12&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        )
      ).body,
    );
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const all = [...page1.items, ...second.items];
    expect(all.map((i) => i.month)).toEqual([
      '2026-04',
      ...[...months].reverse(),
    ]);
    for (const item of [all[0], all[1], all[14]]) {
      const single = await readStatement(t, shops.a, item.month);
      expect(item.total).toEqual(single.total);
      expect(item.status).toBe(single.status);
    }
    expect((await get(shops.a, '?limit=37')).status).toBe(400);
    const tampered = await get(shops.a, '?cursor=abc.def');
    expect(tampered.status).toBe(400);
    expect(tampered.body.code).toBe('invalid_cursor');
  });

  it("S16 AS-23: another shop's member sees a 404 identical to an unknown shop, and only owner and admin may read", async () => {
    await seedDs1(t, shops);
    const stranger = await owner(shops.b);
    const unknown = uuidv4();
    const strangerRead = await t
      .as(stranger)
      .get(`/api/shops/${shops.a}/statements/2026-03`);
    const unknownRead = await t
      .as(stranger)
      .get(`/api/shops/${unknown}/statements/2026-03`);
    expect(strangerRead.status).toBe(404);
    expect(strangerRead.body.code).toBe('shop_not_found');
    const shape = ({
      status,
      code,
      title,
      detail,
    }: Record<string, unknown>) => ({ status, code, title, detail });
    expect(shape(strangerRead.body)).toEqual(shape(unknownRead.body));
    expect(JSON.stringify(strangerRead.body)).not.toContain('30500');
    expect(
      (await t.as(stranger).get(`/api/shops/${shops.a}/statements`)).status,
    ).toBe(404);

    for (const [role, status] of [
      ['OWNER', 200],
      ['ADMIN', 200],
      ['STAFF', 403],
      ['VIEWER', 403],
    ] as const) {
      const member = await t.member(shops.a, role);
      for (const path of ['/2026-03', '']) {
        const res = await t
          .as(member)
          .get(`/api/shops/${shops.a}/statements${path}`);
        expect([role, res.status]).toEqual([role, status]);
        if (status === 403) expect(res.body.code).toBe('permission_denied');
      }
    }
  });

  it('S16 AS-24: no credentials, or an expired session, is 401 on the seller and the operator routes', async () => {
    const month = '2026-03';
    expect((await get(shops.a, `/${month}`, null)).status).toBe(401);
    expect((await get(shops.a, '', null)).status).toBe(401);
    const admin = '/api/admin';
    for (const [method, url] of [
      ['get', `${admin}/commission-rates`],
      [
        'get',
        `${admin}/commission-rates/as-of?category=x&validAt=2026-01-01T00:00:00Z`,
      ],
      ['post', `${admin}/commission-rates`],
      ['get', `${admin}/accounting-periods`],
      ['get', `${admin}/accounting-periods/${month}`],
      ['post', `${admin}/accounting-periods/${month}/close`],
    ] as const) {
      expect([method, url, (await t.http()[method](url)).status]).toEqual([
        method,
        url,
        401,
      ]);
    }
    const reader = await owner(shops.a);
    t.clock.advance(20 * 60_000); // past the five minutes an access token lives
    expect(
      (await t.as(reader).get(`/api/shops/${shops.a}/statements/${month}`))
        .status,
    ).toBe(401);
  });

  it('S16 AS-26: no seller or operator GET changes any row', async () => {
    await seedDs1(t, shops);
    const admin = await t.admin();
    const reader = await owner(shops.a);
    const before = await tableCounts();
    for (const url of [
      `/api/shops/${shops.a}/statements`,
      `/api/shops/${shops.a}/statements/2026-03`,
      `/api/shops/${shops.a}/statements/2026-03?knownAt=2026-03-18T00:00:00Z`,
    ])
      expect((await t.as(reader).get(url)).status).toBe(200);
    for (const url of [
      '/api/admin/accounting-periods',
      '/api/admin/accounting-periods/2026-03',
      '/api/admin/commission-rates',
    ])
      expect((await t.as(admin).get(url)).status).toBe(200);
    expect(await tableCounts()).toBe(before);
  });

  it('S16 AS-27: a line no rate resolves is counted and shown, never dropped', async () => {
    await seedDs1(t, shops);
    await t.sequelize.query(`DELETE FROM "CommissionRate"`); // privileged: the default rate disappears
    const body = await readStatement(t, shops.a, '2026-03');
    expect(body.unpricedLineCount).toBe(3);
    expect(body.own).toMatchObject({
      grossMinor: 30500,
      commissionMinor: 0,
      lineCount: 3,
    });
  });

  it('S16 AS-56: a paid payout shows in the month of its paid day', async () => {
    await seedDs1(t, shops);
    await t.payouts.deliver(
      payoutPaid({
        shopId: shops.a,
        amountMinor: 25000,
        paidAt: '2026-03-19T10:00:00Z',
      }),
    );
    const body = await readStatement(t, shops.a, '2026-03');
    expect(body.own.payoutsPaidMinor).toBe(25000);
    expect(
      (await readStatement(t, shops.b, '2026-03')).own.payoutsPaidMinor,
    ).toBe(0);
  });

  it('S16 AS-14: the SQL pricing and domain/commission.ts agree to the minor unit', async () => {
    const prices = [
      1, 5, 9, 15, 99, 105, 333, 4005, 12345, 999_999, 1_000_000_000_000,
    ];
    const rates = [0, 1, 49, 50, 333, 1000, 4999, 5000, 9999, 10_000];
    await t.sales.deliver(
      ...prices.map((p) =>
        orderPaid({
          paidAt: '2026-03-10T10:00:00Z',
          lines: [{ shopId: shops.a, unitPriceMinor: p, category: 'parity' }],
        }),
      ),
    );
    for (const bps of rates) {
      await setRate(t, {
        shopId: shops.a,
        category: 'parity',
        rateBps: bps,
        validFrom: '2026-03-01T00:00:00Z',
        reason: `parity ${bps}`,
      });
      const body = await readStatement(t, shops.a, '2026-03');
      expect(body.own.commissionMinor).toBe(
        prices.reduce((sum, p) => sum + commissionOf(p, bps), 0),
      );
      t.clock.advance(60_000);
    }
    void DS1;
  }, 120_000);

  // Last in the file: it boots a second app, with the limiter store behind a proxy.
  it('S16 AS-25: the 121st read in a minute is 429, and with the limiter store down reads still answer (fail open) while operator writes are 503', async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    const proxy = await TcpFaultProxy.start({
      host: redis.hostname,
      port: Number(redis.port || 6379),
    });
    const own = await createStatementsApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/${new URL(process.env.REDIS_URL ?? "redis://localhost:6400/0").pathname.slice(1) || "0"}`,
    });
    try {
      await own.reset();
      const { shopId, owner: me } = await own.shopWithOwner();
      const admin = await own.admin();
      // 120 reads in waves of 30 at once (was one by one)
      for (let wave = 0; wave < 4; wave++) {
        const statuses = (
          await Promise.all(
            Array.from({ length: 30 }, () =>
              own.as(me).get(`/api/shops/${shopId}/statements/2026-03`),
            ),
          )
        ).map((r) => r.status);
        expect(statuses).toEqual(Array(30).fill(200));
      }
      const limited = await own
        .as(me)
        .get(`/api/shops/${shopId}/statements/2026-03`);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();

      proxy.mode = 'refuse';
      proxy.sever();
      await new Promise((r) => setTimeout(r, 300));
      const other = await own.member(shopId, 'OWNER');
      expect(
        (await own.as(other).get(`/api/shops/${shopId}/statements/2026-03`))
          .status,
      ).toBe(200);
      const before = (
        await own.sql<{ n: string }>(
          `SELECT count(*)::text AS n FROM "CommissionRate"`,
        )
      )[0].n;
      const write = await own
        .as(admin)
        .post('/api/admin/commission-rates')
        .set('Idempotency-Key', uuidv4())
        .send(rc1(shopId));
      expect(write.status).toBe(503);
      expect(
        (
          await own.sql<{ n: string }>(
            `SELECT count(*)::text AS n FROM "CommissionRate"`,
          )
        )[0].n,
      ).toBe(before);
    } finally {
      proxy.mode = 'pass';
      await own.close();
      await proxy.close();
    }
  }, 120_000);
});
