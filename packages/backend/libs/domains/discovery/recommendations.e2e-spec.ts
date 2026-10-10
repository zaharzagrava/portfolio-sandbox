import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  createRecommendationsApp,
  seedDatasetD,
  type RecommendationsTestApp,
} from './testing/recommendations.fixtures';

/**
 * The journey end to end, kept at its old path: paid orders → baskets → nightly build → lists → endpoint. The detailed
 * scenarios live in `recommendations-{read,cold-start,baskets,build}.e2e-spec.ts`.
 */
describe('Bought together (e2e)', () => {
  let t: RecommendationsTestApp;

  beforeAll(async () => {
    t = await createRecommendationsApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.clean();
  });

  it('S34 AS-01 AS-13: cosine beats raw popularity; noise pairs and redelivered orders do not count; 2-hop fills cold products', async () => {
    const d = await seedDatasetD(t);
    const redelivered = { productIds: [d.M, d.C] };
    await t.deliverPaid(redelivered);
    await t.deliverPaid(redelivered); // the same order again: collapsed by the version guard

    const { edges } = await t.build({ buckets: 4 });
    expect(edges).toBeGreaterThan(0);

    const magsafe = (await t.storedList(d.M)).map(([m]) => m);
    expect(magsafe).not.toContain(d.S); // M-S has 2 co-orders, below the threshold
    expect(magsafe[0]).toBe(d.C); // 5+ co-orders with a niche item beat 6 with the hub

    // the stand has one direct edge (the cable): the rail borrows from the cable's neighbours
    const res = await t
      .http()
      .get(`/api/products/${d.S}/recommendations`)
      .expect(200);
    expect(res.body.items[0]).toMatchObject({ productId: d.K, hops: 1 });
    expect(
      res.body.items
        .slice(1)
        .map((r: { productId: string; hops: number }) => [r.productId, r.hops]),
    ).toContainEqual([d.P, 2]);
    expect(
      res.body.items.map((r: { productId: string }) => r.productId),
    ).not.toContain(d.S);
    expect(res.headers['cache-control']).toContain('s-maxage=300');
  });

  it('S34 AS-10: out-of-stock neighbours are hidden at read time', async () => {
    const shop = await createShop(t.app, await t.newUser());
    const a = await createProduct(t.app, shop, { title: 'A', quantity: 5 });
    const b = await createProduct(t.app, shop, { title: 'B', quantity: 0 });
    const c = await createProduct(t.app, shop, { title: 'C', quantity: 5 });
    await t.putList(a.id, [
      [b.id, 0.9],
      [c.id, 0.5],
    ]);

    const body = await t.rail(a.id);

    expect(body.items.map((i) => i.productId)).toEqual([c.id]);
    expect(body.items[0].title).toBe('C');
  });
});
