import { Sequelize } from 'sequelize-typescript';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { JobRegistry } from '@app/infrastructure/jobs/job-registry.service';
import { RecommendationsService } from './application/recommendations.service';
import { CoOccurrenceJobs } from './infra/co-occurrence.jobs';
import {
  createRecommendationsApp,
  seedCatalog,
  seedDatasetD,
  type PaidOrder,
  type RecommendationsTestApp,
} from './testing/recommendations.fixtures';

const DAY = 86_400_000;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const buyer = (n: number) => id(900_000 + n);

describe('Co-occurrence nightly build', () => {
  let t: RecommendationsTestApp;
  const extraNodes: RecommendationsTestApp[] = [];

  beforeAll(async () => {
    t = await createRecommendationsApp();
  });
  afterAll(async () => {
    for (const node of extraNodes)
      await node.app.close().catch(() => undefined);
    await t.close().catch(() => undefined);
  });
  beforeEach(async () => {
    await t.clean();
  });
  afterEach(() => jest.restoreAllMocks());

  /** `count` orders of the same products, every one by a different buyer unless `buyers` limits them. */
  const orders = (
    products: string[],
    count: number,
    over: { buyers?: number; paidAt?: Date; from?: number } = {},
  ): PaidOrder[] =>
    Array.from({ length: count }, (_, i) => ({
      productIds: products,
      userId: buyer(
        (over.from ?? 0) +
          (over.buyers ? i % over.buyers : i) +
          products.length * 1000,
      ),
      paidAt: over.paidAt ?? t.clock.now(),
    }));

  const allLists = async (products: string[]) =>
    Object.fromEntries(
      await Promise.all(
        products.map(async (p) => [p, await t.storedList(p)] as const),
      ),
    );

  describe('US4 - scoring and thresholds', () => {
    it('S34 AS-22 AS-23: dataset D yields the cosine lists; M-S (2 co-orders) is dropped and K-S (exactly 3) is kept in both', async () => {
      const d = await seedDatasetD(t);

      const result = await t.build();

      expect(result).toMatchObject({
        outcome: 'completed',
        products: 5,
        removed: 0,
      });
      const round = (list: [string, number][]) =>
        list.map(([m, s]) => [m, Math.round(s * 1e4) / 1e4]);
      expect(round(await t.storedList(d.P))).toEqual([
        [d.K, 0.6578],
        [d.C, 0.643],
        [d.M, 0.1794],
      ]);
      expect(round(await t.storedList(d.M))).toEqual([
        [d.C, 0.2067],
        [d.P, 0.1794],
      ]);
      expect(round(await t.storedList(d.C))).toEqual([
        [d.P, 0.643],
        [d.M, 0.2067],
      ]);
      expect(round(await t.storedList(d.K))).toEqual([
        [d.P, 0.6578],
        [d.S, 0.2046],
      ]);
      expect(round(await t.storedList(d.S))).toEqual([[d.K, 0.2046]]);
      expect((await t.storedList(d.M)).map(([m]) => m)).not.toContain(d.S);
      expect(result.edges).toBe(3 + 2 + 2 + 2 + 1);
    });

    it('S34 AS-24: a pair needs three different buyers, however many orders it has', async () => {
      const [a, b, d] = [1, 2, 3].map(id);
      await t.deliverPaid(
        ...orders([a, b], 5, { buyers: 1 }),
        ...orders([a, d], 3, { buyers: 3 }),
      );
      await t.build();
      expect((await t.storedList(a)).map(([m]) => m)).toEqual([d]);

      await t.deliverPaid(...orders([a, b], 1, { from: 50 }));
      await t.build();
      expect((await t.storedList(a)).map(([m]) => m)).toEqual([d]);

      await t.deliverPaid(...orders([a, b], 1, { from: 60 }));
      await t.build();
      expect((await t.storedList(a)).map(([m]) => m).sort()).toEqual(
        [b, d].sort(),
      );
    });

    it('S34 AS-25: every edge is in both lists with the identical score', async () => {
      const d = await seedDatasetD(t);
      await t.build();

      const products = [d.P, d.M, d.C, d.K, d.S];
      const lists = await allLists(products);
      for (const [a, list] of Object.entries(lists))
        for (const [b, score] of list)
          expect(lists[b].find(([m]) => m === a)?.[1]).toBe(score);
    });

    it('S34 AS-26: only orders paid at or after now minus the window count, for the pair and for the product counts', async () => {
      const [a, b, c, e, f, g, h] = [1, 2, 3, 4, 5, 6, 7].map(id);
      const now = t.clock.now();
      const inside = new Date(now.getTime() - 179 * DAY);
      const outside = new Date(now.getTime() - 181 * DAY);
      const edge = new Date(now.getTime() - 180 * DAY);
      await t.deliverPaid(
        ...orders([a, b], 3, { paidAt: inside }),
        ...orders([a, c], 1, { paidAt: inside, from: 100 }),
        ...orders([a, b], 3, { paidAt: outside, from: 200 }),
        ...orders([a, c], 2, { paidAt: outside, from: 300 }),
        ...orders([e, f], 3, { paidAt: edge }),
        ...orders([g, h], 3, { paidAt: new Date(edge.getTime() - 1) }),
      );

      await t.build();

      // co(a,b) = 3, n(a) = 4 (3 + 1 inside), n(b) = 3
      const ab = (await t.storedList(a)).find(([m]) => m === b)!;
      expect(ab[1]).toBeCloseTo(3 / Math.sqrt(4 * 3), 10);
      expect((await t.storedList(e)).map(([m]) => m)).toEqual([f]);
      expect(await t.storedList(g)).toEqual([]);
      expect(await t.storedList(h)).toEqual([]);
    });

    it('S34 AS-27: the list is the best 20 by score, equal scores broken by productId ascending', async () => {
      const a = id(1);
      const tied = Array.from({ length: 20 }, (_, i) => id(100 + i));
      const better = Array.from({ length: 5 }, (_, i) => id(200 + i));
      await t.deliverPaid(
        ...tied.flatMap((n, i) => orders([a, n], 3, { from: i * 10 })),
        ...better.flatMap((n, i) => orders([a, n], 4, { from: 1000 + i * 10 })),
      );

      await t.build();

      // the sorted set returns equal scores in reverse member order; the rail re-ranks them (productId ascending)
      const list = (await t.storedList(a))
        .sort(([ma, sa], [mb, sb]) => sb - sa || (ma < mb ? -1 : 1))
        .map(([m]) => m);
      expect(list).toHaveLength(20);
      expect(list).toEqual([...better, ...tied.slice(0, 15)]);
    });

    it('S34 AS-28: the lists and the counters are the same with 1, 4 and 16 buckets', async () => {
      const d = await seedDatasetD(t);
      const a = id(1);
      const spread = Array.from({ length: 12 }, (_, i) => id(100 + i));
      await t.deliverPaid(
        ...spread.flatMap((n, i) => orders([a, n], 3, { from: i * 10 })),
      );
      const products = [d.P, d.M, d.C, d.K, d.S, a, ...spread];

      const runs: { result: unknown; lists: unknown }[] = [];
      for (const buckets of [1, 4, 16]) {
        const result = await t.build({ buckets });
        runs.push({ result, lists: await allLists(products) });
      }

      expect(runs[1]).toEqual(runs[0]);
      expect(runs[2]).toEqual(runs[0]);
    });
  });

  describe('US6 - a safe nightly build', () => {
    it('S34 AS-36: a rerun over unchanged baskets gives the same lists and the same result', async () => {
      const d = await seedDatasetD(t);
      const products = [d.P, d.M, d.C, d.K, d.S];

      const first = await t.build();
      const lists = await allLists(products);
      const second = await t.build();

      expect(second).toEqual(first);
      expect(await allLists(products)).toEqual(lists);
    });

    it('S34 AS-37: 50 concurrent readers see the complete old list or the complete new list, never a partial one', async () => {
      const d = await seedDatasetD(t);
      await t.build();
      const service = t.app.get(RecommendationsService, { strict: false });
      const oldList = (await service.boughtTogether(d.M, {})).items.map(
        (i) => i.productId,
      );
      await t.deliverPaid(...orders([d.M, d.K], 3, { from: 70 }));
      let building = true;
      const seen = new Set<string>();
      const readers = Array.from({ length: 50 }, async () => {
        while (building) {
          const items = (await service.boughtTogether(d.M, {})).items.map(
            (i) => i.productId,
          );
          seen.add(JSON.stringify(items));
        }
      });

      const result = await t.build();
      building = false;
      await Promise.all(readers);

      const newList = (await service.boughtTogether(d.M, {})).items.map(
        (i) => i.productId,
      );
      expect(result.outcome).toBe('completed');
      expect(newList).not.toEqual(oldList);
      for (const raw of seen)
        expect([JSON.stringify(oldList), JSON.stringify(newList)]).toContain(
          raw,
        );
    });

    it('S34 AS-38: a product that lost every edge loses its list after a complete build, and a failed build removes nothing', async () => {
      const [a, b, c, d] = [1, 2, 3, 4].map(id);
      await t.deliverPaid(...orders([a, b], 3));
      await t.build();
      expect(await t.storedList(a)).not.toEqual([]);
      await t.clickhouse
        .getClient()
        .command({ query: 'TRUNCATE TABLE recommendation_baskets' });
      await t.deliverPaid(...orders([c, d], 3, { from: 40 }));

      jest
        .spyOn(t.clickhouse, 'query')
        .mockRejectedValueOnce(new Error('boom'));
      await expect(t.build()).rejects.toThrow();
      expect(await t.storedList(a)).not.toEqual([]);
      expect(await t.storedList(b)).not.toEqual([]);
      jest.restoreAllMocks();

      const result = await t.build();

      expect(result).toMatchObject({ outcome: 'completed', removed: 2 });
      expect(await t.storedList(a)).toEqual([]);
      expect(await t.storedList(b)).toEqual([]);
      expect((await t.storedList(c)).map(([m]) => m)).toEqual([d]);
    });

    it('S34 AS-39: with no eligible basket the build ends skipped_empty, writes and removes nothing, and counts it', async () => {
      const [a, b] = [1, 2].map(id);
      await t.deliverPaid(...orders([a, b], 3));
      await t.build();
      const lists = await allLists([a, b]);
      await t.clickhouse
        .getClient()
        .command({ query: 'TRUNCATE TABLE recommendation_baskets' });
      const before =
        MetricsRegistry.value('recommendations_build_skipped_total', {
          reason: 'empty',
        }) ?? 0;

      const result = await t.build();

      expect(result).toMatchObject({
        outcome: 'skipped_empty',
        products: 0,
        edges: 0,
        removed: 0,
      });
      expect(await allLists([a, b])).toEqual(lists);
      expect(
        (MetricsRegistry.value('recommendations_build_skipped_total', {
          reason: 'empty',
        }) ?? 0) - before,
      ).toBe(1);
    });

    it('S34 AS-40: a failure on the 3rd bucket query leaves complete lists, deletes nothing and does not advance the success timestamp', async () => {
      const products = Array.from({ length: 40 }, (_, i) => id(i + 1));
      const ring = (step: number): PaidOrder[] =>
        products.flatMap((p, i) =>
          orders([p, products[(i + step) % products.length]], 3, {
            from: step * 1000 + i * 10,
          }),
        );
      await t.deliverPaid(...ring(1));
      await t.build({ buckets: 4 });
      const v1 = await allLists(products);
      await t.deliverPaid(...ring(2));
      const stamp = MetricsRegistry.value(
        'recommendations_build_last_success_timestamp',
      );

      const real = t.clickhouse.query.bind(t.clickhouse);
      let edgeQueries = 0;
      jest.spyOn(t.clickhouse, 'query').mockImplementation(((
        sql: string,
        params: never,
      ) => {
        if (/cityHash64/.test(sql) && ++edgeQueries === 3)
          return Promise.reject(new Error('source failed'));
        return real(sql, params);
      }) as never);
      await expect(t.build({ buckets: 4 })).rejects.toThrow();
      jest.restoreAllMocks();

      const after = await allLists(products);
      const changed = products.filter(
        (p) => JSON.stringify(after[p]) !== JSON.stringify(v1[p]),
      );
      const same = products.filter(
        (p) => JSON.stringify(after[p]) === JSON.stringify(v1[p]),
      );
      expect(changed.length).toBeGreaterThan(0);
      expect(same.length).toBeGreaterThan(0);
      for (const p of products) expect(after[p].length).toBeGreaterThan(0);
      // a changed list is the complete new list: both neighbours of the denser graph
      for (const p of changed) expect(after[p].length).toBe(4);
      expect(
        MetricsRegistry.value('recommendations_build_last_success_timestamp'),
      ).toBe(stamp);
    });

    it('S34 AS-41: two builds at once do the work once and the other reports skipped_locked; a crashed holder is outlived by the lease', async () => {
      const d = await seedDatasetD(t);
      const products = [d.P, d.M, d.C, d.K, d.S];
      const single = await t.build();
      const lists = await allLists(products);
      await t.redis.client.flushdb();

      const [x, y] = await Promise.all([t.build(), t.build()]);

      expect([x.outcome, y.outcome].sort()).toEqual([
        'completed',
        'skipped_locked',
      ]);
      expect([x, y].find((r) => r.outcome === 'completed')).toEqual(single);
      expect(await allLists(products)).toEqual(lists);
      expect(await t.redis.client.exists('rec:build:lock')).toBe(0);

      await t.redis.client.set(
        'rec:build:lock',
        'crashed-holder',
        'PX',
        3_600_000,
      );
      expect((await t.build()).outcome).toBe('skipped_locked');
      expect(await t.redis.client.get('rec:build:lock')).toBe('crashed-holder');
      await t.redis.client.pexpire('rec:build:lock', 1);
      await new Promise((r) => setTimeout(r, 20));
      expect((await t.build()).outcome).toBe('completed');
    });

    it('S34 AS-41: the lock is held for the one-hour lease while the build runs', async () => {
      await seedDatasetD(t);
      const real = t.clickhouse.query.bind(t.clickhouse);
      let ttl = 0;
      jest.spyOn(t.clickhouse, 'query').mockImplementation((async (
        sql: string,
        params: never,
      ) => {
        if (/cityHash64/.test(sql) && ttl === 0)
          ttl = await t.redis.client.pttl('rec:build:lock');
        return real(sql, params);
      }) as never);

      await t.build();

      expect(ttl).toBeGreaterThan(3_590_000);
      expect(ttl).toBeLessThanOrEqual(3_600_000);
    });

    it('S34 AS-43: a list carries a three-day lifetime, and an expired list is withdrawn from the rail', async () => {
      const d = await seedDatasetD(t);
      await t.build();

      const ttl = await t.redis.client.ttl(`rec:bought:{${d.M}}`);

      expect(ttl).toBeGreaterThan(259_200 - 30);
      expect(ttl).toBeLessThanOrEqual(259_200);
      expect((await t.rail(d.M)).items).not.toEqual([]);
      await t.redis.client.del(`rec:bought:{${d.M}}`); // the boundary: the store drops the key at its TTL
      expect(await t.rail(d.M)).toEqual({ type: 'bought-together', items: [] });
    });

    it('S34 AS-44: the schedule exists once across two workers and a restart, and the handler options carry the one-hour lease', async () => {
      const second = await createRecommendationsApp();
      const sequelize = t.app.get(Sequelize);
      const count = async () =>
        Number(
          (
            (
              await sequelize.query(
                `SELECT count(*) AS n FROM "JobSchedule" WHERE "name" = 'recommendations.build-bought-together'`,
              )
            )[0] as { n: string }[]
          )[0].n,
        );
      expect(await count()).toBe(1);

      await t.app
        .get(CoOccurrenceJobs, { strict: false })
        .onApplicationBootstrap();
      await second.app
        .get(CoOccurrenceJobs, { strict: false })
        .onApplicationBootstrap();

      expect(await count()).toBe(1);
      const [row] = (
        await sequelize.query(
          `SELECT "cron", "jobType" FROM "JobSchedule" WHERE "name" = 'recommendations.build-bought-together'`,
        )
      )[0] as { cron: string; jobType: string }[];
      expect(row).toEqual({
        cron: '17 3 * * *',
        jobType: 'recommendations.build-bought-together',
      });
      expect(
        t.app
          .get(JobRegistry, { strict: false })
          .get('recommendations.build-bought-together'),
      ).toMatchObject({
        fleetConcurrency: 1,
        leaseMs: 3_600_000,
        maxRuntimeMs: 3_600_000,
      });
      // closing an app closes the process-wide database pool, so the extra node stays up until the file ends
      extraNodes.push(second);
    });

    it('S34 AS-22: the product counts include every eligible basket, not only the ones that formed a qualifying pair', async () => {
      const d = await seedCatalog(t);
      await t.deliverPaid(
        ...orders([d.P, d.M], 3),
        ...orders([d.P, d.K], 1, { from: 500 }),
        ...orders([d.M, d.C], 1, { from: 600 }),
      );

      await t.build();

      const [, score] = (await t.storedList(d.P))[0];
      expect(score).toBeCloseTo(3 / Math.sqrt(4 * 4), 10);
    });
  });
});
