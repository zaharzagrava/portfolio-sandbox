import { createHmac, randomUUID } from 'node:crypto';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { cartSchema } from '@marketplace-sandbox/contracts';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { recordStatements } from '@app/test/utils/catalog-fixtures';
import { issueGuestToken } from './domain/guest-cart-token';
import { CART_STORE, type CartStore } from './domain/ports';
import { DynamoCartStore } from './infra/cart.dynamo-store';
import {
  createOrdersApp,
  KIT_CART_COOKIE_SECRET,
  type OrdersTestApp,
} from './testing/orders-app';

const DAY_MS = 86_400_000;
const ORDERS_TABLES =
  /"(BisOrder|BisOrderItem|ShopOrder|StockReservation|OrderEvent|Product|ProcessedWebhookEvent)"/;

describe('Cart: guest, signed-in, merge and limits', () => {
  let t: OrdersTestApp;
  let dynamo: DynamoService;

  beforeAll(async () => {
    t = await createOrdersApp();
    dynamo = t.app.get(DynamoService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const uuid = () => randomUUID();
  const body = (res: { body: unknown }) => cartSchema.parse(res.body);
  const setCookies = (res: { headers: Record<string, unknown> }): string[] =>
    (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const cookieValue = (res: { headers: Record<string, unknown> }): string => {
    const raw = setCookies(res).find((c) => c.startsWith('cart='));
    return raw!.split(';')[0].slice('cart='.length);
  };
  const guestPut = (productId: string, quantity: number, cookie?: string) =>
    t
      .http()
      .put(`/api/cart/items/${productId}`)
      .set('Cookie', cookie !== undefined ? [`cart=${cookie}`] : [])
      .send({ quantity });
  const userPut = (
    user: Parameters<OrdersTestApp['as']>[0],
    productId: string,
    quantity: number,
    cookie?: string,
  ) => {
    const req = t.as(user).put(`/api/cart/items/${productId}`);
    return (
      cookie !== undefined ? req.set('Cookie', [`cart=${cookie}`]) : req
    ).send({ quantity });
  };
  const userMerge = (
    user: Parameters<OrdersTestApp['as']>[0],
    cookie?: string,
  ) => {
    const req = t.as(user).post('/api/cart/merge');
    return cookie !== undefined ? req.set('Cookie', [`cart=${cookie}`]) : req;
  };
  const userGet = (user: Parameters<OrdersTestApp['as']>[0]) =>
    t.as(user).get('/api/cart');

  const stored = async (cartId: string) =>
    (
      (
        await dynamo.doc.send(
          new QueryCommand({
            TableName: dynamo.table('Carts'),
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': `CART#${cartId}` },
            ConsistentRead: true,
          }),
        )
      ).Items ?? []
    ).filter((i) => i.SK !== 'META');
  const cartIds = async () => [
    ...new Set(
      (
        (
          await dynamo.doc.send(
            new ScanCommand({
              TableName: dynamo.table('Carts'),
              ConsistentRead: true,
            }),
          )
        ).Items ?? []
      ).map((i) => String(i.PK).slice('CART#'.length)),
    ),
  ];
  const byProduct = (res: { body: unknown }) =>
    Object.fromEntries(body(res).lines.map((l) => [l.productId, l.quantity]));

  describe('guest cart (AS-01, AS-02, AS-03)', () => {
    it('S10 AS-01: an empty GET sets no cookie; the first PUT issues the signed cookie; the cart store holds one guest cart and no relational row is touched', async () => {
      const product = uuid();
      const first = await t.http().get('/api/cart');
      expect(first.status).toBe(200);
      expect(body(first)).toEqual({ lines: [], droppedLines: 0 });
      expect(setCookies(first)).toEqual([]);

      const { result: put, statements } = await recordStatements(
        t.app,
        () => guestPut(product, 2),
        ORDERS_TABLES,
      );
      expect(put.status).toBe(200);
      const cart = body(put);
      expect(cart.lines).toEqual([
        { productId: product, quantity: 2, addedAt: expect.any(String) },
      ]);
      expect(statements).toEqual([]);

      const cookies = setCookies(put);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(/^cart=guest:[0-9a-f-]{36}\.[A-Za-z0-9_-]+;/);
      for (const attribute of [
        'HttpOnly',
        'SameSite=Lax',
        'Path=/',
        'Max-Age=2592000',
        'Secure',
      ])
        expect(cookies[0]).toContain(attribute); // Secure: the test environment is not "local"

      const again = await t
        .http()
        .get('/api/cart')
        .set('Cookie', [`cart=${cookieValue(put)}`]);
      expect(body(again).lines).toEqual(cart.lines);
      const ids = await cartIds();
      expect(ids).toHaveLength(1);
      expect(ids[0]).toMatch(/^guest:[0-9a-f-]{36}$/);
    });

    it('S10 AS-02: a signed-in caller writes to their own cart; the guest cart and cookie stay; another user sees nothing; no route takes a cart id', async () => {
      const [u, v] = [await t.newUser(), await t.newUser()];
      const guest = issueGuestToken(KIT_CART_COOKIE_SECRET);
      const p = uuid();
      const put = await userPut(u, p, 5, guest.token);
      expect(put.status).toBe(200);
      expect(byProduct(put)).toEqual({ [p]: 5 });
      expect(setCookies(put)).toEqual([]);
      expect(await stored(guest.cartId)).toEqual([]);
      expect((await stored(`user:${u.id}`)).map((i) => i.productId)).toEqual([
        p,
      ]);
      expect(body(await userGet(v)).lines).toEqual([]);
      expect((await t.http().get(`/api/cart/${guest.cartId}`)).status).toBe(
        404,
      );
    });

    it('S10 AS-03: PUT sets rather than adds, keeps addedAt, 0 removes, and every validation class is 400 with nothing changed', async () => {
      const p = uuid();
      const first = await guestPut(p, 2);
      const cookie = cookieValue(first);
      const addedAt = body(first).lines[0].addedAt;
      t.clock.set(new Date(t.clock.now().getTime() + 60_000));
      const second = await guestPut(p, 5, cookie);
      expect(body(second).lines).toEqual([
        { productId: p, quantity: 5, addedAt },
      ]);

      for (const bad of [
        { quantity: 21 },
        { quantity: -1 },
        { quantity: 1.5 },
        {},
        { quantity: 1, extra: 1 },
      ]) {
        const res = await t
          .http()
          .put(`/api/cart/items/${p}`)
          .set('Cookie', [`cart=${cookie}`])
          .send(bad);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      }
      const badId = await t
        .http()
        .put('/api/cart/items/not-a-uuid')
        .set('Cookie', [`cart=${cookie}`])
        .send({ quantity: 1 });
      expect(badId.status).toBe(400);
      expect(
        byProduct(
          await t
            .http()
            .get('/api/cart')
            .set('Cookie', [`cart=${cookie}`]),
        ),
      ).toEqual({ [p]: 5 });

      const removed = await guestPut(p, 0, cookie);
      expect(removed.status).toBe(200);
      expect(body(removed).lines).toEqual([]);
      expect(
        await stored(`guest:${cookie.split('.')[0].slice('guest:'.length)}`),
      ).toEqual([]);
    });

    it('S10 AS-03: a 51st distinct product is 422 cart_line_limit and leaves the cart as it was; an existing line is still writable', async () => {
      const first = await guestPut(uuid(), 1);
      const cookie = cookieValue(first);
      const ids = [body(first).lines[0].productId];
      for (let i = 1; i < 50; i++) {
        const id = uuid();
        ids.push(id);
        expect((await guestPut(id, 1, cookie)).status).toBe(200);
      }
      const over = await guestPut(uuid(), 1, cookie);
      expect(over.status).toBe(422);
      expect(over.body.code).toBe('cart_line_limit');
      const cart = body(
        await t
          .http()
          .get('/api/cart')
          .set('Cookie', [`cart=${cookie}`]),
      );
      expect(cart.lines).toHaveLength(50);
      const update = await guestPut(ids[7], 9, cookie);
      expect(update.status).toBe(200);
      expect(byProduct(update)[ids[7]]).toBe(9);
    });
  });

  describe('forged and tampered cookies (AS-04)', () => {
    it('S10 AS-04: five bad cookies are "no cart" on GET, PUT and merge; the claimed id is never looked up and the claimed cart is untouched', async () => {
      const victim = await t.newUser();
      const victimLine = uuid();
      await userPut(victim, victimLine, 3);
      const good = issueGuestToken(KIT_CART_COOKIE_SECRET).token;
      const flipped = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
      const claimed = `user:${victim.id}`;
      const forgedUser = `${claimed}.${createHmac('sha256', 'another-secret-another-secret-12345678').update(claimed).digest('base64url')}`;
      const forgedVictim = `user:${victim.id}.AAAA`;
      const bad = [
        flipped,
        good.replace('.', ''),
        forgedUser,
        forgedVictim,
        '',
        'x'.repeat(4096),
      ];

      const lookedUp: string[] = [];
      t.patch(
        t.app.get<CartStore>(CART_STORE),
        'list',
        (original) =>
          (async (cartId: string, now: Date) => {
            lookedUp.push(cartId);
            return original(cartId, now);
          }) as never,
      );

      const user = await t.newUser();
      for (const cookie of bad) {
        const get = await t
          .http()
          .get('/api/cart')
          .set('Cookie', [`cart=${cookie}`]);
        expect(get.status).toBe(200);
        expect(body(get).lines).toEqual([]);
        expect(setCookies(get)).toEqual([]);

        const put = await guestPut(uuid(), 1, cookie);
        expect(put.status).toBe(200);
        expect(setCookies(put).some((c) => c.startsWith('cart=guest:'))).toBe(
          true,
        );

        const merge = await userMerge(user, cookie);
        expect(merge.status).toBe(200);
        expect(body(merge).lines).toEqual([]);
        expect({
          cookie: cookie.slice(0, 24),
          cleared: setCookies(merge).join(';'),
        }).toEqual({
          cookie: cookie.slice(0, 24),
          cleared: expect.stringMatching(/cart=;/),
        });
      }
      expect(lookedUp.filter((id) => id.includes(victim.id))).toEqual([]);
      expect(byProduct(await userGet(victim))).toEqual({ [victimLine]: 3 });
    });
  });

  describe('merge (AS-05 to AS-08)', () => {
    /** User cart {A:1, B:19} and a guest cart {A:3, B:5, C:2} with its cookie. */
    const world = async () => {
      const user = await t.newUser();
      const [a, b, c] = [uuid(), uuid(), uuid()];
      await userPut(user, a, 1);
      await userPut(user, b, 19);
      const g1 = await guestPut(a, 3);
      const cookie = cookieValue(g1);
      await guestPut(b, 5, cookie);
      await guestPut(c, 2, cookie);
      return { user, a, b, c, cookie, guestId: cookie.split('.')[0] };
    };

    it('S10 AS-05: the guest quantities are added, capped at 20, the guest cart is gone and the cookie is cleared', async () => {
      const w = await world();
      const res = await userMerge(w.user, w.cookie);
      expect(res.status).toBe(200);
      expect(body(res).droppedLines).toBe(0);
      expect(byProduct(res)).toEqual({ [w.a]: 4, [w.b]: 20, [w.c]: 2 });
      expect(await stored(w.guestId)).toEqual([]);
      const clear = setCookies(res).find((c) => c.startsWith('cart=;'))!;
      expect(clear).toContain('Max-Age=0');
      expect(clear).toContain('Path=/');
      expect(byProduct(await userGet(w.user))).toEqual({
        [w.a]: 4,
        [w.b]: 20,
        [w.c]: 2,
      });
    });

    it('S10 AS-06: two simultaneous merges add the guest quantities once; a later merge changes nothing', async () => {
      const w = await world();
      const [r1, r2] = await Promise.all([
        userMerge(w.user, w.cookie),
        userMerge(w.user, w.cookie),
      ]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect(byProduct(await userGet(w.user))).toEqual({
        [w.a]: 4,
        [w.b]: 20,
        [w.c]: 2,
      });
      const later = await userMerge(w.user, w.cookie);
      expect(later.status).toBe(200);
      expect(byProduct(later)).toEqual({ [w.a]: 4, [w.b]: 20, [w.c]: 2 });
    });

    it('S10 AS-07: 40 user lines and 20 other guest lines give 50 lines; the first 10 guest lines by (addedAt, productId) survive and droppedLines is 10', async () => {
      const user = await t.newUser();
      const userIds = Array.from({ length: 40 }, () => uuid());
      for (const id of userIds)
        expect((await userPut(user, id, 1)).status).toBe(200);
      const guestIds: string[] = [];
      let cookie: string | undefined;
      for (let i = 0; i < 20; i++) {
        const id = uuid();
        guestIds.push(id);
        t.clock.set(new Date(t.clock.now().getTime() + 1_000));
        const res = await guestPut(id, 1, cookie);
        cookie ??= cookieValue(res);
      }
      const res = await userMerge(user, cookie);
      expect(res.status).toBe(200);
      expect(body(res).droppedLines).toBe(10);
      const lines = body(res).lines.map((l) => l.productId);
      expect(lines).toHaveLength(50);
      expect(new Set(lines)).toEqual(
        new Set([...userIds, ...guestIds.slice(0, 10)]),
      );
      expect(await stored(cookie!.split('.')[0])).toEqual([]);
    });

    it('S10 AS-08: merge without a session is 401 and the guest cart is unchanged; a signed-in caller without a cookie gets their cart and no cookie change', async () => {
      const guest = await guestPut(uuid(), 2);
      const cookie = cookieValue(guest);
      const anonymous = await t
        .http()
        .post('/api/cart/merge')
        .set('Cookie', [`cart=${cookie}`]);
      expect(anonymous.status).toBe(401);
      expect(await stored(cookie.split('.')[0])).toHaveLength(1);

      const user = await t.newUser();
      const p = uuid();
      await userPut(user, p, 4);
      const res = await userMerge(user);
      expect(res.status).toBe(200);
      expect(byProduct(res)).toEqual({ [p]: 4 });
      expect(setCookies(res)).toEqual([]);
    });
  });

  describe('expiry and rate limit (AS-09, AS-10)', () => {
    it('S10 AS-09: a line is hidden 30 days and 1 second after it was set though the store holds it; setting it again restarts the 30 days; other lines keep their own deadline', async () => {
      const user = await t.newUser();
      const [a, b] = [uuid(), uuid()];
      await userPut(user, a, 1);
      t.clock.set(new Date(t.clock.now().getTime() + 10 * DAY_MS));
      user.bearer = (await t.reauth(user)).bearer;
      await userPut(user, b, 1);

      t.clock.set(new Date(t.clock.now().getTime() + 20 * DAY_MS + 1_000)); // a: 30 d + 1 s; b: 20 d + 1 s
      await t.reauth(user);
      expect(byProduct(await userGet(user))).toEqual({ [b]: 1 });
      expect(
        (await stored(`user:${user.id}`)).map((i) => i.productId).sort(),
      ).toEqual([a, b].sort());

      await userPut(user, a, 2); // set again: new 30 days from now
      t.clock.set(new Date(t.clock.now().getTime() + 29 * DAY_MS));
      await t.reauth(user);
      expect(byProduct(await userGet(user))).toEqual({ [a]: 2 }); // b expired meanwhile, a is alive
    });

    it('S10 AS-10: the 121st cart write is 429 with Retry-After and writes nothing; reads and the other limited route follow the same rule', async () => {
      const user = await t.newUser();
      const p = uuid();
      for (let i = 0; i < 120; i++) {
        const res = await userPut(user, p, (i % 20) + 1);
        expect(res.status).toBe(200);
      }
      const limited = await userPut(user, p, 20);
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.body.code).toBe('rate_limited');
      const read = await userGet(user);
      expect(read.status).toBe(200);
      expect(byProduct(read)[p]).toBe((119 % 20) + 1);
      expect((await userMerge(user)).status).toBe(429);
    });
  });
});

describe('Cart store wiring', () => {
  it('S10 AS-01: the cart store is the DynamoDB adapter (no relational access path exists)', async () => {
    const t = await createOrdersApp();
    try {
      expect(t.app.get(CART_STORE)).toBeInstanceOf(DynamoCartStore);
    } finally {
      await t.close();
    }
  });
});
