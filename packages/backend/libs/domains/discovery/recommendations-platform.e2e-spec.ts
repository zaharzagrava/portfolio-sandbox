import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { recommendationsResponseSchema } from '@marketplace-sandbox/contracts';
import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import {
  recommendationsConfigKeys,
  type RecommendationsConfig,
} from '@app/common/config/recommendations-config';
import { ProductQueryService } from '@app/domains/catalog';
import { ShopQueryService } from '@app/domains/tenancy';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import * as barrel from './index';
import {
  createRecommendationsApp,
  newId,
  problem,
  seedDatasetD,
  type RecommendationsTestApp,
} from './testing/recommendations.fixtures';

const parse = (env: Record<string, string>) =>
  new ConfigUtilsService().parseSrc<RecommendationsConfig>(
    recommendationsConfigKeys,
    [env as never],
  );

describe('Recommendations degradation, metrics and boundary', () => {
  describe('platform rules', () => {
    it('S34 AS-50: the entry point exports the three modules and no projector, job, model or key helper', () => {
      const names = Object.keys(barrel);
      expect(names).toEqual(
        expect.arrayContaining([
          'RecommendationsModule',
          'RecommendationsWorkerModule',
          'RecommendationsProjectorModule',
        ]),
      );
      expect(
        names.filter((n) =>
          /Basket|CoOccurrence|RecommendationKeys|RecommendationsService/.test(
            n,
          ),
        ),
      ).toEqual([]);
    });

    it('S34 AS-50: the recommendations sources read no model or table of another domain', () => {
      const files = [
        'application/recommendations.service.ts',
        'application/basket-capture.service.ts',
        'application/co-occurrence-build.service.ts',
        'recommendations.module.ts',
        'recommendations-worker.module.ts',
        'recommendations-projector.module.ts',
      ];
      for (const f of files) {
        const src = readFileSync(join(__dirname, f), 'utf8');
        const deep = src.match(
          /@app\/domains\/(catalog|tenancy|orders)\/[^'"]+/g,
        );
        expect({ f, deep }).toEqual({ f, deep: null });
        const models =
          /SequelizeModule\.forFeature|ProductModel|InjectModel/.test(src);
        expect({ f, models }).toEqual({ f, models: false });
      }
    });

    it('S34 AS-51: defaults start, and each invalid tunable fails naming its setting', () => {
      expect(parse({})).toMatchObject({
        rec_min_co_orders: 3,
        rec_min_buyers: 3,
        rec_top_n: 20,
        rec_ttl_seconds: 259_200,
      });
      const bad: [Record<string, string>, string][] = [
        [{ REC_MIN_CO_ORDERS: '0' }, 'rec_min_co_orders'],
        [{ REC_MIN_BUYERS: '0' }, 'rec_min_buyers'],
        [{ REC_TTL_SECONDS: '-5' }, 'rec_ttl_seconds'],
        [{ REC_TOP_N: '21' }, 'rec_top_n'],
        [{ REC_STORE_BUDGET_MS: '0' }, 'rec_store_budget_ms'],
      ];
      for (const [env, key] of bad) {
        expect(() => parse(env)).toThrow(key);
      }
    });
  });

  describe('degradation, metrics and consumer contract', () => {
    let t: RecommendationsTestApp;
    beforeAll(async () => {
      t = await createRecommendationsApp();
    });
    afterAll(() => t.close());
    beforeEach(() => t.clean());
    afterEach(() => jest.restoreAllMocks());

    const rail = (id: string) =>
      t.http().get(`/api/products/${id}/recommendations`);
    const unavailable = () =>
      MetricsRegistry.value('recommendations_requests_total', {
        result: 'unavailable',
      }) ?? 0;

    const expectUnavailable = (res: {
      status: number;
      body: unknown;
      headers: Record<string, string>;
    }) => {
      expect(res.status).toBe(503);
      expect(problem(res.body).code).toBe('recommendations_unavailable');
      expect(res.headers['retry-after']).toBe('5');
      expect(res.headers['cache-control']).toMatch(/no-store/);
      expect(JSON.stringify(res.body)).not.toMatch(
        /redis|rec:|bought|stack|localhost|ECONN/i,
      );
    };

    it('S34 AS-45: a store that is down or slow answers 503 recommendations_unavailable once, without retrying', async () => {
      const shop = await createShop(t.app, await t.newUser());
      const p = (await createProduct(t.app, shop)).id;
      const before = unavailable();

      const down = jest
        .spyOn(t.redis.client, 'zrevrange')
        .mockRejectedValue(new Error('ECONNREFUSED redis rec:bought'));
      expectUnavailable(await rail(p));
      expect(down).toHaveBeenCalledTimes(1);
      expect(unavailable()).toBe(before + 1);

      down.mockImplementation(
        () =>
          new Promise((resolve) => setTimeout(() => resolve([]), 400)) as never,
      );
      const started = Date.now();
      expectUnavailable(await rail(p));
      expect(Date.now() - started).toBeLessThan(380);
      expect(down).toHaveBeenCalledTimes(2);
      expect(unavailable()).toBe(before + 2);
    });

    it('S34 AS-46: a product or shop lookup that fails or overruns answers the same 503, never an unfiltered list', async () => {
      const shop = await createShop(t.app, await t.newUser());
      const x = (await createProduct(t.app, shop)).id;
      const a = (await createProduct(t.app, shop)).id;
      await t.putList(x, [[a, 0.9]]);
      const before = unavailable();

      const products = t.app.get(ProductQueryService);
      const shops = t.app.get(ShopQueryService);
      const slow = <T>(v: T) =>
        new Promise<T>((resolve) => setTimeout(() => resolve(v), 400));

      jest
        .spyOn(products, 'getProductsByIds')
        .mockRejectedValueOnce(new Error('down'));
      expectUnavailable(await rail(x));
      jest
        .spyOn(products, 'getProductsByIds')
        .mockImplementationOnce(() => slow(new Map()) as never);
      expectUnavailable(await rail(x));
      jest
        .spyOn(shops, 'getShopsByIds')
        .mockRejectedValueOnce(new Error('down'));
      expectUnavailable(await rail(x));
      jest
        .spyOn(shops, 'getShopsByIds')
        .mockImplementationOnce(() => slow(new Map()) as never);
      expectUnavailable(await rail(x));
      expect(unavailable()).toBe(before + 4);

      jest.restoreAllMocks();
      expect((await rail(x).expect(200)).body.items).toHaveLength(1);
    });

    it('S34 AS-47: every request outcome, hop, build and basket instrument exists with bounded labels, and failure logs carry no ids', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const d = await seedDatasetD(t);
      await t.build();
      await rail(d.M).expect(200);
      await rail(newId()).expect(404);
      await rail('nope').expect(400);
      jest.spyOn(t.redis.client, 'zrevrange').mockRejectedValue(new Error('x'));
      await rail(d.M).expect(503);

      for (const result of ['ok', 'not_found', 'invalid', 'unavailable']) {
        expect(
          MetricsRegistry.value('recommendations_requests_total', { result }),
        ).toBeGreaterThan(0);
      }
      expect(
        MetricsRegistry.value('recommendations_hops_total', { hops: '1' }),
      ).toBeGreaterThan(0);
      expect(
        MetricsRegistry.value('recommendations_baskets_total', {
          outcome: 'stored',
        }),
      ).toBeGreaterThan(0);
      for (const gauge of [
        'recommendations_build_products',
        'recommendations_build_edges',
        'recommendations_build_last_success_timestamp',
      ]) {
        expect(MetricsRegistry.value(gauge)).toBeGreaterThan(0);
      }
      expect(
        MetricsRegistry.histogramValue(
          'recommendations_build_duration_seconds',
        ),
      ).toBeDefined();
      for (const name of [
        'recommendations_requests_total',
        'recommendations_hops_total',
      ]) {
        const labels = JSON.stringify(MetricsRegistry.labelSets(name));
        expect(labels).not.toContain(d.M);
      }
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(d.M);
    });

    it('S34 AS-48: a visible product with no list answers 200 and an empty items array the page can hide (UI journey owned by W02)', async () => {
      const shop = await createShop(t.app, await t.newUser());
      const p = (await createProduct(t.app, shop)).id;
      const res = await t
        .http()
        .get(`/api/products/${p}/recommendations`)
        .expect(200);
      expect(recommendationsResponseSchema.parse(res.body)).toEqual({
        type: 'bought-together',
        items: [],
      });
    });

    it('S34 AS-49: for the optional-section composition, 404 is a no-store problem body (composition owned by S48)', async () => {
      const res = await t
        .http()
        .get(`/api/products/${newId()}/recommendations`)
        .expect(404);
      problem(res.body);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    });
  });
});
