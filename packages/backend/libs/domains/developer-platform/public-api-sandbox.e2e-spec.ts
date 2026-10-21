import { ProductQueryService } from '@app/domains/catalog';
import {
  createKey,
  createPublicApiKit,
  newId,
  rows,
  type CreatedKey,
  type PublicApiKit,
  type ShopWorld,
} from './testing/public-api-kit';

const product = (over: Record<string, unknown> = {}) => ({
  title: 'Sandbox phone',
  price: { amount: 129_900, currency: 'USD' },
  stock: 5,
  category: 'phones',
  brand: 'Acme',
  ...over,
});

/** Runs the rounds of a repeated test five at a time (each round has a world of its own). */
const eachRound = async (
  rounds: number,
  body: (round: number) => Promise<void>,
  size = 5,
): Promise<void> => {
  for (let from = 0; from < rounds; from += size)
    await Promise.all(
      Array.from({ length: Math.min(size, rounds - from) }, (_, k) =>
        body(from + k),
      ),
    );
};

describe('Public API: sandbox', () => {
  let t: PublicApiKit;
  let pub2: Awaited<ReturnType<PublicApiKit['publicInstance']>>;

  beforeAll(async () => {
    t = await createPublicApiKit();
    pub2 = await t.publicInstance();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const world = async (): Promise<{
    w: ShopWorld;
    live: CreatedKey;
    test: CreatedKey;
  }> => {
    const w = await t.seedWorld();
    return {
      w,
      live: await createKey(t, w, { name: 'live', livemode: true }),
      test: await createKey(t, w, { name: 'test', livemode: false }),
    };
  };
  const post = (key: CreatedKey, body: object) =>
    t.pub
      .withKey(key.key)
      .post('/v1/products')
      .set('Idempotency-Key', newId())
      .send(body);

  it('S42 AS-22: live and sandbox data are invisible to each other, in both directions', async () => {
    const { live, test } = await world();
    const x = await post(test, product({ title: 'X' })).expect(201);
    expect(x.body.livemode).toBe(false);

    const testList = await t.pub
      .withKey(test.key)
      .get('/v1/products')
      .expect(200);
    expect(testList.body.data.map((p: { id: string }) => p.id)).toEqual([
      x.body.id,
    ]);
    expect(
      testList.body.data.every(
        (p: { livemode: boolean }) => p.livemode === false,
      ),
    ).toBe(true);
    const liveList = await t.pub
      .withKey(live.key)
      .get('/v1/products')
      .expect(200);
    expect(liveList.body.data).toEqual([]);
    await t.pub.withKey(live.key).get(`/v1/products/${x.body.id}`).expect(404);

    const y = await post(live, product({ title: 'Y' })).expect(201);
    expect(y.body.livemode).toBe(true);
    const after = await t.pub.withKey(test.key).get('/v1/products').expect(200);
    expect(after.body.data.map((p: { id: string }) => p.id)).toEqual([
      x.body.id,
    ]);
    await t.pub.withKey(test.key).get(`/v1/products/${y.body.id}`).expect(404);
  });

  it('S42 AS-22: a sandbox product is marked as such in the catalog and is never publicly visible', async () => {
    const { live, test } = await world();
    const x = await post(test, product()).expect(201);
    const y = await post(live, product()).expect(201);
    const [stored] = await rows<{ isSandbox: boolean }>(
      t.app,
      `SELECT "isSandbox" FROM "Product" WHERE id = :id`,
      { id: x.body.id },
    );
    expect(stored.isSandbox).toBe(true);
    const query = t.app.get(ProductQueryService);
    expect(await query.isPubliclyVisible(x.body.id)).toBe(false);
    expect(await query.isPubliclyVisible(y.body.id)).toBe(true);
  });

  it('S42 AS-23: 10 parallel first calls of a test key create exactly one sandbox shop, and all act on it (20 repeats)', async () => {
    await eachRound(20, async () => {
      const w = await t.seedWorld();
      const test = await createKey(t, w, { livemode: false });
      const instances = [t.pub, pub2];
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, n) =>
          instances[n % 2].withKey(test.key).get('/v1/products'),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      const sandboxes = await rows<{ id: string }>(
        t.app,
        `SELECT id FROM "Shop" WHERE "sandboxOf" = :id`,
        { id: w.shop.id },
      );
      expect(sandboxes).toHaveLength(1);
      const [members] = await rows<{ n: number }>(
        t.app,
        `SELECT count(*)::int AS n FROM "ShopMembership" WHERE "shopId" = :id`,
        { id: sandboxes[0].id },
      );
      expect(members.n).toBe(0);
      const [shop] = await rows<{ payoutsEnabled: boolean }>(
        t.app,
        `SELECT "payoutsEnabled" FROM "Shop" WHERE id = :id`,
        { id: sandboxes[0].id },
      );
      expect(shop.payoutsEnabled).toBe(false);
      const created = await post(test, product()).expect(201);
      const [owner] = await rows<{ shopId: string }>(
        t.app,
        `SELECT "shopId" FROM "Product" WHERE id = :id`,
        { id: created.body.id },
      );
      expect(owner.shopId).toBe(sandboxes[0].id);
    });
  });

  it('S42 AS-24: the sandbox has no orders: an empty list and 404 for any order', async () => {
    const { test } = await world();
    const list = await t.pub.withKey(test.key).get('/v1/orders').expect(200);
    expect(list.body).toEqual({
      object: 'list',
      data: [],
      has_more: false,
      next_cursor: null,
    });
    await t.pub.withKey(test.key).get(`/v1/orders/${newId()}`).expect(404);
  });

  it('S42 AS-25: the same prefix and secret under the other mode is 401, and a key never acts on the other shop', async () => {
    const { live, test } = await world();
    const [, , lp, ls] = live.key.split('_');
    const [, , tp, ts] = test.key.split('_');
    expect(
      (await t.pub.withKey(`sk_test_${lp}_${ls}`).get('/v1/products')).status,
    ).toBe(401);
    expect(
      (await t.pub.withKey(`sk_live_${tp}_${ts}`).get('/v1/products')).status,
    ).toBe(401);
    expect((await t.pub.withKey(live.key).get('/v1/products')).status).toBe(
      200,
    );
    expect((await t.pub.withKey(test.key).get('/v1/products')).status).toBe(
      200,
    );
  });
});
