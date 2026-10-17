import { v4 as uuidv4 } from 'uuid';
import { competitorPriceDroppedSchema } from '@marketplace-sandbox/contracts';
import { TransactionRunner } from '@app/infrastructure/context';
import { createProducts } from '@app/test/utils/catalog-fixtures';
import {
  createCompetitorApp,
  T0,
  type CompetitorTestApp,
  type SeededShop,
  type TestUser,
} from './testing/competitor-fixtures';
import { eventIdFor } from './domain/alert-rule';
import { CompetitorShopProjector } from './infra/projectors/competitor.projectors';

const U1 = 'https://rival.test/p/iphone';
const TYPE = 'sellerinsights.competitor_price_dropped';

describe('Competitor monitor: price-drop alerts (events, atomicity, replay)', () => {
  let t: CompetitorTestApp;
  let A: SeededShop;
  let olga: TestUser;
  let stan: TestUser;
  let vic: TestUser;
  let PA: { id: string };
  let watchId: string;
  const site = () => t.sites['rival.test'];

  beforeAll(async () => {
    t = await createCompetitorApp({ sites: ['rival.test', 'other.test'] });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    A = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
    olga = await t.owner(A.shopId);
    stan = await t.member(A.shopId, 'STAFF');
    vic = await t.member(A.shopId, 'VIEWER');
    PA = await t.product(A.shopId, { priceMinor: 99_900, title: 'iPhone 17' });
    watchId = (await t.register(stan, A.shopId, PA.id, U1)).id;
  });

  const target = async () => (await t.target(U1))!;
  const crawlAt = async (price: string, currency = 'EUR') => {
    site().priced('/p/iphone', price, currency, {
      widget: `offer ${price} ${currency}`,
    });
    const row = await target();
    t.clock.set(new Date(Math.max(t.clock.nowMs(), row.nextCheckAt.getTime())));
    await t.cycle();
    return target();
  };
  const alerts = (id = watchId) => t.alerts(id);
  const bodyOf = (row: { payload: unknown }) =>
    row.payload as {
      eventId: string;
      type: string;
      version: number;
      aggregateType: string;
      aggregateId: string;
      aggregateVersion: number;
      occurredAt: string;
      payload: Record<string, unknown>;
    };
  const eventCount = async () =>
    (
      await t.pg<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM "Outbox" WHERE "type" = :type`,
        { type: TYPE },
      )
    )[0].n;

  describe('who is alerted and when', () => {
    it('S41 AS-43: an undercutting price writes one event per owner with the exact envelope and a deterministic id', async () => {
      await crawlAt('899.00');

      const rows = await alerts();
      expect(rows).toHaveLength(2);
      const owners = new Set(rows.map((r) => bodyOf(r).payload.ownerId));
      expect(owners).toEqual(new Set([A.owner.id, olga.id]));
      for (const row of rows) {
        expect(row.topic).toBe('seller_insights.events');
        expect(row.aggregateType).toBe('seller_insights');
        const envelope = bodyOf(row);
        expect(envelope).toMatchObject({
          type: TYPE,
          version: 1,
          aggregateType: 'seller_insights',
          aggregateId: watchId,
          aggregateVersion: 1,
          occurredAt: T0.toISOString(),
        });
        expect(envelope.eventId).toBe(
          eventIdFor(watchId, 1, envelope.payload.ownerId as string),
        );
        const payload = competitorPriceDroppedSchema.parse(envelope.payload);
        expect(payload).toMatchObject({
          watchId,
          shopId: A.shopId,
          productId: PA.id,
          productTitle: 'iPhone 17',
          host: 'rival.test',
          competitorPriceMinor: 89_900,
          yourPriceMinor: 99_900,
          currency: 'EUR',
          priceVersion: 1,
        });
        expect(JSON.stringify(envelope)).not.toMatch(/\/p\/iphone/);
        expect([stan.id, vic.id]).not.toContain(payload.ownerId);
      }
      const [first, second] = rows.map(bodyOf);
      expect(first.eventId).not.toBe(second.eventId);
      const { ownerId: _a, ...restA } = first.payload;
      const { ownerId: _b, ...restB } = second.payload;
      expect(restA).toEqual(restB);
    });

    it.each([
      ['higher', '1099.00'],
      ['equal', '999.00'],
    ])(
      'S41 AS-44: a %s price is recorded without an event',
      async (_name, price) => {
        const row = await crawlAt(price);

        expect(row.observationNo).toBe(1);
        expect(await alerts()).toHaveLength(0);
        expect(await eventCount()).toBe(0);
      },
    );

    it('S41 AS-45: an event is written for each new drop below the seller, not for each crawl', async () => {
      const seen: Array<[string, number[]]> = [];
      for (const price of [
        '899.00',
        '899.00',
        '849.00',
        '950.00',
        '900.00',
        '1200.00',
        '1250.00',
      ]) {
        await crawlAt(price);
        seen.push([
          price,
          (await alerts())
            .map((r) => bodyOf(r).payload.priceVersion as number)
            .filter((v, i, all) => all.indexOf(v) === i),
        ]);
      }

      expect(seen.map(([, versions]) => versions)).toEqual([
        [1],
        [1],
        [1, 2],
        [1, 2],
        [1, 2, 4],
        [1, 2, 4],
        [1, 2, 4],
      ]);
      expect((await target()).observationNo).toBe(6);
      const rows = await alerts();
      expect(rows).toHaveLength(6);
      expect(
        rows
          .map((r) => bodyOf(r).payload.competitorPriceMinor)
          .filter((v, i, a) => a.indexOf(v) === i),
      ).toEqual([89_900, 84_900, 90_000]);
    });
  });

  describe('comparison basis', () => {
    it('S41 AS-46: a price in another currency is recorded and not compared', async () => {
      const before = t.metrics.evaluation('currency_mismatch');

      const row = await crawlAt('949.00', 'USD');

      expect(row).toMatchObject({ observationNo: 1, currency: 'USD' });
      expect(await alerts()).toHaveLength(0);
      expect(t.metrics.evaluation('currency_mismatch')).toBe(before + 1);
    });

    it.each([
      ['archived', `UPDATE "Product" SET "status" = 'ARCHIVED'`],
      ['deleted', `DELETE FROM "Product"`],
    ])(
      'S41 AS-46: a product that is %s since the registration is not alerted on',
      async (_name, sql) => {
        await t.pg(`${sql} WHERE "id" = :id`, { id: PA.id });
        const before = t.metrics.evaluation('product_unavailable');

        await crawlAt('899.00');

        expect(await alerts()).toHaveLength(0);
        expect(t.metrics.evaluation('product_unavailable')).toBe(before + 1);
      },
    );

    it('S41 AS-46: your price is read when the observation is evaluated and a later price change re-evaluates nothing', async () => {
      await t.pg(
        `UPDATE "Product" SET "priceMinor" = 95000, "price" = 95000 WHERE "id" = :id`,
        { id: PA.id },
      );
      await crawlAt('899.00');
      expect(bodyOf((await alerts())[0]).payload.yourPriceMinor).toBe(95_000);

      await t.pg(
        `UPDATE "Product" SET "priceMinor" = 80000, "price" = 80000 WHERE "id" = :id`,
        { id: PA.id },
      );
      const unchanged = await crawlAt('899.00');
      expect(unchanged.observationNo).toBe(1);
      expect(await alerts()).toHaveLength(2);

      const next = await crawlAt('850.00');
      expect(next.observationNo).toBe(2);
      expect(await alerts()).toHaveLength(2);
    });

    it('S41 AS-47: only the watchers the price undercuts are alerted, each with its own price', async () => {
      const B = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
      const PB = await t.product(B.shopId, { priceMinor: 85_000 });
      const bWatch = (await t.register(B.owner, B.shopId, PB.id, U1)).id;

      await crawlAt('899.00');
      expect(await alerts()).toHaveLength(2);
      expect(await alerts(bWatch)).toHaveLength(0);

      await crawlAt('800.00');
      expect(await alerts(bWatch)).toHaveLength(1);
      expect(bodyOf((await alerts(bWatch))[0]).payload).toMatchObject({
        yourPriceMinor: 85_000,
        competitorPriceMinor: 80_000,
      });
      const forA = (await alerts())
        .map(bodyOf)
        .filter((e) => e.aggregateVersion === 2);
      expect(forA).toHaveLength(2);
      for (const e of forA) expect(e.payload.yourPriceMinor).toBe(99_900);
    });

    it('S41 AS-47: 1200 watches of one target are evaluated in batches of 500, no event twice, even with two crawls at once', async () => {
      const products = await createProducts(t.app, { id: A.shopId }, 1_200, {
        priceMinor: 99_900,
        currency: 'EUR',
      });
      const row = await target();
      const values = products
        .map(
          (p, i) =>
            `('${uuidv4()}', '${A.shopId}', '${p.id}', '${row.id}', '${new Date(T0.getTime() + i).toISOString()}')`,
        )
        .join(',');
      await t.pg(
        `INSERT INTO "CompetitorWatch" ("id", "shopId", "productId", "targetId", "createdAt") VALUES ${values}`,
      );
      site().priced('/p/iphone', '899.00');

      await Promise.all([t.crawl.crawl(row.id), t.crawl.crawl(row.id)]);

      const [{ total, distinct }] = await t.pg<{
        total: number;
        distinct: number;
      }>(
        `SELECT COUNT(*)::int AS total, COUNT(DISTINCT "payload"->>'eventId')::int AS distinct FROM "Outbox" WHERE "type" = :type`,
        { type: TYPE },
      );
      // 1201 watches (the registered one too) x 2 owners
      expect(total).toBe(1_201 * 2);
      expect(distinct).toBe(total);
      const [{ pending }] = await t.pg<{ pending: number }>(
        `SELECT COUNT(*)::int AS pending FROM "CompetitorWatch" WHERE "lastEvaluatedObservationNo" < 1`,
      );
      expect(pending).toBe(0);
      expect((await target()).evaluatedNo).toBe(1);
    }, 120_000);
  });

  describe('atomicity and replay', () => {
    it('S41 AS-48: an outbox failure rolls the whole observation back; the retry records it and writes the events once', async () => {
      await t.failOutbox(true);
      site().priced('/p/iphone', '899.00');

      await t.cycle();

      const failed = await target();
      expect(failed).toMatchObject({
        observationNo: 0,
        lastPriceMinor: null,
        lastStatus: 'history_unavailable',
      });
      expect(failed.nextCheckAt).toEqual(new Date(T0.getTime() + 15 * 60_000));
      expect((await t.watchRows())[0]).toMatchObject({
        lastEvaluatedObservationNo: 0,
      });
      expect(await eventCount()).toBe(0);

      await t.failOutbox(false);
      const recovered = await crawlAt('899.00');
      expect(recovered.observationNo).toBe(1);
      expect(await alerts()).toHaveLength(2);
      expect(
        (await t.history(recovered.id)).filter((r) => r.observation_no === 1),
      ).toHaveLength(1);
    });

    it('S41 AS-48: running the same observation again writes no second row', async () => {
      await crawlAt('899.00');
      expect(await alerts()).toHaveLength(2);
      const id = (await target()).id;

      // a re-run after a crash: nothing is pending for counter 1 any more
      await t.evaluation.evaluatePending(id);
      expect(await alerts()).toHaveLength(2);

      // a worker still holding the watch as it was before the commit evaluates it again: the claim refuses
      const stale = (await t.watchRows()).map((w) => ({
        id: w.id,
        shopId: w.shopId,
        productId: w.productId,
        targetId: w.targetId,
        status: 'ACTIVE' as const,
        createdAt: w.createdAt,
        lastEvaluatedObservationNo: 0,
        lastEvaluatedPriceMinor: null,
      }));
      const written = await t.app.get(TransactionRunner).run(async () =>
        t.evaluation.evaluateBatch(
          await t.evaluation.prefetch(stale),
          {
            id,
            host: 'rival.test',
            observationNo: 1,
            priceMinor: 89_900,
            currency: 'EUR',
          },
          stale,
        ),
      );
      expect(written).toBe(0);
      expect(await alerts()).toHaveLength(2);
      expect(new Set((await alerts()).map((r) => bodyOf(r).eventId)).size).toBe(
        2,
      );
    });

    it('S41 AS-49: a watch on an already observed target is evaluated in its registration; none when not undercut; none on replay', async () => {
      site().priced('/p/iphone', '899.00');
      const B = await t.seedShop({ plan: 'PRO', limit: 100, announce: true });
      const PB = await t.product(B.shopId, { priceMinor: 50_000 });
      await t.register(B.owner, B.shopId, PB.id, U1);
      await t.pg(`DELETE FROM "CompetitorWatch" WHERE "id" = :id`, {
        id: watchId,
      });
      await t.cycle();
      expect((await target()).observationNo).toBe(1);

      const PA2 = await t.product(A.shopId, { priceMinor: 99_900 });
      const mine = await t.register(stan, A.shopId, PA2.id, U1);
      const rows = await alerts(mine.id);
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(bodyOf(row)).toMatchObject({
          aggregateVersion: 1,
          payload: { priceVersion: 1 },
        });

      const PA3 = await t.product(A.shopId, { priceMinor: 85_000 });
      const cheap = await t.register(stan, A.shopId, PA3.id, U1);
      expect(await alerts(cheap.id)).toHaveLength(0);

      const again = await t.register(stan, A.shopId, PA2.id, U1);
      expect(again.created).toBe(false);
      expect(await alerts(mine.id)).toHaveLength(2);
    });
  });

  describe('recipients and paused shops', () => {
    it('S41 AS-50: a shop whose owners resolve to nobody records the observation, writes no event and warns', async () => {
      await t.pg(
        `DELETE FROM "ShopMembership" WHERE "shopId" = :shopId AND "role" = 'OWNER'`,
        { shopId: A.shopId },
      );
      const before = t.metrics.evaluation('no_recipient');

      const row = await crawlAt('899.00');

      expect(row.observationNo).toBe(1);
      expect(await alerts()).toHaveLength(0);
      expect(t.metrics.evaluation('no_recipient')).toBe(before + 1);
      const warn = t
        .logs()
        .find((l) => l.line.event === 'competitor_alert_no_recipient');
      expect(warn?.level).toBe('warn');
      expect(warn?.line).toMatchObject({ watchId, shopId: A.shopId });
    });

    it('S41 AS-50: the watches of a suspended shop are never crawled or evaluated', async () => {
      site().priced('/p/iphone', '899.00');
      await t.deliver(t.projector(CompetitorShopProjector), [
        t.shopStatusChanged({
          shopId: A.shopId,
          to: 'SUSPENDED',
          shopVersion: 5,
        }),
      ]);

      await t.cycle();

      expect(site().requests()).toHaveLength(0);
      expect((await target()).observationNo).toBe(0);
      expect(await alerts()).toHaveLength(0);
    });
  });
});
