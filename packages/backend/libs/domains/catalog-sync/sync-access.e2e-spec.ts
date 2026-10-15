import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { syncPushResponseSchema } from '@marketplace-sandbox/contracts';
import {
  ProductCommandService,
  ProductQueryService,
} from '@app/domains/catalog';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import {
  TenancyFixture,
  type FixtureRole,
} from '@app/test/utils/s08-tenancy-fixture';
import {
  OfflineSyncModule,
  OfflineSyncProjectorModule,
  OfflineSyncWorkerModule,
} from './sync.module';
import { encodeHlc } from './domain/hlc';
import {
  ManualTimeSource,
  TimeSource,
} from '@app/infrastructure/rate-limit/time-source';

const SECOND = 1_000;
const limiterTime = new ManualTimeSource(Date.now());

describe('Offline sync: access, tenancy and limits', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let commands: ProductCommandService;
  let query: ProductQueryService;
  let logical = 0;

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [
        OfflineSyncModule,
        OfflineSyncWorkerModule,
        OfflineSyncProjectorModule,
      ],
      // The limiter reads the store's clock; this moves it by hand so a window can end without sleeping.
      overrides: [{ provide: TimeSource, useValue: limiterTime }],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    commands = ctx.app.get(ProductCommandService);
    query = ctx.app.get(ProductQueryService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  async function world() {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    return { owner, shopId: shop.id };
  }
  type World = { owner: TestUser; shopId: string };

  async function member(w: World, role: FixtureRole) {
    const user = await ctx.newUser();
    await tenancy.addMember(w.shopId, user.id, role);
    return user;
  }

  async function product(w: World, quantity = 10) {
    const created = await commands.create(w.shopId, w.owner.id, {
      title: 'Mug',
      brand: 'Acme',
      category: 'home',
      priceMinor: 1_000,
      quantity,
    });
    return created.id;
  }

  const quantityOf = async (w: World, productId: string) =>
    (await query.getProductsByIds([productId], { shopId: w.shopId })).get(
      productId,
    )!.quantity;

  const op = (
    productId: string,
    delta = 1,
    device = 'dev-a',
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'stock.adjust',
    opId: uuidv7(),
    hlc: encodeHlc({
      physical: ctx.clock.now().getTime(),
      logical: ++logical,
      node: device,
    }),
    productId,
    delta,
    reason: 'received',
    ...extra,
  });

  const push = (
    w: World,
    body: unknown,
    user: TestUser = w.owner,
    device: string | null = 'dev-a',
  ) => {
    const req = ctx.as(user).post(`/api/shops/${w.shopId}/sync/push`);
    return (device === null ? req : req.set('X-Device-Id', device)).send(
      body as object,
    );
  };
  const pull = (
    w: World,
    user: TestUser = w.owner,
    device: string | null = 'dev-a',
    query = '',
  ) => {
    const req = ctx.as(user).get(`/api/shops/${w.shopId}/sync/pull${query}`);
    return device === null ? req : req.set('X-Device-Id', device);
  };
  const operationRows = (shopId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "SyncOperation" WHERE "shopId" = :shopId ORDER BY "createdAt"`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );

  /** An oversold conflict to dismiss. */
  async function conflict(w: World): Promise<string> {
    const productId = await product(w, 0);
    const sale = op(productId, -1);
    const res = await push(w, { ops: [sale] });
    expect(syncPushResponseSchema.parse(res.body).results[0].status).toBe(
      'conflict',
    );
    return sale.opId;
  }

  const stable = (body: Record<string, unknown>) => {
    const { requestId, instance, traceId, ...rest } = body;
    void requestId;
    void instance;
    void traceId;
    return rest;
  };

  // ---- AS-35 --------------------------------------------------------------------------------------------------

  it('S09 AS-35: every envelope error is 400 validation_failed and applies nothing', async () => {
    const w = await world();
    const productId = await product(w);
    const good = op(productId);
    const cases: Array<[string, () => Promise<{ status: number; body: any }>]> =
      [
        ['no device header', () => push(w, { ops: [good] }, w.owner, null)],
        [
          'a device id of 3 characters',
          () => push(w, { ops: [good] }, w.owner, 'abc'),
        ],
        [
          'a device id of 65 characters',
          () => push(w, { ops: [good] }, w.owner, 'a'.repeat(65)),
        ],
        [
          'a device id with a space',
          () => push(w, { ops: [good] }, w.owner, 'dev a'),
        ],
        [
          'a device id with a dot',
          () => push(w, { ops: [good] }, w.owner, 'dev.a'),
        ],
        ['no ops', () => push(w, {})],
        ['ops that is not an array', () => push(w, { ops: 'x' })],
        ['ops as an object', () => push(w, { ops: { a: 1 } })],
        ['an empty ops array', () => push(w, { ops: [] })],
        [
          '501 operations',
          () =>
            push(w, { ops: Array.from({ length: 501 }, () => op(productId)) }),
        ],
        [
          'an unknown top-level field',
          () => push(w, { ops: [good], note: 'x' }),
        ],
        ['a body that is not an object', () => push(w, [good])],
      ];
    for (const [name, send] of cases) {
      const res = await send();
      expect([name, res.status, res.body.code]).toEqual([
        name,
        400,
        'validation_failed',
      ]);
    }
    expect(await operationRows(w.shopId)).toHaveLength(0);
    expect(await quantityOf(w, productId)).toBe(10);

    // 500 operations are accepted (and malformed ones are answered one by one, not as a request error)
    const full = await push(w, {
      ops: Array.from({ length: 500 }, () => ({ type: 'x' })),
    });
    expect(full.status).toBe(200);
    expect(
      syncPushResponseSchema
        .parse(full.body)
        .results.every((r) => r.code === 'invalid_op'),
    ).toBe(true);
  });

  it('S09 AS-35: a body over 2 MiB is 413 payload_too_large and applies nothing', async () => {
    const w = await world();
    const productId = await product(w);

    const big = await push(w, {
      ops: [op(productId)],
      pad: 'x'.repeat(2 * 1024 * 1024 + 1024),
    });

    expect([big.status, big.body.code]).toEqual([413, 'payload_too_large']);
    // 1.5 MiB passes the size check (and is then an unknown field)
    const medium = await push(w, {
      ops: [op(productId)],
      pad: 'x'.repeat(1_500_000),
    });
    expect([medium.status, medium.body.code]).toEqual([
      400,
      'validation_failed',
    ]);
    expect(await operationRows(w.shopId)).toHaveLength(0);
    expect(await quantityOf(w, productId)).toBe(10);
  });

  // ---- AS-36 --------------------------------------------------------------------------------------------------

  it('S09 AS-36: a device over its push budget gets 429 with Retry-After, nothing is applied, and the batch applies once after the window', async () => {
    const w = await world();
    const productId = await product(w);
    for (let i = 0; i < 30; i++)
      expect((await push(w, { ops: [op(productId)] })).status).toBe(200);
    expect(await quantityOf(w, productId)).toBe(40);

    const batch = { ops: [op(productId, 7)] };
    const limited = await push(w, batch);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body.code).toBe('rate_limited');
    expect(await quantityOf(w, productId)).toBe(40);
    expect(await operationRows(w.shopId)).toHaveLength(30);

    // another device of the same shop has its own budget
    expect(
      (await push(w, { ops: [op(productId, 1, 'dev-b')] }, w.owner, 'dev-b'))
        .status,
    ).toBe(200);

    ctx.clock.advance(61 * SECOND);
    limiterTime.advance(61 * SECOND);
    await ctx.reauth(w.owner);
    const after = await push(w, batch);
    expect(after.status).toBe(200);
    expect(syncPushResponseSchema.parse(after.body).results[0]).toMatchObject({
      status: 'applied',
      replayed: false,
    });
    expect(await quantityOf(w, productId)).toBe(48);
  }, 120_000);

  it('S09 AS-36: a device over its pull budget gets 429 with Retry-After and pulls again after the window', async () => {
    const w = await world();
    for (let i = 0; i < 120; i++) expect((await pull(w)).status).toBe(200);

    const limited = await pull(w);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body.changes).toBeUndefined();

    ctx.clock.advance(61 * SECOND);
    limiterTime.advance(61 * SECOND);
    await ctx.reauth(w.owner);
    expect((await pull(w)).status).toBe(200);
  }, 120_000);

  // ---- AS-42 --------------------------------------------------------------------------------------------------

  it('S09 AS-42: all four routes need a session, with no credentials or an expired token', async () => {
    const w = await world();
    const productId = await product(w);
    const opId = await conflict(w);
    const base = `/api/shops/${w.shopId}/sync`;
    const routes = (
      agent: () => ReturnType<CatalogTestApp['http']>,
      auth: Record<string, string>,
    ) => [
      agent()
        .post(`${base}/push`)
        .set(auth)
        .set('X-Device-Id', 'dev-a')
        .send({ ops: [op(productId)] }),
      agent().get(`${base}/pull`).set(auth).set('X-Device-Id', 'dev-a'),
      agent().get(`${base}/conflicts`).set(auth),
      agent().post(`${base}/conflicts/${opId}/dismiss`).set(auth),
    ];

    for (const res of await Promise.all(routes(() => ctx.http(), {}))) {
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.code).toEqual(expect.any(String));
    }

    const stale = w.owner.bearer;
    ctx.clock.advance(60 * 60 * SECOND);
    for (const res of await Promise.all(
      routes(() => ctx.http(), { Authorization: stale }),
    ))
      expect(res.status).toBe(401);

    expect(await quantityOf(w, productId)).toBe(10);
    expect(await operationRows(w.shopId)).toHaveLength(1); // only the conflict's own operation
    // signing in again is all the device needs; its queue is untouched
    await ctx.reauth(w.owner);
    expect((await push(w, { ops: [op(productId)] })).status).toBe(200);
  });

  // ---- AS-43 --------------------------------------------------------------------------------------------------

  it.each([
    ['OWNER', true],
    ['ADMIN', true],
    ['STAFF', true],
    ['VIEWER', false],
  ] as const)(
    'S09 AS-43: %s on the four routes (writes allowed: %s)',
    async (role, canWrite) => {
      const w = await world();
      const productId = await product(w);
      const opId = await conflict(w);
      const user = role === 'OWNER' ? w.owner : await member(w, role);
      const before = await quantityOf(w, productId);

      const pushed = await push(w, { ops: [op(productId)] }, user);
      const pulled = await pull(w, user);
      const listed = await ctx
        .as(user)
        .get(`/api/shops/${w.shopId}/sync/conflicts`);
      const dismissed = await ctx
        .as(user)
        .post(`/api/shops/${w.shopId}/sync/conflicts/${opId}/dismiss`);

      expect(pulled.status).toBe(200);
      expect(listed.status).toBe(200);
      if (canWrite) {
        expect(pushed.status).toBe(200);
        expect(dismissed.status).toBe(200);
        expect(await quantityOf(w, productId)).toBe(before + 1);
      } else {
        expect([pushed.status, pushed.body.code]).toEqual([
          403,
          'permission_denied',
        ]);
        expect([dismissed.status, dismissed.body.code]).toEqual([
          403,
          'permission_denied',
        ]);
        expect(await quantityOf(w, productId)).toBe(before);
        expect(await operationRows(w.shopId)).toHaveLength(1);
      }
    },
  );

  // ---- AS-44 --------------------------------------------------------------------------------------------------

  it('S09 AS-44: a member of one shop gets the 404 of a missing shop on every route of another, and sees none of its data', async () => {
    const a = await world();
    const b = await world();
    const productB = await product(b);
    const conflictB = await conflict(b);
    const missing = randomUUID();
    const send = (shopId: string) => {
      const base = `/api/shops/${shopId}/sync`;
      const as = ctx.as(a.owner);
      return Promise.all([
        as
          .post(`${base}/push`)
          .set('X-Device-Id', 'dev-a')
          .send({ ops: [op(productB)] }),
        as.get(`${base}/pull`).set('X-Device-Id', 'dev-a'),
        as.get(`${base}/conflicts`),
        as.post(`${base}/conflicts/${conflictB}/dismiss`),
      ]);
    };

    const foreign = await send(b.shopId);
    const absent = await send(missing);

    foreign.forEach((res, i) => {
      expect(res.status).toBe(404);
      expect(stable(res.body)).toEqual(stable(absent[i].body));
    });
    expect(await quantityOf(b, productB)).toBe(10);
    expect(await operationRows(b.shopId)).toHaveLength(1);

    // A's own pull never carries an entry of B, even though B has products and a feed.
    await product(a);
    const own = await pull(a);
    expect(own.status).toBe(200);
    expect(own.body.changes.map((c: { id: string }) => c.id)).not.toContain(
      productB,
    );
  });

  // ---- AS-45 --------------------------------------------------------------------------------------------------

  it('S09 AS-45: a member removed while offline cannot push', async () => {
    const w = await world();
    const productId = await product(w);
    const staff = await member(w, 'STAFF');
    expect((await push(w, { ops: [op(productId)] }, staff)).status).toBe(200);
    const queued = { ops: [op(productId, 5)] };

    const removed = await ctx
      .as(w.owner)
      .delete(`/api/shops/${w.shopId}/members/${staff.id}`);
    expect(removed.status).toBe(204);
    const refused = await push(w, queued, staff);

    expect([refused.status, refused.body.code]).toEqual([
      404,
      'shop_not_found',
    ]);
    expect(await quantityOf(w, productId)).toBe(11);
    expect(await operationRows(w.shopId)).toHaveLength(1);
  });

  // ---- AS-46 --------------------------------------------------------------------------------------------------

  it('S09 AS-46: a suspended shop refuses with shop_suspended and an offboarding one with shop_offboarding, on every route', async () => {
    for (const [status, code, http] of [
      ['SUSPENDED', 'shop_suspended', 403],
      ['DELETING', 'shop_offboarding', 409],
    ] as const) {
      const w = await world();
      const productId = await product(w);
      const opId = await conflict(w);
      await tenancy.setShopStatus(w.shopId, status);
      // A member who has not asked yet: the answer comes from the shop's current status, not from a cached one.
      const staff = await member(w, 'STAFF');
      const base = `/api/shops/${w.shopId}/sync`;
      const as = ctx.as(staff);

      const responses = await Promise.all([
        push(w, { ops: [op(productId)] }, staff),
        pull(w, staff),
        as.get(`${base}/conflicts`),
        as.post(`${base}/conflicts/${opId}/dismiss`),
      ]);

      for (const res of responses)
        expect([status, res.status, res.body.code]).toEqual([
          status,
          http,
          code,
        ]);
      expect(await quantityOf(w, productId)).toBe(10);
    }
  });

  // ---- AS-47 --------------------------------------------------------------------------------------------------

  it('S09 AS-47: shop, user and device come from the path, the session and the header, never from the body', async () => {
    const w = await world();
    const other = await world();
    const productId = await product(w);

    const smuggled = await push(w, {
      ops: [
        op(productId, 1, 'dev-a', { shopId: other.shopId }),
        op(productId, 1, 'dev-a', { userId: randomUUID() }),
        op(productId, 1, 'dev-a', { deviceId: 'dev-evil' }),
      ],
    });
    expect(smuggled.status).toBe(200);
    const results = syncPushResponseSchema.parse(smuggled.body).results;
    expect(
      results.every((r) => r.status === 'rejected' && r.code === 'invalid_op'),
    ).toBe(true);
    expect(JSON.stringify(results.map((r) => r.detail))).toMatch(
      /shopId[\s\S]*userId[\s\S]*deviceId/,
    );
    expect(
      (await push(w, { ops: [op(productId)], shopId: other.shopId })).status,
    ).toBe(400);
    expect(await operationRows(w.shopId)).toHaveLength(0);
    expect(await operationRows(other.shopId)).toHaveLength(0);

    const accepted = op(productId, 3, 'dev-phone');
    expect(
      (await push(w, { ops: [accepted] }, w.owner, 'dev-phone')).status,
    ).toBe(200);
    const [stored] = await operationRows(w.shopId);
    expect(stored).toMatchObject({
      shopId: w.shopId,
      userId: w.owner.id,
      deviceId: 'dev-phone',
      opId: accepted.opId,
    });
  });
});
