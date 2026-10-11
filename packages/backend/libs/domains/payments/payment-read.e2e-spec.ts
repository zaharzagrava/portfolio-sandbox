import { randomUUID } from 'node:crypto';
import {
  paymentPageSchema,
  paymentSchema,
} from '@marketplace-sandbox/contracts';
import {
  acceptPayment,
  createPaymentsApp,
  deliverCharge,
  payableBuyer,
  publishOrderReserved,
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
    it('lists the owner payment for an order, parsed by paymentPageSchema, with a null clientSecret', async () => {
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

    it('returns the newest first and pages by keyset', async () => {
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

    it('filters by status', async () => {
      const buyer = await payableBuyer(t);
      await acceptPayment(t, buyer);
      const pending = await t
        .as(buyer.user)
        .get('/api/payments?status=PENDING');
      expect(paymentPageSchema.parse(pending.body).items).toHaveLength(1);
      const done = await t.as(buyer.user).get('/api/payments?status=COMPLETED');
      expect(paymentPageSchema.parse(done.body).items).toHaveLength(0);
    });

    it("another buyer's orderId gives an empty page (existence hidden)", async () => {
      const buyer = await payableBuyer(t);
      await acceptPayment(t, buyer);
      const stranger = await t.newUser();
      const res = await t
        .as(stranger)
        .get(`/api/payments?orderId=${buyer.order.orderId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], nextCursor: null });
    });

    it('a bad query is 400; no credentials is 401', async () => {
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

    it('the 121st read in a minute is 429', async () => {
      const user = await t.newUser();
      for (let i = 0; i < 120; i++) {
        const res = await t.as(user).get('/api/payments?limit=1');
        expect(res.status).toBe(200);
      }
      const limited = await t.as(user).get('/api/payments?limit=1');
      expect(limited.status).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
    });
  });
});
