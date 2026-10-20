import { randomUUID } from 'node:crypto';
import { orderEventSchemas } from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { OrderLifecycleService } from './application/order-lifecycle.service';
import {
  ATTRIBUTION_RESOLVER,
  type AttributionResolverPort,
  type ResolvedAttribution,
} from './domain/ports';
import {
  createOrdersApp,
  orderRow,
  rows,
  seedShopWithProducts,
  type OrdersTestApp,
} from './testing/orders-app';

/** The marketing side of R1 is proven by S37; here the resolver is a scripted edge (a store, a failure). */
class ScriptedResolver implements AttributionResolverPort {
  links = new Map<string, ResolvedAttribution>();
  failing = false;
  async resolve(code: string): Promise<ResolvedAttribution | null> {
    if (this.failing) throw new Error('marketing store down');
    return this.links.get(code) ?? null;
  }
}

describe('J05 checkout attribution: ref is resolved once, frozen on the order and carried by order.paid', () => {
  let t: OrdersTestApp;
  const resolver = new ScriptedResolver();

  beforeAll(async () => {
    t = await createOrdersApp({
      overrides: [{ provide: ATTRIBUTION_RESOLVER, useValue: resolver }],
    });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    resolver.links.clear();
    resolver.failing = false;
  });

  type User = Awaited<ReturnType<OrdersTestApp['newUser']>>;
  const newKey = () => `key-${randomUUID()}`;
  const checkout = (user: User, key: string, body?: object) => {
    const req = t.as(user).post('/api/checkout').set('Idempotency-Key', key);
    return body === undefined ? req : req.send(body);
  };
  const withCart = async () => {
    const { products } = await seedShopWithProducts(t.app, [
      {
        title: 'Ref product',
        priceMinor: 1_000,
        quantity: 50,
        currency: 'EUR',
      },
    ]);
    const user = await t.newUser();
    const put = await t
      .as(user)
      .put(`/api/cart/items/${products[0].id}`)
      .send({ quantity: 1 });
    expect(put.status).toBe(200);
    return user;
  };
  const link = (
    code: string,
    ownerId: string,
    status: ResolvedAttribution['status'] = 'ACTIVE',
  ) => resolver.links.set(code, { code, ownerId, status });
  const ownerOf = async (orderId: string) =>
    (
      await rows<{ refCode: string | null; owner: string | null }>(
        t.app,
        `SELECT "refCode", "attributionOwnerId" AS owner FROM "BisOrder" WHERE "id" = :id`,
        { id: orderId },
      )
    )[0];

  it('J05 AS-13: a valid ref attributes the order to the link (code on GET /orders/:id, owner never exposed) and order.paid carries both', async () => {
    const owner = await t.newUser();
    link('friend-42', owner.id);
    const buyer = await withCart();
    const res = await checkout(buyer, newKey(), { ref: 'friend-42' });
    expect(res.status).toBe(202);
    expect(await ownerOf(res.body.orderId)).toEqual({
      refCode: 'friend-42',
      owner: owner.id,
    });

    const got = await t.as(buyer).get(`/api/orders/${res.body.orderId}`);
    expect(got.status).toBe(200);
    expect(got.body.attribution).toEqual({ code: 'friend-42' });
    expect(JSON.stringify(got.body)).not.toContain(owner.id);

    await t.app
      .get(OrderLifecycleService)
      .transition(
        res.body.orderId,
        { type: 'markPaid', paymentRef: 'pi_attr' },
        { actor: 'system:test' },
      );
    const paid = (await outboxRowsFor(t.app, res.body.orderId)).find(
      (r) => r.type === 'order.paid',
    );
    const payload = orderEventSchemas['order.paid'].parse(
      (paid!.payload as { payload: unknown }).payload,
    );
    expect(payload.attribution).toEqual({
      code: 'friend-42',
      ownerId: owner.id,
    });
  });

  it('J05 AS-16: (J05 AS-17) unknown, disabled, own and malformed-free refs credit no one and never fail the sale; an expired link still credits', async () => {
    const owner = await t.newUser();
    link('gone-link', owner.id, 'DISABLED');
    link('old-link', owner.id, 'EXPIRED');

    const unknown = await checkout(await withCart(), newKey(), {
      ref: 'nobody-1',
    });
    expect(unknown.status).toBe(202);
    expect(await ownerOf(unknown.body.orderId)).toEqual({
      refCode: null,
      owner: null,
    });

    const disabled = await checkout(await withCart(), newKey(), {
      ref: 'gone-link',
    });
    expect(disabled.status).toBe(202);
    expect((await ownerOf(disabled.body.orderId)).owner).toBeNull();

    const buyer = await withCart();
    link('my-own-link', buyer.id);
    const own = await checkout(buyer, newKey(), { ref: 'my-own-link' });
    expect(own.status).toBe(202);
    expect((await ownerOf(own.body.orderId)).owner).toBeNull();
    const got = await t.as(buyer).get(`/api/orders/${own.body.orderId}`);
    expect(got.body.attribution).toBeNull();

    const expired = await checkout(await withCart(), newKey(), {
      ref: 'old-link',
    });
    expect(expired.status).toBe(202);
    expect(await ownerOf(expired.body.orderId)).toEqual({
      refCode: 'old-link',
      owner: owner.id,
    });
  });

  it('J05 AS-16: a malformed ref or the old refCode field is a 400 and creates no order; the same key with another ref is 422', async () => {
    const owner = await t.newUser();
    link('friend-42', owner.id);
    const buyer = await withCart();
    for (const body of [
      { ref: 'ab' },
      { ref: 'has space' },
      { ref: 7 },
      { refCode: 'friend-42' },
    ]) {
      const res = await checkout(buyer, newKey(), body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    }
    const key = newKey();
    expect((await checkout(buyer, key, { ref: 'friend-42' })).status).toBe(202);
    const reused = await checkout(buyer, key, { ref: 'other-ref' });
    expect(reused.status).toBe(422);
  });

  it('J05 AS-13: a marketing lookup that fails degrades to no attribution; the order is still created', async () => {
    resolver.failing = true;
    const res = await checkout(await withCart(), newKey(), {
      ref: 'friend-42',
    });
    expect(res.status).toBe(202);
    expect(await ownerOf(res.body.orderId)).toEqual({
      refCode: null,
      owner: null,
    });
    expect((await orderRow(t.app, res.body.orderId)).status).toBe('RESERVED');
  });
});
