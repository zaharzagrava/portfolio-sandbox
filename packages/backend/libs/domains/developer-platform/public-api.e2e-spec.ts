import {
  createKey,
  createPublicApiKit,
  newId,
  type CreatedKey,
  type PublicApiKit,
  type ShopWorld,
} from './testing/public-api-kit';

const OLD_VERSION = '2026-01-15';

const product = (over: Record<string, unknown> = {}) => ({
  title: 'Walkthrough phone',
  price: { amount: 129_900, currency: 'USD' },
  stock: 5,
  category: 'phones',
  brand: 'Acme',
  ...over,
});

/**
 * One walk through the whole public surface with real Postgres and Redis, through HTTP (no global prefix, like
 * apps/public-api). The depth for each rule lives in the sibling `public-api-*.e2e-spec.ts` files; this file keeps
 * the journey of an integrator together so a wiring break between the parts fails here.
 */
describe('Public API (e2e walkthrough)', () => {
  let t: PublicApiKit;

  beforeAll(async () => {
    t = await createPublicApiKit();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const world = async (
    scopes?: string[],
  ): Promise<{ w: ShopWorld; key: CreatedKey }> => {
    const w = await t.seedWorld();
    return { w, key: await createKey(t, w, scopes ? { scopes } : {}) };
  };
  const create = (key: CreatedKey, body: object, idem: string = newId()) =>
    t.pub
      .withKey(key.key)
      .post('/v1/products')
      .set('Idempotency-Key', idem)
      .send(body);

  it("S42 AS-16: the tenant comes from the key: another shop's product is a 404 and a revoked key stops working immediately", async () => {
    const a = await world();
    const b = await world();
    const mine = await create(a.key, product()).expect(201);
    expect(mine.body.livemode).toBe(true);

    await t.pub
      .withKey(a.key.key)
      .get(`/v1/products/${mine.body.id}`)
      .expect(200);
    await t.pub
      .withKey(b.key.key)
      .get(`/v1/products/${mine.body.id}`)
      .expect(404);
    const theirs = await t.pub
      .withKey(b.key.key)
      .get('/v1/products')
      .expect(200);
    expect(theirs.body.data).toEqual([]);

    await t
      .as(a.w.ownerMfa)
      .delete(`/api/shops/${a.w.shop.id}/developers/keys/${a.key.id}`)
      .expect(204);
    await t.pub.withKey(a.key.key).get('/v1/products').expect(401);
    expect((await t.pub.withKey(b.key.key).get('/v1/products')).status).toBe(
      200,
    );
  });

  it('S42 AS-13: a missing, a malformed and an unknown key get the same refusal', async () => {
    const { key } = await world();
    const missing = await t.pub.http().get('/v1/products');
    const malformed = await t.pub
      .http()
      .get('/v1/products')
      .set('Authorization', 'Bearer not-a-key');
    const unknown = await t.pub
      .http()
      .get('/v1/products')
      .set('Authorization', `Bearer ${key.key.slice(0, -4)}aaaa`);
    for (const res of [missing, malformed, unknown]) {
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
      expect({ ...res.body, requestId: undefined }).toEqual({
        ...missing.body,
        requestId: undefined,
      });
    }
  });

  it('S42 AS-15: scopes are enforced per endpoint', async () => {
    const { key } = await world(['products:read']);
    await t.pub.withKey(key.key).get('/v1/products').expect(200);
    await create(key, product()).expect(403);
    await t.pub.withKey(key.key).get('/v1/orders').expect(403);
    await t.pub
      .withKey(key.key)
      .post('/v1/stock/bulk')
      .set('Idempotency-Key', newId())
      .send({ items: [] })
      .expect(403);
  });

  it("S42 AS-28: date versions: the latest shape by default, the older one by header; the header never moves the shop's pin", async () => {
    const { key } = await world();
    const made = await create(key, product()).expect(201);
    const latest = await t.pub
      .withKey(key.key)
      .get(`/v1/products/${made.body.id}`)
      .expect(200);
    const old = await t.pub
      .withKey(key.key)
      .get(`/v1/products/${made.body.id}`)
      .set('Marketplace-Version', OLD_VERSION)
      .expect(200);
    expect(old.headers['marketplace-version']).toBe(OLD_VERSION);
    expect(latest.headers['marketplace-version']).not.toBe(OLD_VERSION);
    expect(old.body).not.toEqual(latest.body);

    const again = await t.pub
      .withKey(key.key)
      .get(`/v1/products/${made.body.id}`)
      .expect(200);
    expect(again.body).toEqual(latest.body);
    expect(again.headers['marketplace-version']).toBe(
      latest.headers['marketplace-version'],
    );
  });

  it('S42 AS-32: a deprecated route announces Deprecation, Sunset and the successor; its replacement does not', async () => {
    const { key } = await world();
    const made = await create(key, product()).expect(201);
    const old = await t.pub
      .withKey(key.key)
      .get(`/v1/products/${made.body.id}/stock`)
      .expect(200);
    expect(old.headers.deprecation).toBeDefined();
    expect(old.headers.sunset).toBeDefined();
    expect(old.headers.link).toContain('rel="successor-version"');

    const next = await t.pub
      .withKey(key.key)
      .get(`/v1/stock/${made.body.id}`)
      .expect(200);
    expect(next.headers.deprecation).toBeUndefined();
    expect(next.headers.sunset).toBeUndefined();
  });

  it('S42 AS-53: Idempotency-Key: a retry replays the first response; the same key with another body is rejected', async () => {
    const { key } = await world();
    const idem = newId();
    const first = await create(key, product(), idem).expect(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const retry = await create(key, product(), idem).expect(201);
    expect(retry.headers['idempotent-replayed']).toBeDefined();
    expect(retry.body.id).toBe(first.body.id);

    const other = await create(key, product({ title: 'Another' }), idem);
    expect(other.status).toBe(422);

    const list = await t.pub.withKey(key.key).get('/v1/products').expect(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('S42 AS-22: a test key acts on an isolated sandbox shop and the live shop never sees it', async () => {
    const w = await t.seedWorld();
    const live = await createKey(t, w, { livemode: true });
    const test = await createKey(t, w, { livemode: false });
    const sandbox = await create(test, product({ title: 'Sandbox' })).expect(
      201,
    );
    expect(sandbox.body.livemode).toBe(false);

    const liveList = await t.pub
      .withKey(live.key)
      .get('/v1/products')
      .expect(200);
    expect(liveList.body.data).toEqual([]);
    await t.pub
      .withKey(live.key)
      .get(`/v1/products/${sandbox.body.id}`)
      .expect(404);
    const testList = await t.pub
      .withKey(test.key)
      .get('/v1/products')
      .expect(200);
    expect(testList.body.data.map((p: { id: string }) => p.id)).toEqual([
      sandbox.body.id,
    ]);
  });

  it("S42 AS-37: cursor pagination is stable; S42 AS-50: bulk stock applies synchronously, only for the key's own products", async () => {
    const a = await world();
    const b = await world();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        (await create(a.key, product({ title: `P${i}` })).expect(201)).body.id,
      );
    }
    const foreign = (await create(b.key, product()).expect(201)).body.id;

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const res = await t.pub
        .withKey(a.key.key)
        .get('/v1/products')
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .expect(200);
      seen.push(...res.body.data.map((p: { id: string }) => p.id));
      if (!res.body.has_more) break;
      cursor = res.body.next_cursor;
      expect(cursor).toBeTruthy();
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);

    const bulk = await t.pub
      .withKey(a.key.key)
      .post('/v1/stock/bulk')
      .set('Idempotency-Key', newId())
      .send({
        items: [
          { operationId: 'o1', productId: ids[0], delta: -2 },
          { operationId: 'o2', productId: foreign, delta: 1 },
        ],
      })
      .expect(200);
    const byOp = Object.fromEntries(
      bulk.body.results.map((r: { operation_id: string }) => [
        r.operation_id,
        r,
      ]),
    );
    expect(byOp.o1.outcome).toBe('applied');
    expect(byOp.o1.stock_after).toBe(3);
    expect(byOp.o2.outcome).toBe('not_found');
  });
});
