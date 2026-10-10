import { createProduct } from '@app/test/utils/catalog-fixtures';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  countRedisCommands,
  createRecommendationsApp,
  seedDatasetD,
  type RecommendationsTestApp,
} from './testing/recommendations.fixtures';
import { boughtTogetherKey } from './infra/recommendation-keys';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('Bought-together 2-hop cold start', () => {
  let t: RecommendationsTestApp;

  beforeAll(async () => {
    t = await createRecommendationsApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.clean();
  });

  const world = async () => {
    const owner = await t.newUser();
    return createShop(t.app, owner);
  };
  const products = async (shop: { id: string }, count: number, from = 1) =>
    Promise.all(
      Array.from({ length: count }, (_, i) =>
        createProduct(t.app, shop, { id: id(from + i) }).then((p) => p.id),
      ),
    );

  it('S34 AS-13: the cold product S gets its one direct neighbour and the neighbour of its neighbour, marked indirect', async () => {
    const d = await seedDatasetD(t);
    await t.build();

    const body = await t.rail(d.S);

    expect(body.items).toEqual([
      expect.objectContaining({ productId: d.K, score: 0.2046, hops: 1 }),
      expect.objectContaining({ productId: d.P, score: 0.0673, hops: 2 }),
    ]);
    expect(body.items.map((i) => i.productId)).not.toContain(d.S);
  });

  it('S34 AS-14: the hub P is filled by expansion, and M and C reached through each other stay direct', async () => {
    const d = await seedDatasetD(t);
    await t.build();

    const body = await t.rail(d.P);

    expect(body.items.map((i) => [i.productId, i.score, i.hops])).toEqual([
      [d.K, 0.6578, 1],
      [d.C, 0.643, 1],
      [d.M, 0.1794, 1],
      [d.S, 0.0673, 2],
    ]);
  });

  it('S34 AS-15: expansion reads the lists of the top 5 seeds in full in one batch, not the 6th and 7th, and takes no third hop', async () => {
    const shop = await world();
    const x = id(1000);
    await createProduct(t.app, shop, { id: x });
    const n = await products(shop, 7);
    const hop2 = await products(shop, 2, 100);
    await t.putList(
      x,
      n.map((m, i) => [m, 0.9 - i * 0.1] as [string, number]),
    );
    await t.putList(n[0], [[hop2[0], 0.8]]);
    await t.putList(hop2[0], [[hop2[1], 0.9]]); // a third hop that must not be taken
    const counter = countRedisCommands();
    try {
      const body = await t.rail(x, { limit: '20' });

      expect(counter.reads).toEqual([
        boughtTogetherKey(x),
        ...n.slice(0, 5).map(boughtTogetherKey),
      ]);
      // the client auto-pipelines: the product's own list is one round trip, the five seeds share the next one
      expect(counter.trips.batches).toEqual([1, 5]);
      expect(body.items.map((i) => i.productId)).toEqual([...n, hop2[0]]);
      expect(body.items.map((i) => i.productId)).not.toContain(hop2[1]);
    } finally {
      counter.stop();
    }
  });

  it('S34 AS-16: no expansion when the direct list already fills the rail: one list read', async () => {
    const shop = await world();
    const x = id(1000);
    await createProduct(t.app, shop, { id: x });
    const n = await products(shop, 8);
    await t.putList(
      x,
      n.map((m, i) => [m, 0.9 - i * 0.05] as [string, number]),
    );
    await t.putList(n[0], [[x, 0.5]]);
    const counter = countRedisCommands();
    try {
      const body = await t.rail(x);

      expect(body.items.every((i) => i.hops === 1)).toBe(true);
      expect(counter.reads).toEqual([boughtTogetherKey(x)]);
      expect(counter.trips.batches).toEqual([1]);
    } finally {
      counter.stop();
    }
  });

  it('S34 AS-19: a neighbour that is out of stock is not shown but still bridges to its own neighbours', async () => {
    const shop = await world();
    const [x, y, w] = [id(1), id(2), id(3)];
    await createProduct(t.app, shop, { id: x });
    await createProduct(t.app, shop, { id: y, quantity: 0 });
    await createProduct(t.app, shop, { id: w, title: 'W' });
    await t.putList(x, [[y, 0.9]]);
    await t.putList(y, [
      [w, 0.8],
      [x, 0.9],
    ]);

    const body = await t.rail(x);

    expect(body.items).toEqual([
      expect.objectContaining({ productId: w, score: 0.36, hops: 2 }),
    ]);
  });

  it('S34 AS-20: a visible product with no list is an empty rail after one list read', async () => {
    const shop = await world();
    const [x] = await products(shop, 1);
    const counter = countRedisCommands();
    try {
      const body = await t.rail(x);

      expect(body).toEqual({ type: 'bought-together', items: [] });
      expect(counter.reads).toEqual([boughtTogetherKey(x)]);
    } finally {
      counter.stop();
    }
  });
});
