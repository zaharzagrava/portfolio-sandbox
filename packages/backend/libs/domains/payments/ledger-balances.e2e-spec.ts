import { v4 as uuidv4 } from 'uuid';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { balanceSchema } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { routeEnvelope } from '@app/infrastructure/projections/routing';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { createLedgerApp, type LedgerTestApp } from './testing/ledger-app';
import { assertBooksHealthy, count, sql } from './testing/ledger-fixtures';
import { JournalInvalid } from './domain/ledger-errors';
import { shardOf } from './domain/shard';
import {
  BALANCE_DURABLE_STORE,
  BALANCE_HOT_STORE,
  type BalanceReadModelStore,
} from './domain/ledger-ports';
import { LedgerProjectorModule } from './ledger-projector.module';
import { BalanceProjector } from './infra/balance.projector';

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Ledger: running balances, read model and balance endpoint', () => {
  let t: LedgerTestApp;
  let projector: BalanceProjector;
  let hot: BalanceReadModelStore;
  let durable: BalanceReadModelStore;
  let projected = new Set<string>();

  beforeAll(async () => {
    t = await createLedgerApp({ extraImports: [LedgerProjectorModule] });
    projector = t.app.get(BalanceProjector, { strict: false });
    hot = t.app.get<BalanceReadModelStore>(BALANCE_HOT_STORE, {
      strict: false,
    });
    durable = t.app.get<BalanceReadModelStore>(BALANCE_DURABLE_STORE, {
      strict: false,
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    projected = new Set();
    jest.restoreAllMocks();
  });

  const adjust = (
    lines: { accountId: string; amountMinor: number }[],
    kind: 'ADJUSTMENT' | 'AD_CHARGE' = 'ADJUSTMENT',
    reference = `t-${uuidv4()}`,
  ) =>
    t.inTx((tx) =>
      t.ledger.postJournal({ kind, reference, currency: 'EUR', lines }, tx),
    );
  const fund = (shopId: string, amountMinor: number) =>
    adjust([
      { accountId: 'PAYOUTS_SENT', amountMinor: -amountMinor },
      { accountId: `SHOP_${shopId}`, amountMinor },
    ]);
  const outbox = async (): Promise<EventEnvelope[]> => {
    const rows = await sql<{ id: string; payload: EventEnvelope }>(
      t.app,
      `SELECT "id", "payload" FROM "Outbox" WHERE "type" = 'ledger.journal_posted' ORDER BY "createdAt", "id"`,
    );
    return rows.map((r) => r.payload);
  };
  /** The relay and the consumer framework in one step: delivers the journal events not delivered before. */
  const projectNew = async () => {
    const fresh = (await outbox()).filter((e) => !projected.has(e.eventId));
    fresh.forEach((e) => projected.add(e.eventId));
    await projector.project(fresh);
  };
  const eraseReadModel = async (accountIds: string[]) => {
    const redis = t.app.get(RedisService);
    const dynamo = t.app.get(DynamoService);
    for (const accountId of accountIds) {
      await redis.client.del(`ledger:balance:${accountId}`);
      for (const line of await durable.get(accountId))
        await dynamo.doc.send(
          new DeleteCommand({
            TableName: dynamo.table('LedgerBalanceView'),
            Key: { accountId, shardNo: line.shard },
          }),
        );
    }
  };
  const queriedEntries = async <T>(fn: () => Promise<T>) => {
    const statements: string[] = [];
    const previous = t.sequelize.options.logging;
    t.sequelize.options.logging = (sqlText: string) =>
      void statements.push(sqlText);
    try {
      const result = await fn();
      return {
        result,
        entries: statements.filter((s) => /LedgerEntry/.test(s)),
      };
    } finally {
      t.sequelize.options.logging = previous;
    }
  };

  it('S14 AS-28: getBalances reads exact running balances without touching the entries, collapses duplicates and sees its own transaction', async () => {
    const [a, b] = [uuidv4(), uuidv4()];
    await adjust([
      { accountId: `SHOP_${a}`, amountMinor: -250 },
      { accountId: `SHOP_${b}`, amountMinor: 250 },
    ]);
    t.clock.set(new Date('2026-10-12T10:00:00.000Z'));
    const ids = [
      `SHOP_${a}`,
      `SHOP_${b}`,
      `SHOP_${a}`,
      `SHOP_${uuidv4()}`,
      'PLATFORM_FEES',
    ];
    const { result, entries } = await queriedEntries(() =>
      t.ledger.getBalances({ accountIds: ids, currency: 'EUR' }),
    );
    expect(entries).toEqual([]);
    expect([...result.keys()].sort()).toEqual([...new Set(ids)].sort());
    expect(result.get(`SHOP_${a}`)).toEqual({
      balanceMinor: -250,
      asOf: new Date('2026-10-12T10:00:00.000Z'),
    });
    expect(result.get(`SHOP_${b}`)!.balanceMinor).toBe(250);
    expect(result.get('PLATFORM_FEES')!.balanceMinor).toBe(0); // no row: zero
    expect(
      [...result.values()].filter((v) => v.balanceMinor === 0),
    ).toHaveLength(2);

    const tooMany = Array.from({ length: 501 }, () => `SHOP_${uuidv4()}`);
    await expect(
      t.ledger.getBalances({ accountIds: tooMany, currency: 'EUR' }),
    ).rejects.toMatchObject({ reason: 'too_many_accounts' });
    await expect(
      t.ledger.getBalances({
        accountIds: [...tooMany.slice(0, 500), ...tooMany.slice(0, 5)],
        currency: 'EUR',
      }),
    ).resolves.toHaveProperty('size', 500);

    // its own uncommitted posting is visible inside the transaction and not to another reader
    let posted!: () => void;
    const gate = new Promise<void>((resolve) => (posted = resolve));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const inflight = t.inTx(async (tx) => {
      await t.ledger.postJournal(
        {
          kind: 'ADJUSTMENT',
          reference: 'own',
          currency: 'EUR',
          lines: [
            { accountId: `SHOP_${a}`, amountMinor: 5 },
            { accountId: `SHOP_${b}`, amountMinor: -5 },
          ],
        },
        tx,
      );
      const inside = await t.ledger.getBalances(
        { accountIds: [`SHOP_${a}`], currency: 'EUR' },
        tx,
      );
      expect(inside.get(`SHOP_${a}`)!.balanceMinor).toBe(-245);
      posted();
      await hold;
    });
    await gate;
    const outside = await t.ledger.getBalances({
      accountIds: [`SHOP_${a}`],
      currency: 'EUR',
    });
    expect(outside.get(`SHOP_${a}`)!.balanceMinor).toBe(-250);
    release();
    await inflight;
    await expect(
      t.ledger.getBalances({ accountIds: ['x'], currency: 'eur' }),
    ).rejects.toBeInstanceOf(JournalInvalid);
  });

  it('S14 AS-29: listSellerBalances pages 20/20/5 by keyset with no repeat or skip under concurrent postings, filters by minimum and refuses bad input', async () => {
    const shops = Array.from({ length: 45 }, () => uuidv4()).sort();
    const credits = shops.map((s, i) => ({
      accountId: `SHOP_${s}`,
      amountMinor: i === 0 ? 5 : 1000 + (i % 2),
    }));
    await adjust([
      {
        accountId: 'PAYOUTS_SENT',
        amountMinor: -credits.reduce((n, c) => n + c.amountMinor, 0),
      },
      ...credits,
    ]);
    const seen: string[] = [];
    let after: string | undefined;
    const sizes: number[] = [];
    do {
      const page = await t.ledger.listSellerBalances({
        currency: 'EUR',
        minMinor: 0,
        limit: 20,
        after,
      });
      sizes.push(page.items.length);
      seen.push(...page.items.map((i) => i.shopId));
      // a posting lands between the pages
      await fund(uuidv4(), 10);
      after = page.next ?? undefined;
    } while (after);
    expect(sizes.slice(0, 2)).toEqual([20, 20]);
    expect(new Set(seen).size).toBe(seen.length); // no repeat
    for (const s of shops) expect(seen).toContain(s); // no skip of an existing account

    const big = await t.ledger.listSellerBalances({
      currency: 'EUR',
      minMinor: 1000,
      limit: 200,
    });
    expect(big.items.every((i) => i.balanceMinor >= 1000)).toBe(true);
    expect(big.items.some((i) => i.shopId === shops[0])).toBe(false);
    expect(big.next).toBeNull();

    await expect(
      t.ledger.listSellerBalances({ currency: 'EUR', minMinor: 0, limit: 201 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      t.ledger.listSellerBalances({ currency: 'EUR', minMinor: 0, limit: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      t.ledger.listSellerBalances({
        currency: 'EUR',
        minMinor: 0,
        limit: 10,
        after: 'tampered.cursor',
      }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('S14 AS-30: the projector applies absolute balances once: duplicates and older versions change nothing, a full replay rebuilds the stores, shards project apart', async () => {
    const a = uuidv4();
    await fund(a, 100);
    await fund(a, 40);
    // The fee line lands on the shard picked by the hash of the reference. The check below uses shards 3 and 9 of
    // PLATFORM_FEES, so the reference must not hash to either (with a random one, 2 runs in 32 hit them and failed).
    let reference = `t-${uuidv4()}`;
    while (
      [3, 9].includes(
        shardOf(reference, t.app.get(ApiConfigService).get('ledger_shards')),
      )
    )
      reference = `t-${uuidv4()}`;
    await adjust(
      [
        { accountId: `SHOP_${a}`, amountMinor: -30 },
        { accountId: 'PLATFORM_FEES', amountMinor: 30 },
      ],
      'ADJUSTMENT',
      reference,
    );
    const events = await outbox();
    await projector.project(events);
    await projector.project(events); // duplicate delivery
    await projector.project([...events].reverse()); // reordered
    const account = `SHOP_${a}`;
    expect(await hot.get(account)).toEqual([
      expect.objectContaining({ balanceMinor: 110, version: 3, shard: 0 }),
    ]);
    expect(await durable.get(account)).toEqual([
      expect.objectContaining({ balanceMinor: 110, version: 3, shard: 0 }),
    ]);

    // an older version of the same account is ignored and counted
    const staleBefore = metric('ledger_projection_stale_total');
    const older = structuredClone(events[0]) as EventEnvelope & {
      payload: {
        lines: {
          accountId: string;
          balanceAfterMinor: number;
          balanceVersion: number;
        }[];
      };
    };
    older.eventId = uuidv4();
    older.payload.lines.forEach((l) => {
      l.balanceAfterMinor = 7;
      l.balanceVersion = 1;
    });
    await projector.project([older]);
    expect((await hot.get(account))[0].balanceMinor).toBe(110);
    expect(metric('ledger_projection_stale_total')).toBeGreaterThan(
      staleBefore,
    );

    // a version 1 message (deltas) is skipped and counted, not dead-lettered
    const legacyBefore = metric('ledger_projection_legacy_skipped_total');
    const v1 = {
      ...structuredClone(events[0]),
      eventId: uuidv4(),
      version: 1,
      payload: { kind: 'SALE', lines: [{ accountId: account, amount: 5 }] },
    } as EventEnvelope;
    const routed = routeEnvelope(
      projector.handles,
      v1,
      projector.aggregateIdSchema,
    );
    expect(routed.kind).toBe('handle');
    if (routed.kind === 'handle') await projector.project([routed.envelope]);
    expect(metric('ledger_projection_legacy_skipped_total')).toBe(
      legacyBefore + 1,
    );
    expect((await hot.get(account))[0].balanceMinor).toBe(110);

    // shards project independently
    const shardEvent = structuredClone(events[0]) as EventEnvelope & {
      payload: { lines: Record<string, unknown>[] };
    };
    shardEvent.eventId = uuidv4();
    shardEvent.payload.lines = [
      {
        accountId: 'PLATFORM_FEES',
        shard: 3,
        amountMinor: 5,
        balanceAfterMinor: 5,
        balanceVersion: 1,
      },
      {
        accountId: 'PLATFORM_FEES',
        shard: 9,
        amountMinor: 7,
        balanceAfterMinor: 7,
        balanceVersion: 1,
      },
    ];
    await projector.project([shardEvent]);
    expect(
      (await durable.get('PLATFORM_FEES'))
        .filter((l) => [3, 9].includes(l.shard))
        .map((l) => [l.shard, l.balanceMinor])
        .sort(),
    ).toEqual([
      [3, 5],
      [9, 7],
    ]);

    // full replay into empty stores equals the authoritative balances
    await eraseReadModel([account, 'PLATFORM_FEES']);
    expect(await hot.get(account)).toEqual([]);
    expect(await durable.get(account)).toEqual([]);
    await projector.project(events);
    const authoritative = await t.ledger.getBalances({
      accountIds: [account],
      currency: 'EUR',
    });
    expect((await durable.get(account))[0].balanceMinor).toBe(
      authoritative.get(account)!.balanceMinor,
    );
    expect((await hot.get(account))[0].balanceMinor).toBe(
      authoritative.get(account)!.balanceMinor,
    );
  });

  it('S14 AS-31: five classes of invalid journal events are dead-lettered with a reason, leave the stores unchanged, and the next event is processed', async () => {
    const a = uuidv4();
    await fund(a, 100);
    const [good] = await outbox();
    const tamper = (mutate: (p: Record<string, any>) => void) => {
      const e = structuredClone(good) as EventEnvelope & {
        payload: Record<string, any>;
      };
      e.eventId = uuidv4();
      mutate(e.payload);
      return e as EventEnvelope;
    };
    const bad = [
      tamper((p) => delete p.lines),
      tamper((p) => (p.lines[0].balanceVersion = -1)),
      tamper((p) => (p.lines[0].balanceAfterMinor = 1.5)),
      tamper((p) => (p.journalId = 'not-a-uuid')),
      tamper((p) => (p.postedAt = 'yesterday')),
    ];
    for (const e of bad) {
      const before = metric('ledger_consumer_dead_lettered_total', {
        reason: 'invalid_payload',
      });
      await expect(projector.project([e])).rejects.toBeInstanceOf(
        PermanentError,
      );
      expect(
        metric('ledger_consumer_dead_lettered_total', {
          reason: 'invalid_payload',
        }),
      ).toBe(before + 1);
    }
    expect(await hot.get(`SHOP_${a}`)).toEqual([]);
    expect(await durable.get(`SHOP_${a}`)).toEqual([]);
    await projector.project([good]);
    expect((await hot.get(`SHOP_${a}`))[0].balanceMinor).toBe(100);
  });

  describe('GET /shops/:shopId/balance', () => {
    it('S14 AS-32: a member reads the projected balance; an empty shop reads 0; no entries query and one hot-store read', async () => {
      const user = await t.newUser();
      const shop = await createShop(t.app, user);
      await fund(shop.id, 1400);
      await projectNew();
      const hotGet = jest.spyOn(hot, 'get');
      const durableGet = jest.spyOn(durable, 'get');

      const { result: res, entries } = await queriedEntries(() =>
        t.as(user).get(`/api/shops/${shop.id}/balance`),
      );
      expect(res.status).toBe(200);
      const body = balanceSchema.parse(res.body);
      expect(body).toMatchObject({
        shopId: shop.id,
        currency: 'EUR',
        availableMinor: 1400,
        source: 'read_model',
      });
      expect(entries).toEqual([]);
      expect(hotGet).toHaveBeenCalledTimes(1);
      expect(durableGet).not.toHaveBeenCalled();

      const empty = await createShop(t.app, user);
      const res2 = await t.as(user).get(`/api/shops/${empty.id}/balance`);
      expect(res2.status).toBe(200);
      expect(balanceSchema.parse(res2.body).availableMinor).toBe(0);
    });

    it('S14 AS-33: with the hot store down the durable copy answers; with both down or empty the running balance answers the same number', async () => {
      const user = await t.newUser();
      const shop = await createShop(t.app, user);
      await fund(shop.id, 700);
      const never = await t.as(user).get(`/api/shops/${shop.id}/balance`); // nothing projected yet
      expect(never.status).toBe(200);
      expect(never.body).toMatchObject({
        availableMinor: 700,
        source: 'ledger',
      });

      await projectNew();
      jest.spyOn(hot, 'get').mockRejectedValue(new Error('redis is down'));
      const viaDurable = await t.as(user).get(`/api/shops/${shop.id}/balance`);
      expect(viaDurable.status).toBe(200);
      expect(viaDurable.body).toMatchObject({
        availableMinor: 700,
        source: 'read_model',
      });

      jest.spyOn(durable, 'get').mockRejectedValue(new Error('dynamo is down'));
      const viaLedger = await t.as(user).get(`/api/shops/${shop.id}/balance`);
      expect(viaLedger.status).toBe(200);
      expect(viaLedger.body).toMatchObject({
        availableMinor: 700,
        source: 'ledger',
      });

      jest
        .spyOn(hot, 'get')
        .mockImplementation(() => new Promise(() => undefined)); // hangs: the 100 ms bound answers
      const started = Date.now();
      const slow = await t.as(user).get(`/api/shops/${shop.id}/balance`);
      expect(slow.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('S14 AS-34: only members with payouts.read read; others get the same 404 as for an unknown shop; bad input is 400', async () => {
      const owner = await t.newUser();
      const other = await t.newUser();
      const staff = await t.newUser();
      const a = await createShop(t.app, owner);
      const b = await createShop(t.app, other);
      await addMember(t.app, a.id, staff.id, 'STAFF');
      await fund(a.id, 111);
      await fund(b.id, 222);
      await projectNew();

      expect((await t.http().get(`/api/shops/${a.id}/balance`)).status).toBe(
        401,
      );
      const stranger = await t.as(other).get(`/api/shops/${a.id}/balance`);
      const unknown = await t.as(other).get(`/api/shops/${uuidv4()}/balance`);
      expect(stranger.status).toBe(404);
      expect(unknown.status).toBe(404);
      const strip = (b2: Record<string, unknown>) => ({
        ...b2,
        requestId: undefined,
        instance: undefined,
      });
      expect(strip(stranger.body)).toEqual(strip(unknown.body));
      expect(JSON.stringify(stranger.body)).not.toContain('111');

      const staffRes = await t.as(staff).get(`/api/shops/${a.id}/balance`);
      expect(staffRes.status).toBe(403);
      expect(staffRes.body.code).toBe('permission_denied');
      expect(
        (await t.as(owner).get('/api/shops/not-a-uuid/balance')).status,
      ).toBe(400);
      expect(
        (await t.as(owner).get(`/api/shops/${a.id}/balance?currency=euro`))
          .status,
      ).toBe(400);
      expect(
        (await t.as(owner).get(`/api/shops/${a.id}/balance?currency=USD`))
          .status,
      ).toBe(400);

      // a member of b never sees a, whatever the parameters say
      const ownB = await t
        .as(other)
        .get(`/api/shops/${b.id}/balance?shopId=${a.id}`);
      expect([200, 400]).toContain(ownB.status); // an unknown query property is refused; it never selects another shop
      expect(JSON.stringify(ownB.body)).not.toContain('111');
      const plain = await t.as(other).get(`/api/shops/${b.id}/balance`);
      expect(plain.body.availableMinor).toBe(222);
      const headerClash = await t
        .as(other)
        .get(`/api/shops/${b.id}/balance`)
        .set('X-Shop-Id', a.id);
      expect(headerClash.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(headerClash.body)).not.toContain('111');
    });

    it('S14 AS-35: the 121st read in a minute is 429 with Retry-After; with the limiter store down it is still answered', async () => {
      const user = await t.newUser();
      const shop = await createShop(t.app, user);
      // 120 reads in waves of 30 at once (was one by one); the 121st below still goes after all of them
      for (let wave = 0; wave < 4; wave++)
        expect(
          (
            await Promise.all(
              Array.from({ length: 30 }, () =>
                t.as(user).get(`/api/shops/${shop.id}/balance`),
              ),
            )
          ).map((r) => r.status),
        ).toEqual(Array(30).fill(200));
      const limited = await t.as(user).get(`/api/shops/${shop.id}/balance`);
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
    });

    it('S14 AS-36: after an ad charge the balance is negative and is returned as such', async () => {
      const user = await t.newUser();
      const shop = await createShop(t.app, user);
      await adjust(
        [
          { accountId: `SHOP_${shop.id}`, amountMinor: -1000 },
          { accountId: 'PLATFORM_FEES', amountMinor: 1000 },
        ],
        'AD_CHARGE',
        'campaign:hour',
      );
      await projectNew();
      const res = await t.as(user).get(`/api/shops/${shop.id}/balance`);
      expect(res.status).toBe(200);
      expect(balanceSchema.parse(res.body)).toMatchObject({
        availableMinor: -1000,
        source: 'read_model',
      });
    });

    it('S14 AS-37: a projected balance is visible within 5 s of its posting with asOf not before the commit; without the projector the endpoint still answers', async () => {
      const user = await t.newUser();
      const shop = await createShop(t.app, user);
      const postedAt = t.clock.now();
      await fund(shop.id, 1400);

      // the projector is stopped: the answer comes from the running balance
      const before = await t.as(user).get(`/api/shops/${shop.id}/balance`);
      expect(before.body).toMatchObject({
        availableMinor: 1400,
        source: 'ledger',
      });

      t.clock.advance(3_000);
      await projectNew();
      const after = await t.as(user).get(`/api/shops/${shop.id}/balance`);
      expect(after.body).toMatchObject({
        availableMinor: 1400,
        source: 'read_model',
      });
      const asOf = new Date(after.body.asOf).getTime();
      expect(asOf).toBeGreaterThanOrEqual(postedAt.getTime());
      expect(asOf - postedAt.getTime()).toBeLessThanOrEqual(5_000);
      expect(metric('ledger_balance_projection_lag_seconds')).toBe(3);
      await assertBooksHealthy(t.app);
      expect(await count(t.app, 'LedgerJournal')).toBe(1);
    });
  });

  // Last in the file: it boots a second app, and the models are bound to the newest connection.
  it('S14 AS-35: with the limiter store down a balance read is still answered (fail open)', async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    const proxy = await TcpFaultProxy.start({
      host: redis.hostname,
      port: Number(redis.port || 6379),
    });
    const own = await createLedgerApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/${new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0').pathname.slice(1) || '0'}`,
    });
    try {
      await own.reset();
      const member = await own.newUser();
      const shop = await createShop(own.app, member);
      proxy.mode = 'refuse';
      proxy.sever();
      await new Promise((r) => setTimeout(r, 300));
      const res = await own.as(member).get(`/api/shops/${shop.id}/balance`);
      expect(res.status).toBe(200);
      expect(balanceSchema.parse(res.body).source).toBe('ledger');
    } finally {
      proxy.mode = 'pass';
      await own.close();
      await proxy.close();
    }
  }, 60_000);
});
