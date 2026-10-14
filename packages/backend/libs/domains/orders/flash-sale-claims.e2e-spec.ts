import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { PaymentResultService } from './application/payment-result.service';
import {
  FLASH_RESERVATION,
  type FlashReservationPort,
} from './domain/flash-ports';
import { OrderJobs } from './infra/order.jobs';
import { createFlashApp, type FlashTestApp } from './testing/flash-kit';
import {
  DROP_PRICE,
  MIN,
  T,
  addToCart,
  advance,
  checkoutAs,
  claimState,
  countRows,
  openDrop,
  orderStatus,
  reservationsOf,
  sum,
  type Drop,
  type User,
} from './testing/flash-scenarios';

describe('Flash sales: release, convert and claim sweeping', () => {
  let t: FlashTestApp;
  let orderJobs: OrderJobs;
  let payments: PaymentResultService;
  let flash: FlashReservationPort;

  beforeAll(async () => {
    t = await createFlashApp();
    orderJobs = t.app.get(OrderJobs, { strict: false });
    payments = t.app.get(PaymentResultService, { strict: false });
    flash = t.app.get<FlashReservationPort>(FLASH_RESERVATION, {
      strict: false,
    });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    t.clock.set(T);
  });

  /** A buyer with `quantity` units of the drop in an accepted (RESERVED) order. */
  const buy = async (d: Drop, quantity: number, user?: User) => {
    const buyer = user ?? (await t.newUser());
    await addToCart(t, buyer, d.productId, quantity);
    const res = await checkoutAs(t, buyer);
    expect(res.status).toBe(202);
    return { user: buyer, orderId: res.body.orderId as string };
  };
  const total = (d: Drop) => t.buckets(d.id, d.buckets).then(sum);

  describe('release (AS-30, AS-31, AS-32)', () => {
    it('S11 AS-30: a cancel and an expiry return their units to the buckets, free the quota, and another buyer can take them', async () => {
      const d = await openDrop(t, { units: 8, buckets: 2, limit: 8 });
      const a = await buy(d, 3);
      const b = await buy(d, 5);
      expect(await total(d)).toBe(0);

      expect(
        (await t.as(a.user).post(`/api/orders/${a.orderId}/cancel`)).status,
      ).toBe(200);
      expect(await total(d)).toBe(3);
      expect(await t.quotaOf(d.id, a.user.id)).toBe(0);

      await advance(t, 16 * MIN); // past the 15-minute hold of b's order
      await orderJobs.expireReservation({ orderId: b.orderId });
      expect((await orderStatus(t, b.orderId)).status).toBe('CANCELLED');
      expect(await total(d)).toBe(8);
      expect(await t.quotaOf(d.id, b.user.id)).toBe(0);
      expect((await reservationsOf(t, d.id)).map((r) => r.status)).toEqual([
        'RELEASED',
        'RELEASED',
      ]);

      const c = await t.newUser();
      await addToCart(t, c, d.productId, 8);
      const res = await checkoutAs(t, c);
      expect(res.status).toBe(202);
      expect(await total(d)).toBe(0);
    });

    it('S11 AS-31: cancel, expiry and a retry, also at the same time, return the units once', async () => {
      const d = await openDrop(t, { units: 10, buckets: 2, limit: 5 });
      const { user, orderId } = await buy(d, 4);
      expect(await total(d)).toBe(6);

      await advance(t, 16 * MIN, user);
      await Promise.all([
        t.as(user).post(`/api/orders/${orderId}/cancel`),
        orderJobs.expireReservation({ orderId }),
        orderJobs.releaseStock(),
      ]);
      await orderJobs.expireReservation({ orderId });
      await orderJobs.releaseStock();
      await orderJobs.releaseStock();

      expect(await total(d)).toBe(10);
      expect(await t.quotaOf(d.id, user.id)).toBe(0);
      const [row] = await reservationsOf(t, d.id);
      expect(row.status).toBe('RELEASED');
      // a further release of the claim is a named no-op
      expect(
        await flash.releaseReservation({
          id: row.id,
          orderId,
          productId: d.productId,
          quantity: 4,
          status: 'RELEASED',
          sourceRef: row.sourceRef,
          flashSaleId: d.id,
        }),
      ).toBe('already_released');
      expect(await total(d)).toBe(10);
    });

    it('S11 AS-32: while the store refuses commands the rows wait as RELEASE_PENDING and lose nothing; once it is back they are released once', async () => {
      const d = await openDrop(t, { units: 10, buckets: 2, limit: 5 });
      const { user, orderId } = await buy(d, 3);

      await t.denyStore();
      const cancel = await t.as(user).post(`/api/orders/${orderId}/cancel`);
      expect(cancel.status).toBe(200);
      let [row] = await reservationsOf(t, d.id);
      expect(row.status).toBe('RELEASE_PENDING');

      await orderJobs.releaseStock(); // the store is still down: a retry is scheduled, nothing is lost
      [row] = await reservationsOf(t, d.id);
      expect(row.status).toBe('RELEASE_PENDING');
      expect(row.nextReleaseAt).not.toBeNull();

      await t.allowStore();
      expect(await total(d)).toBe(7); // the three units are still out, still owned by the claim
      await advance(t, 11 * MIN);
      await orderJobs.releaseStock();
      [row] = await reservationsOf(t, d.id);
      expect(row.status).toBe('RELEASED');
      expect(await total(d)).toBe(10);
      expect(await t.quotaOf(d.id, user.id)).toBe(0);

      await orderJobs.releaseStock();
      expect(await total(d)).toBe(10);
    });
  });

  describe('convert (AS-33, AS-34)', () => {
    it('S11 AS-33: a payment makes the claim permanent: CONVERTED, units stay out, a release is refused as not held, a repeat is a no-op', async () => {
      const d = await openDrop(t, { units: 10, buckets: 2, limit: 5 });
      const { user, orderId } = await buy(d, 2);

      expect(
        await payments.applySuccess(orderId, 'pi_flash_1', 'system:test'),
      ).toBe('paid');
      const [row] = await reservationsOf(t, d.id);
      expect(row.status).toBe('CONVERTED');
      expect(await claimState(t, d.id, row.sourceRef)).toBe('SOLD');
      expect(await total(d)).toBe(8);
      expect(await t.quotaOf(d.id, user.id)).toBe(2);

      const asRow = {
        id: row.id,
        orderId,
        productId: d.productId,
        quantity: 2,
        status: 'CONVERTED' as const,
        sourceRef: row.sourceRef,
        flashSaleId: d.id,
      };
      expect(await flash.releaseReservation(asRow)).toBe('not_held');
      expect(await flash.convertReservation(asRow)).toBe('already_converted');
      expect(
        await payments.applySuccess(orderId, 'pi_flash_1', 'system:test'),
      ).toBe('already_paid');
      expect(await total(d)).toBe(8);
      expect(await t.quotaOf(d.id, user.id)).toBe(2);
    });

    it('S11 AS-34: a late payment for a released claim finds it not held; buckets and quota stay as released', async () => {
      const d = await openDrop(t, { units: 10, buckets: 2, limit: 5 });
      const { user, orderId } = await buy(d, 2);
      await advance(t, 16 * MIN, user);
      await orderJobs.expireReservation({ orderId });
      expect(await total(d)).toBe(10);

      // S10 refuses to pay a cancelled order and asks for a refund; the claim is not touched
      expect(
        await payments.applySuccess(orderId, 'pi_late', 'system:test'),
      ).toBe('refund_requested');
      expect(await total(d)).toBe(10);
      expect(await t.quotaOf(d.id, user.id)).toBe(0);

      // and even a direct conversion of the released claim is refused
      const [row] = await reservationsOf(t, d.id);
      expect(
        await flash.convertReservation({
          id: row.id,
          orderId,
          productId: d.productId,
          quantity: 2,
          status: 'CONVERTED',
          sourceRef: row.sourceRef,
          flashSaleId: d.id,
        }),
      ).toBe('not_held');
      expect(await total(d)).toBe(10);
      expect(await t.quotaOf(d.id, user.id)).toBe(0);
    });
  });

  describe('claim sweeping (AS-35, AS-36)', () => {
    it('S11 AS-35: a claim abandoned after the crash is given back by the sweeper with its quota, and counted; no order exists', async () => {
      const d = await openDrop(t, { units: 10, buckets: 2, limit: 5 });
      const user = await t.newUser();
      await addToCart(t, user, d.productId, 2);
      t.crash.arm('after-claim');
      const crashed = await checkoutAs(t, user);
      expect(crashed.status).toBe(500);
      expect(await total(d)).toBe(8); // the units are out
      expect(await t.quotaOf(d.id, user.id)).toBe(2);
      expect(await countRows(t, 'BisOrder')).toBe(0);

      await t.jobs.sweepClaims(); // the window has not passed: nothing is due
      expect(await total(d)).toBe(8);

      await advance(t, 2 * MIN);
      const before =
        MetricsRegistry.value('flash_sale_claims_expired_total') ?? 0;
      await t.jobs.sweepClaims();
      expect(await total(d)).toBe(10);
      expect(await t.quotaOf(d.id, user.id)).toBe(0);
      expect(MetricsRegistry.value('flash_sale_claims_expired_total')).toBe(
        before + 1,
      );
      expect(await countRows(t, 'BisOrder')).toBe(0);
      await t.jobs.sweepClaims();
      expect(await total(d)).toBe(10);
    });

    it('S11 AS-36: an order whose confirmation was lost keeps its units: the sweeper commits the claim instead of returning it', async () => {
      const d = await openDrop(t, { units: 10, buckets: 2, limit: 5 });
      const user = await t.newUser();
      await addToCart(t, user, d.productId, 2);
      t.crash.arm('checkout:after-order-write');
      const crashed = await checkoutAs(t, user);
      expect(crashed.status).toBe(500);
      const [row] = await reservationsOf(t, d.id);
      expect(row.status).toBe('HELD'); // the order and its durable row exist
      expect(await claimState(t, d.id, row.sourceRef)).toBe('CLAIMED');

      await advance(t, 2 * MIN);
      await t.jobs.sweepClaims();
      expect(await claimState(t, d.id, row.sourceRef)).toBe('COMMITTED');
      expect(await total(d)).toBe(8);
      expect(await t.quotaOf(d.id, user.id)).toBe(2);
      expect((await reservationsOf(t, d.id))[0].status).toBe('HELD');
    });

    it('S11 AS-36: with less than 20 s of the claim window left the claim is released and the checkout answers 503 checkout_unavailable', async () => {
      const d = await openDrop(t, { units: 10, buckets: 2, limit: 5 });
      const user = await t.newUser();
      await addToCart(t, user, d.productId, 2);
      // a slow order write: 45 s of the 60 s window pass between the claim and the write
      t.crash.gates.set('checkout:before-order-write', async () => {
        t.clock.set(new Date(t.clock.nowMs() + 45_000));
      });

      const res = await checkoutAs(t, user);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('checkout_unavailable');
      expect(res.headers['retry-after']).toBe('2');
      expect(await total(d)).toBe(10);
      expect(await t.quotaOf(d.id, user.id)).toBe(0);
      expect(await countRows(t, 'BisOrder')).toBe(0);

      t.crash.gates.clear();
      await advance(t, 1_000, user);
      const retry = await checkoutAs(t, user);
      expect(retry.status).toBe(202);
      expect(retry.body.totalMinor).toBe(2 * DROP_PRICE);
    });

    it('S11 AS-36: a claim the sweeper returned before the commit cancels the order instead of selling units that are gone', async () => {
      const d = await openDrop(t, { units: 10, buckets: 2, limit: 5 });
      const user = await t.newUser();
      await addToCart(t, user, d.productId, 1);
      // the sweeper finds the claim before the order is written and returns it; the order write then commits a lost claim
      t.crash.gates.set('checkout:after-order-write', async () => {
        const [row] = await reservationsOf(t, d.id);
        await flash.releaseReservation({
          id: row.id,
          orderId: row.bisOrderId,
          productId: d.productId,
          quantity: 1,
          status: 'HELD',
          sourceRef: row.sourceRef,
          flashSaleId: d.id,
        });
      });
      const res = await checkoutAs(t, user);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('checkout_unavailable');
      const [order] = await reservationsOf(t, d.id);
      expect((await orderStatus(t, order.bisOrderId)).status).toBe('CANCELLED');
      expect(await total(d)).toBe(10);
    });
  });
});
