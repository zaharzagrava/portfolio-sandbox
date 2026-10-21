import { randomUUID } from 'node:crypto';
import {
  paymentPageSchema,
  paymentSchema,
} from '@marketplace-sandbox/contracts';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import {
  acceptPayment,
  createPaymentsApp,
  deliverCharge,
  payableBuyer,
  publishOrderReserved,
  seedPayment,
  type PaymentsTestApp,
} from './testing';

describe('Payments: reads, list and tenant isolation', () => {
  let t: PaymentsTestApp;

  beforeAll(async () => {
    t = await createPaymentsApp();
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const strip = (b: Record<string, unknown>) => {
    const { instance: _i, requestId: _r, ...rest } = b;
    return rest;
  };

  it('S13 AS-57: the owner reads the payment; another buyer, a missing id and a non-UUID are the same 404; no credentials is 401; the secret is for the owner while customer action is pending', async () => {
    const buyer = await payableBuyer(t);
    const id = await acceptPayment(t, buyer);
    const stranger = await t.newUser();

    const own = await t.as(buyer.user).get(`/api/payments/${id}`);
    expect(own.status).toBe(200);
    expect(paymentSchema.parse(own.body)).toMatchObject({
      id,
      status: 'PENDING',
      clientSecret: null,
    });

    const other = await t.as(stranger).get(`/api/payments/${id}`);
    const missing = await t.as(stranger).get(`/api/payments/${randomUUID()}`);
    expect(other.status).toBe(404);
    expect(other.body.code ?? other.body.type).toBeDefined();
    expect(JSON.stringify(other.body)).toContain('payment_not_found');
    expect(missing.status).toBe(404);
    expect(strip(other.body)).toEqual(strip(missing.body));

    const malformed = await t.as(buyer.user).get('/api/payments/not-a-uuid');
    expect(malformed.status).toBe(404);
    expect(JSON.stringify(malformed.body)).toContain('payment_not_found');

    const anonymous = await t.http().get(`/api/payments/${id}`);
    expect(anonymous.status).toBe(401);

    t.provider.script('create', {
      kind: 'ok',
      status: 'requires_action',
      overrides: { client_secret: 'pi_secret_3ds' },
    });
    await deliverCharge(t, id);
    const owner = await t.as(buyer.user).get(`/api/payments/${id}`);
    expect(owner.body).toMatchObject({
      requiresAction: true,
      clientSecret: 'pi_secret_3ds',
    });
    const peer = await t.as(stranger).get(`/api/payments/${id}`);
    expect(peer.status).toBe(404);
    expect(JSON.stringify(peer.body)).not.toContain('pi_secret_3ds');
  });

  describe('W03 B-2: GET /payments?orderId&status&limit&cursor', () => {
    it('S13 AS-58: lists the owner payment for an order, parsed by paymentPageSchema, with a null clientSecret', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      t.provider.script('create', {
        kind: 'ok',
        status: 'requires_action',
        overrides: { client_secret: 'pi_secret_list' },
      });
      await deliverCharge(t, id);

      const res = await t
        .as(buyer.user)
        .get(`/api/payments?orderId=${buyer.order.orderId}`);
      expect(res.status).toBe(200);
      const page = paymentPageSchema.parse(res.body);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id,
        orderId: buyer.order.orderId,
        requiresAction: true,
        clientSecret: null,
      });
      expect(page.nextCursor).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain('pi_secret_list');
    });

    it('S13 AS-58: returns the newest first and pages by keyset', async () => {
      const user = await t.newUser();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const order = await publishOrderReserved(t.app, { userId: user.id });
        ids.push(await acceptPayment(t, { user, order }));
        t.clock.advance(1_000);
      }
      const first = await t.as(user).get('/api/payments?limit=2');
      expect(first.status).toBe(200);
      const p1 = paymentPageSchema.parse(first.body);
      expect(p1.items.map((p) => p.id)).toEqual([ids[2], ids[1]]);
      expect(p1.nextCursor).not.toBeNull();
      const second = await t
        .as(user)
        .get(`/api/payments?limit=2&cursor=${p1.nextCursor}`);
      const p2 = paymentPageSchema.parse(second.body);
      expect(p2.items.map((p) => p.id)).toEqual([ids[0]]);
      expect(p2.nextCursor).toBeNull();
    });

    it('S13 AS-58: filters by status', async () => {
      const buyer = await payableBuyer(t);
      await acceptPayment(t, buyer);
      const pending = await t
        .as(buyer.user)
        .get('/api/payments?status=PENDING');
      expect(paymentPageSchema.parse(pending.body).items).toHaveLength(1);
      const done = await t.as(buyer.user).get('/api/payments?status=COMPLETED');
      expect(paymentPageSchema.parse(done.body).items).toHaveLength(0);
    });

    it("S13 AS-59: another buyer's orderId gives an empty page (existence hidden)", async () => {
      const buyer = await payableBuyer(t);
      await acceptPayment(t, buyer);
      const stranger = await t.newUser();
      const res = await t
        .as(stranger)
        .get(`/api/payments?orderId=${buyer.order.orderId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], nextCursor: null });
    });

    it('S13 AS-58: a bad query is 400; no credentials is 401', async () => {
      const user = await t.newUser();
      for (const q of [
        'orderId=nope',
        'limit=0',
        'limit=101',
        'status=BOGUS',
        'cursor=%25%25',
        'extra=1',
      ]) {
        const res = await t.as(user).get(`/api/payments?${q}`);
        expect([q, res.status]).toEqual([q, 400]);
      }
      expect((await t.http().get('/api/payments')).status).toBe(401);
    });

    it('S13 AS-58: 45 payments page 20/20/5 with no repeat or skip under concurrent inserts; default limit is 20; a tampered cursor is invalid_cursor', async () => {
      const user = await t.newUser();
      const base = t.clock.now().getTime();
      // each row has its own fixed time, so the 45 are written together (was one by one); `seeded` keeps their order
      const seeded: string[] = (
        await Promise.all(
          Array.from({ length: 45 }, (_, i) =>
            seedPayment(t.app, {
              userId: user.id,
              createdAt: new Date(base - (45 - i) * 1_000),
            }),
          ),
        )
      ).map((row) => row.id);
      const newestFirst = [...seeded].reverse();

      const first = paymentPageSchema.parse(
        (await t.as(user).get('/api/payments')).body,
      );
      expect(first.items).toHaveLength(20);
      // a newer payment arrives between pages: it must not shift the next page
      await seedPayment(t.app, { userId: user.id, createdAt: new Date(base) });
      const second = paymentPageSchema.parse(
        (await t.as(user).get(`/api/payments?cursor=${first.nextCursor}`)).body,
      );
      const third = paymentPageSchema.parse(
        (await t.as(user).get(`/api/payments?cursor=${second.nextCursor}`))
          .body,
      );
      expect(second.items).toHaveLength(20);
      expect(third.items).toHaveLength(5);
      expect(third.nextCursor).toBeNull();
      expect(
        [...first.items, ...second.items, ...third.items].map((p) => p.id),
      ).toEqual(newestFirst);

      const cursor = first.nextCursor as string;
      const tampered = `${cursor.slice(0, -2)}${cursor.endsWith('AA') ? 'BB' : 'AA'}`;
      const bad = await t.as(user).get(`/api/payments?cursor=${tampered}`);
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toContain('invalid_cursor');
    });

    it("S13 AS-59: no filter combination returns another buyer's payment", async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      const stranger = await t.newUser();
      for (const q of [
        '',
        `?orderId=${buyer.order.orderId}`,
        '?status=PENDING',
        `?orderId=${buyer.order.orderId}&status=PENDING&limit=100`,
      ]) {
        const res = await t.as(stranger).get(`/api/payments${q}`);
        expect([q, res.status]).toEqual([q, 200]);
        expect(JSON.stringify(res.body)).not.toContain(id);
        expect(paymentPageSchema.parse(res.body).items).toHaveLength(0);
      }
    });

    it('S13 SC-007: every read and create route, as another buyer or anonymous, is the same refusal and changes nothing', async () => {
      const buyer = await payableBuyer(t);
      const id = await acceptPayment(t, buyer);
      const stranger = await t.newUser();
      const before = JSON.stringify(
        (await t.as(buyer.user).get(`/api/payments/${id}`)).body,
      );

      expect((await t.as(stranger).get(`/api/payments/${id}`)).status).toBe(
        404,
      );
      const createAsStranger = await t
        .as(stranger)
        .post('/api/payments/intents')
        .set('Idempotency-Key', `key-${randomUUID()}`)
        .send({
          orderId: buyer.order.orderId,
          paymentMethodId: 'pm_card_visa',
        });
      expect(createAsStranger.status).toBe(404);
      for (const [method, url] of [
        ['get', `/api/payments/${id}`],
        ['get', `/api/payments?orderId=${buyer.order.orderId}`],
        ['post', '/api/payments/intents'],
      ] as const) {
        const res = await t.http()[method](url);
        expect([url, res.status]).toEqual([url, 401]);
      }
      expect(
        JSON.stringify(
          (await t.as(buyer.user).get(`/api/payments/${id}`)).body,
        ),
      ).toBe(before);
    });

    it('S13 AS-60: the 121st read in a minute is 429', async () => {
      const user = await t.newUser();
      // 120 reads in waves of 30 at once (was one by one); the 121st below still goes after all of them
      for (let wave = 0; wave < 4; wave++) {
        const wavesRes = await Promise.all(
          Array.from({ length: 30 }, () =>
            t.as(user).get('/api/payments?limit=1'),
          ),
        );
        expect(wavesRes.map((r) => r.status)).toEqual(Array(30).fill(200));
      }
      const limited = await t.as(user).get('/api/payments?limit=1');
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
    });
  });

  it('S13 AS-60: with the limiter store down reads are still answered (fail open)', async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    const proxy = await TcpFaultProxy.start({
      host: redis.hostname,
      port: Number(redis.port || 6379),
    });
    const own = await createPaymentsApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/0`,
    });
    try {
      await own.reset();
      const buyer = await payableBuyer(own);
      const id = await acceptPayment(own, buyer);
      proxy.mode = 'refuse';
      proxy.sever();
      await new Promise((r) => setTimeout(r, 300));
      const res = await own.as(buyer.user).get(`/api/payments/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
    } finally {
      proxy.mode = 'pass';
      await own.close();
      await proxy.close();
    }
  });
});
