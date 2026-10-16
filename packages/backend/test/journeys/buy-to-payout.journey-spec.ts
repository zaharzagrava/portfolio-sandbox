import { randomUUID, createHmac } from 'node:crypto';
import { ControlSurface, adminClient } from './support/control-surface';
import {
  JOURNEY_PASSWORD,
  JourneyClient,
  problemCode,
} from './support/journey-client';
import {
  accountingPeriodPageSchema,
  accountingPeriodSchema,
  checkoutResponseSchema,
  JOURNEY_CONSUMER_GROUPS,
  notificationPageSchema,
  orderPageSchema,
  paymentPageSchema,
  periodCloseAcceptedSchema,
  payoutPageSchema,
  reconciliationFindingPageSchema,
  statementSchema,
  unreadCountSchema,
  upcomingPayoutSchema,
  type AccountingPeriod,
  type NotificationPage,
  type PayoutView,
  type Statement,
  type UpcomingPayoutView,
} from '@marketplace-sandbox/contracts';
import {
  apiLogPath,
  logLinesSince,
  logMark,
  metricValue,
  readMetrics,
  type MetricSnapshot,
} from './support/observability';
import {
  cancelOrder,
  checkout,
  getBalance,
  orderIdsOfThisRun,
  getOrder,
  getPayment,
  payOrder,
  startPayment,
  waitBalance,
  waitOrderStatus,
  waitPaymentStatus,
} from './support/purchase';
import {
  createSeller,
  setDestination,
  stockOf,
  type SellerFixture,
} from './support/seller-fixture';
import { openStream } from './support/stream';
import {
  deadlineMs,
  staysTrue,
  waitForContract,
} from './support/wait-for-contract';
import { readFileSync } from 'node:fs';
import { inParallel } from '../utils/async-helpers';

/**
 * Journey J01: buy to payout. Black box: public HTTP and SSE only; every test creates its own users, shops and products
 * (L-005, L-006); every wait is a contract hop (H1..H13), never a sleep (L-007). Scenario titles carry the test-plan id (L-017).
 */
describe('Journey J01: buy to payout', () => {
  let admin: JourneyClient;
  let control: ControlSurface;
  let startMetrics: MetricSnapshot | null = null;
  let metricsBlocked = '';
  let logStart = 0;

  beforeAll(async () => {
    admin = await adminClient();
    control = new ControlSurface(admin);
    await control.restoreAll(); // start from a known stack: consumers running, clock real

    // AS-14 freezes a month for good. A stack where an earlier run did that lives in the first month that is still open.
    await control.alignToOpenMonth();
    // AS-30 compares against this moment: the counters of the process, and the end of the API log
    // only AS-30 needs the counters: a stack without a metrics endpoint blocks that one test, not the whole journey
    startMetrics = await readMetrics().catch((error: Error) => {
      metricsBlocked = error.message;
      return null;
    });
    logStart = logMark(apiLogPath());
  });

  afterAll(async () => {
    await control?.restoreAll({ endAdminSessions: true });
  });

  /** Two shops (S1 sells A at 1000, S2 sells B at 500), staff T1 in S1, and a buyer: the fixture of the stories. */
  const marketplace = async (stockA = 10, stockB = 4) => {
    const [s1, s2, buyer] = await Promise.all([
      createSeller(admin, {
        products: [{ priceMinor: 1000, quantity: stockA }],
        staff: true,
      }),
      createSeller(admin, {
        products: [{ priceMinor: 500, quantity: stockB }],
      }),
      JourneyClient.signUp('buyer'),
    ]);
    return { s1, s2, buyer, A: s1.products[0], B: s2.products[0] };
  };

  describe('US1: the buyer pays once', () => {
    it('J01 AS-01: a buyer pays a two-shop order; the order is PAID once, in order, with stock taken', async () => {
      const { s1, s2, buyer, A, B } = await marketplace();
      const stream = await openStream(buyer, `user:${buyer.userId}`);
      try {
        const { order } = await checkout(buyer, [
          { product: A, quantity: 2 },
          { product: B, quantity: 1 },
        ]);
        expect(order.totalMinor).toBe(2500);
        const reserved = await getOrder(buyer, order.orderId);
        expect(
          reserved.shopOrders.map((s) => s.subtotalMinor).sort((a, b) => a - b),
        ).toEqual([500, 2000]);

        const accepted = await payOrder(buyer, order.orderId, 'pm_test_visa');
        expect(accepted.status).toBe(202);
        expect(accepted.body).toMatchObject({
          status: 'PENDING',
          amountMinor: 2500,
        });
        const paymentId = (accepted.body as { paymentId: string }).paymentId;

        await waitPaymentStatus(buyer, paymentId, 'COMPLETED', 'H2');
        const paid = await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3');
        expect(paid.shopOrders.every((s) => s.status === 'PAID')).toBe(true);
        expect(paid.timeline.map((t) => t.status)).toEqual([
          'PENDING',
          'RESERVED',
          'PAID',
        ]);

        await stream.next(
          (e) => e.event === 'order.status' && e.data.status === 'PAID',
          deadlineMs('H3'),
          'order.status PAID',
        );
        const paymentAt = stream.events.findIndex(
          (e) => e.event === 'payment.status',
        );
        const orderAt = stream.events.findIndex(
          (e) => e.event === 'order.status' && e.data.status === 'PAID',
        );
        expect(paymentAt).toBeGreaterThanOrEqual(0);
        expect(paymentAt).toBeLessThan(orderAt);

        expect(await stockOf(s1, A.id)).toBe(8);
        expect(await stockOf(s2, B.id)).toBe(3);
      } finally {
        stream.close();
      }
    });

    it('J01 AS-02: a signed webhook once and ten times at once after success changes nothing', async () => {
      const { buyer, A } = await marketplace();
      const { order } = await checkout(buyer, [{ product: A, quantity: 1 }]);
      const accepted = await payOrder(buyer, order.orderId);
      const paymentId = (accepted.body as { paymentId: string }).paymentId;
      await waitPaymentStatus(buyer, paymentId, 'COMPLETED', 'H2');
      const paid = await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3');

      const post = () => postSignedWebhook(order.orderId, control);
      expect((await post()).status).toBe(200);
      const results = await inParallel(10, () => post());
      expect(
        results.every(
          (r) => r.status === 'fulfilled' && r.value.status === 200,
        ),
      ).toBe(true);

      const after = await getOrder(buyer, order.orderId);
      expect(after.status).toBe('PAID');
      expect(after.timeline).toHaveLength(paid.timeline.length);
    });

    it('J01 AS-03: a webhook before the payment completes leaves the order RESERVED, then it becomes PAID once', async () => {
      const { buyer, A } = await marketplace();
      const { order } = await checkout(buyer, [{ product: A, quantity: 1 }]);
      const accepted = await payOrder(buyer, order.orderId, 'pm_test_slow');
      const paymentId = (accepted.body as { paymentId: string }).paymentId;

      expect((await postSignedWebhook(order.orderId, control)).status).toBe(
        200,
      );
      expect((await getPayment(buyer, paymentId)).status).toBe('PENDING');
      expect((await getOrder(buyer, order.orderId)).status).toBe('RESERVED');

      await waitPaymentStatus(buyer, paymentId, 'COMPLETED', 'H2w');
      const paid = await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3w');
      expect(paid.timeline.filter((t) => t.status === 'PAID')).toHaveLength(1);
    });

    it('J01 AS-04: with payments-order-copy paused the intent is 404; after resume the same key gets 202 and one payment', async () => {
      const { buyer, A } = await marketplace();
      await control.pause('payments-order-copy');
      let paymentId: string;
      const key = randomUUID();
      try {
        const { order } = await checkout(buyer, [{ product: A, quantity: 1 }]);
        const refused = await startPayment(
          buyer,
          order.orderId,
          'pm_test_visa',
          key,
        );
        expect(refused.status).toBe(404);
        expect(problemCode(refused.body)).toBe('order_not_found');

        await control.resume('payments-order-copy');
        const accepted = await payOrder(
          buyer,
          order.orderId,
          'pm_test_visa',
          key,
        );
        expect(accepted.status).toBe(202);
        paymentId = (accepted.body as { paymentId: string }).paymentId;
        const again = await startPayment(
          buyer,
          order.orderId,
          'pm_test_visa',
          key,
        );
        expect((again.body as { paymentId: string }).paymentId).toBe(paymentId);
        await waitPaymentStatus(buyer, paymentId, 'COMPLETED', 'H2');
      } finally {
        await control.resume('payments-order-copy');
      }
    });
  });

  const inboxOf = async (actor: JourneyClient) => {
    const reply = await actor.get('/api/notifications?limit=50', {
      schema: notificationPageSchema,
    });
    if (reply.status !== 200)
      throw new Error(`inbox: ${reply.status} ${JSON.stringify(reply.body)}`);
    return (reply.body as NotificationPage).items;
  };

  /** Waits (H5/H9) until the inbox holds an item of `type` whose link contains `needle`, then returns every such item. */
  const noticesOfType = (actor: JourneyClient, type: string, needle: string) =>
    waitForContract(
      'H5',
      async () => {
        const items = (await inboxOf(actor)).filter(
          (n) => n.type === type && (n.link ?? '').includes(needle),
        );
        return items.length > 0 ? items : null;
      },
      `${type} for ${needle}`,
    );

  const payoutsFor = async (seller: SellerFixture) => {
    const reply = await seller.owner.get(
      `/api/shops/${seller.shopId}/payouts`,
      { schema: payoutPageSchema },
    );
    if (reply.status !== 200)
      throw new Error(`payouts: ${reply.status} ${JSON.stringify(reply.body)}`);
    return (reply.body as { items: PayoutView[] }).items;
  };

  /**
   * `POST /admin/accounting-periods/:month/close` until it is accepted. Two answers mean "ask again": `period_not_ready`
   * (the fact streams have not caught up with the month yet) and the limiter's `429` (the operator writes 30 a minute).
   */
  const requestClose = (month: string, what: string) =>
    waitForContract(
      'H6',
      async () => {
        const reply = await admin.post(
          `/api/admin/accounting-periods/${month}/close`,
          { key: randomUUID(), schema: periodCloseAcceptedSchema },
        );
        if (reply.status === 202) return reply;
        if (
          problemCode(reply.body) === 'period_not_ready' ||
          problemCode(reply.body) === 'rate_limited'
        )
          return null;
        throw new Error(
          `close ${month}: ${reply.status} ${JSON.stringify(reply.body)}`,
        );
      },
      what,
    );

  const statementAt = async (seller: SellerFixture, month: string) => {
    const reply = await seller.owner.get(
      `/api/shops/${seller.shopId}/statements/${month}`,
      { schema: statementSchema },
    );
    return reply.status === 200 ? (reply.body as Statement) : null;
  };

  describe('US3: the notices', () => {
    const inbox = inboxOf;
    const unread = async (actor: JourneyClient) => {
      const reply = await actor.get('/api/notifications/unread-count', {
        schema: unreadCountSchema,
      });
      return (reply.body as { unread: number }).unread;
    };
    /** Waits (H5) until the inbox holds an item of `type` whose link contains `needle`, then returns every such item. */
    const noticesOf = (actor: JourneyClient, type: string, needle: string) =>
      waitForContract(
        'H5',
        async () => {
          const items = (await inbox(actor)).filter(
            (n) => n.type === type && (n.link ?? '').includes(needle),
          );
          return items.length > 0 ? items : null;
        },
        `${type} for ${needle}`,
      );

    it('J01 AS-08: the buyer and each shop owner get exactly one notice for the paid order, staff none, and the stream carries it', async () => {
      const { s1, s2, buyer, A, B } = await marketplace();
      const stream = await openStream(buyer, `user:${buyer.userId}`);
      try {
        const { order } = await checkout(buyer, [
          { product: A, quantity: 2 },
          { product: B, quantity: 1 },
        ]);
        const accepted = await payOrder(buyer, order.orderId);
        await waitPaymentStatus(
          buyer,
          (accepted.body as { paymentId: string }).paymentId,
          'COMPLETED',
          'H2',
        );
        await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3');

        const confirmed = await noticesOf(
          buyer,
          'order.confirmed',
          order.orderId,
        );
        expect(confirmed).toHaveLength(1);
        expect(confirmed[0].link).toBe(`/orders/${order.orderId}`);
        // a new account also holds its welcome notice: the count is the unread items of the inbox, and this one is among them
        expect(confirmed[0].read).toBe(false);
        const items = await inbox(buyer);
        expect(await unread(buyer)).toBe(items.filter((n) => !n.read).length);
        expect(
          items.filter((n) => n.type !== 'account.welcome').map((n) => n.type),
        ).toEqual(['order.confirmed']);

        const received1 = await noticesOf(
          s1.owner,
          'shop.order_received',
          order.orderId,
        );
        const received2 = await noticesOf(
          s2.owner,
          'shop.order_received',
          order.orderId,
        );
        expect(received1).toHaveLength(1);
        expect(received2).toHaveLength(1);
        // each owner reads their own shop's subtotal (20.00 and 5.00), never the other's or the order total
        expect(received1[0].body).toMatch(/€|EUR/); // the event's currency, not a default
        expect(received1[0].body).toMatch(/(?<![\d.,])20[.,]00/);
        expect(received1[0].body).not.toMatch(/(?<![\d.,])(5|25)[.,]00/);
        expect(received2[0].body).toMatch(/(?<![\d.,])5[.,]00/);
        expect(received2[0].body).not.toMatch(/(?<![\d.,])(20|25)[.,]00/);

        expect(
          (await inbox(s1.staff!)).filter((n) =>
            n.link?.includes(order.orderId),
          ),
        ).toEqual([]);
        await stream.next(
          (e) =>
            e.event === 'notification' && e.data.type === 'order.confirmed',
          deadlineMs('H5'),
          'notification order.confirmed',
        );
      } finally {
        stream.close();
      }
    });

    it('J01 AS-09: a declined card tells the buyer once and the sellers nothing, and there is no order.confirmed', async () => {
      const { s1, s2, buyer, A, B } = await marketplace();
      const { order } = await checkout(buyer, [
        { product: A, quantity: 1 },
        { product: B, quantity: 1 },
      ]);
      const accepted = await payOrder(buyer, order.orderId, 'pm_test_declined');
      await waitPaymentStatus(
        buyer,
        (accepted.body as { paymentId: string }).paymentId,
        'FAILED',
        'H2',
      );
      await waitOrderStatus(buyer, order.orderId, 'CANCELLED', 'H11');

      const failed = await noticesOf(buyer, 'payment.failed', order.orderId);
      expect(failed).toHaveLength(1);
      // the same inbox holds nothing else about this order: no confirmation, and the cancellation is explained by the failure
      expect(
        (await inbox(buyer)).filter((n) => n.type === 'order.confirmed'),
      ).toEqual([]);
      for (const seller of [s1.owner, s2.owner])
        expect(
          (await inbox(seller)).filter(
            (n) =>
              (n.link ?? '').includes(order.orderId) ||
              n.type.startsWith('order') ||
              n.type.startsWith('shop.order'),
          ),
        ).toEqual([]);
    });
  });

  describe('US4: the weekly payout', () => {
    /**
     * Three shops that sold in one order, each with a destination set before the clock moves: S1 and S3 hold 1800 (above the
     * minimum payout), S2 holds 450 (below it); S1's transfer succeeds, S3's is rejected by the provider double. One purchase,
     * then the clock crosses the 48 hour cooling period; the first run is shared by the tests of this story.
     */
    type Fixture = {
      s1: SellerFixture;
      s2: SellerFixture;
      s3: SellerFixture;
      n1: number;
      n2: number;
      n3: number;
    };
    let fx: Fixture;
    let firstRun: Promise<{ status: string }> | undefined;
    const monthOfClock = async () => (await control.clock()).now.slice(0, 7);
    const payoutsOf = async (seller: SellerFixture) => {
      const reply = await seller.owner.get(
        `/api/shops/${seller.shopId}/payouts`,
        { schema: payoutPageSchema },
      );
      if (reply.status !== 200)
        throw new Error(
          `payouts: ${reply.status} ${JSON.stringify(reply.body)}`,
        );
      return (reply.body as { items: PayoutView[] }).items;
    };
    const upcomingOf = async (seller: SellerFixture) => {
      const reply = await seller.owner.get(
        `/api/shops/${seller.shopId}/payouts/upcoming`,
        { schema: upcomingPayoutSchema },
      );
      if (reply.status !== 200)
        throw new Error(
          `upcoming: ${reply.status} ${JSON.stringify(reply.body)}`,
        );
      return reply.body as UpcomingPayoutView;
    };
    const payoutStatus = (
      seller: SellerFixture,
      status: PayoutView['status'],
      hop: 'H7' | 'H8',
    ) =>
      waitForContract(
        hop,
        async () =>
          (await payoutsOf(seller)).find((p) => p.status === status) ?? null,
        `payout ${status} of ${seller.shopId}`,
      );
    const statementOf = async (seller: SellerFixture) => {
      const reply = await seller.owner.get(
        `/api/shops/${seller.shopId}/statements/${await monthOfClock()}`,
        { schema: statementSchema },
      );
      return reply.status === 200 ? (reply.body as Statement) : null;
    };
    /** The first `payouts.run-weekly` of the story: every test that needs "after the run" awaits the same one. */
    const theRun = () => (firstRun ??= control.runJob('payouts.run-weekly'));

    beforeAll(async () => {
      const [s1, s2, s3, buyer] = await Promise.all([
        createSeller(admin, {
          products: [{ priceMinor: 1000, quantity: 10 }],
          destination: 'acct_test_ok',
          staff: true,
        }),
        createSeller(admin, {
          products: [{ priceMinor: 500, quantity: 10 }],
          destination: 'acct_test_ok',
        }),
        createSeller(admin, {
          products: [{ priceMinor: 1000, quantity: 10 }],
          destination: 'acct_test_reject',
        }),
        JourneyClient.signUp('buyer'),
      ]);
      const { order } = await checkout(buyer, [
        { product: s1.products[0], quantity: 2 },
        { product: s2.products[0], quantity: 1 },
        { product: s3.products[0], quantity: 2 },
      ]);
      const accepted = await payOrder(buyer, order.orderId);
      await waitPaymentStatus(
        buyer,
        (accepted.body as { paymentId: string }).paymentId,
        'COMPLETED',
        'H2',
      );
      await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3');
      const settled = (s: SellerFixture) =>
        waitBalance(
          s,
          (b) => b.availableMinor > 0 && b.source === 'read_model',
          'credited in the read model',
        );
      const [b1, b2, b3] = await Promise.all([
        settled(s1),
        settled(s2),
        settled(s3),
      ]);
      fx = {
        s1,
        s2,
        s3,
        n1: b1.availableMinor,
        n2: b2.availableMinor,
        n3: b3.availableMinor,
      };
      await control.advance(49 * 3600); // the destinations were set just now: cross the cooling period (S15)
    }, 240_000);

    afterAll(async () => {
      await control.rebase();
      // the rejecting destination must not make a later run fail again (L-013)
      if (fx)
        await setDestination(admin, fx.s3.shopId, 'acct_test_ok').catch(
          () => undefined,
        );
    });

    it('J01 AS-20: the weekly run pays S1 its balance less the reserve, the balance drops to the reserve, the statement shows the payout', async () => {
      expect(fx.n1).toBeGreaterThanOrEqual(1000); // above the minimum payout
      const job = await theRun();
      expect(job.status).toBe('SUCCEEDED');

      const created = await waitForContract(
        'H7',
        async () => {
          const items = await payoutsOf(fx.s1);
          return items.length > 0 ? items : null;
        },
        'a payout of S1',
      );
      expect(created).toHaveLength(1);
      const payout = created[0];
      expect(payout.amountMinor + payout.reserveHeldMinor).toBe(fx.n1);
      expect(payout.reserveHeldMinor).toBeGreaterThan(0);

      const paid = await payoutStatus(fx.s1, 'PAID', 'H8');
      expect(paid.id).toBe(payout.id);
      expect(paid.transferRef).toEqual(expect.any(String));
      expect(paid.paidAt).not.toBeNull();

      const balance = await waitBalance(
        fx.s1,
        (b) => b.availableMinor === payout.reserveHeldMinor,
        'S1 balance equals the reserve',
      );
      const upcoming = await upcomingOf(fx.s1);
      expect(upcoming.availableMinor).toBe(balance.availableMinor);

      const statement = await waitForContract(
        'H6',
        async () => {
          const s = await statementOf(fx.s1);
          return s && s.own.payoutsPaidMinor === paid.amountMinor ? s : null;
        },
        'statement payoutsPaidMinor',
      );
      expect(statement.own.payoutsPaidMinor).toBe(paid.amountMinor);
    });

    it('J01 AS-21: three more runs, one after another and two at once, leave one payout and the balance unchanged', async () => {
      await theRun();
      const before = await payoutsOf(fx.s1);
      expect(before).toHaveLength(1);
      const paid = await payoutStatus(fx.s1, 'PAID', 'H8');
      const balance = await waitBalance(
        fx.s1,
        (b) => b.availableMinor === paid.reserveHeldMinor,
        'balance equals the reserve',
      );

      expect((await control.runJob('payouts.run-weekly')).status).toBe(
        'SUCCEEDED',
      );
      const [x, y] = await Promise.all([
        control.runJob('payouts.run-weekly'),
        control.runJob('payouts.run-weekly'),
      ]);
      expect([x.status, y.status]).toEqual(['SUCCEEDED', 'SUCCEEDED']);

      const after = await payoutsOf(fx.s1);
      expect(after.map((p) => p.id)).toEqual(before.map((p) => p.id));
      expect((await getBalance(fx.s1.owner, fx.s1.shopId)).availableMinor).toBe(
        balance.availableMinor,
      );
    });

    it('J01 AS-22: a shop below the minimum is not paid and is told why', async () => {
      expect(fx.n2).toBeLessThan(1000);
      expect((await theRun()).status).toBe('SUCCEEDED');
      expect(await payoutsOf(fx.s2)).toEqual([]);
      expect((await getBalance(fx.s2.owner, fx.s2.shopId)).availableMinor).toBe(
        fx.n2,
      );
      const upcoming = await upcomingOf(fx.s2);
      expect(upcoming.blockedReason).toBe('below_minimum');
      expect(upcoming.availableMinor).toBe(fx.n2);
    });

    it('J01 AS-10: payout.paid reaches the owner of the paid shop only; payout.failed the owner of the rejected one', async () => {
      await theRun();
      const payout = await payoutStatus(fx.s1, 'PAID', 'H8');
      const paid = await waitForContract(
        'H9',
        async () => {
          const items = (await inboxOf(fx.s1.owner)).filter(
            (n) => n.type === 'payout.paid',
          );
          return items.length > 0 ? items : null;
        },
        'payout.paid notice',
      );
      expect(paid).toHaveLength(1);
      const amount = `${Math.floor(payout.amountMinor / 100)}[.,]${String(payout.amountMinor % 100).padStart(2, '0')}`;
      expect(paid[0].body).toMatch(new RegExp(`(?<![\\d.,])${amount}`));
      const failed = await waitForContract(
        'H9',
        async () => {
          const items = (await inboxOf(fx.s3.owner)).filter(
            (n) => n.type === 'payout.failed',
          );
          return items.length > 0 ? items : null;
        },
        'payout.failed notice',
      );
      expect(failed).toHaveLength(1);
      // the staff member and the other owners hear nothing about money that is not theirs
      expect(
        (await inboxOf(fx.s1.staff!)).filter((n) =>
          n.type.startsWith('payout.'),
        ),
      ).toEqual([]);
      expect(
        (await inboxOf(fx.s2.owner)).filter((n) =>
          n.type.startsWith('payout.'),
        ),
      ).toEqual([]);
      expect(
        (await inboxOf(fx.s3.owner)).filter((n) => n.type === 'payout.paid'),
      ).toEqual([]);
      expect(
        (await inboxOf(fx.s1.owner)).filter((n) => n.type === 'payout.failed'),
      ).toEqual([]);
    });

    it('J01 AS-23: a rejected transfer fails the payout, gives the balance back, tells the owner, and the shop is paid once the destination is fixed', async () => {
      expect((await theRun()).status).toBe('SUCCEEDED');
      const failed = await payoutStatus(fx.s3, 'FAILED', 'H8');
      expect(failed.failureCode).toEqual(expect.any(String));
      expect(failed.paidAt).toBeNull();
      await waitBalance(
        fx.s3,
        (b) => b.availableMinor === fx.n3,
        'S3 balance restored by the reversing journal',
      );

      const notices = await waitForContract(
        'H9',
        async () => {
          const items = (await inboxOf(fx.s3.owner)).filter(
            (n) => n.type === 'payout.failed',
          );
          return items.length > 0 ? items : null;
        },
        'payout.failed notice',
      );
      expect(notices).toHaveLength(1);
      expect((await statementOf(fx.s3))?.own.payoutsPaidMinor ?? 0).toBe(0);

      // fix the destination, cross the cooling period and the week: the next run pays the shop again
      await setDestination(admin, fx.s3.shopId, 'acct_test_ok');
      await control.advance(8 * 24 * 3600);
      expect((await control.runJob('payouts.run-weekly')).status).toBe(
        'SUCCEEDED',
      );
      const retried = await waitForContract(
        'H8',
        async () =>
          (await payoutsOf(fx.s3)).find((p) => p.status === 'PAID') ?? null,
        'S3 paid',
      );
      expect(retried.id).not.toBe(failed.id);
    });
  });

  /**
   * Declared here with its story, called as the LAST thing of the file: AS-14 closes a month for good, and every story that
   * reads the statement of "now" must run before the month is frozen.
   */
  const describeUS5 = () =>
    describe('US5: the statement and the month close', () => {
      /**
       * One order across two shops in the stack's current month; S1 has a payout destination. AS-14 closes that month for good
       * (a period is frozen once), which is why the guard at the top of the file refuses a stack whose month is already closed.
       */
      type Fixture = {
        s1: SellerFixture;
        s2: SellerFixture;
        month: string;
        orderId: string;
        paidAt: string;
      };
      let fx: Fixture;
      let live: Statement;

      const statementFor = async (seller: SellerFixture, month: string) => {
        const reply = await seller.owner.get(
          `/api/shops/${seller.shopId}/statements/${month}`,
          { schema: statementSchema },
        );
        return reply.status === 200 ? (reply.body as Statement) : null;
      };

      beforeAll(async () => {
        const [s1, s2, buyer] = await Promise.all([
          createSeller(admin, {
            products: [{ priceMinor: 1000, quantity: 10 }],
            destination: 'acct_test_ok',
          }),
          createSeller(admin, {
            products: [{ priceMinor: 500, quantity: 10 }],
          }),
          JourneyClient.signUp('buyer'),
        ]);
        const month = (await control.clock()).now.slice(0, 7);
        const { order } = await checkout(buyer, [
          { product: s1.products[0], quantity: 2 },
          { product: s2.products[0], quantity: 1 },
        ]);
        const accepted = await payOrder(buyer, order.orderId);
        await waitPaymentStatus(
          buyer,
          (accepted.body as { paymentId: string }).paymentId,
          'COMPLETED',
          'H2',
        );
        const paid = await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3');
        fx = {
          s1,
          s2,
          month,
          orderId: order.orderId,
          paidAt: paid.timeline.find((t) => t.status === 'PAID')!.at,
        };
      }, 120_000);

      afterAll(async () => {
        await control.rebase();
      });

      it('J01 AS-13: the live statement follows the sale and, after the payout, the paid amount; the other shop never appears', async () => {
        // dataAsOf is how far the facts have been applied: it reaches the sale's paidAt within the hop
        const sale = await waitForContract(
          'H6',
          async () => {
            const s = await statementFor(fx.s1, fx.month);
            return s &&
              s.own.lineCount > 0 &&
              s.dataAsOf &&
              new Date(s.dataAsOf) >= new Date(fx.paidAt)
              ? s
              : null;
          },
          'the sale in the statement of S1, applied through paidAt',
        );
        expect(sale).toMatchObject({ status: 'OPEN', source: 'live' });
        expect(sale.own).toMatchObject({
          grossMinor: 2000,
          lineCount: 1,
          commissionMinor: 200,
          netMinor: 1800,
          payoutsPaidMinor: 0,
        });
        const other = await waitForContract(
          'H6',
          async () => {
            const s = await statementFor(fx.s2, fx.month);
            return s && s.own.lineCount > 0 ? s : null;
          },
          'the sale in the statement of S2',
        );
        expect(other.own).toMatchObject({
          grossMinor: 500,
          lineCount: 1,
          commissionMinor: 50,
          netMinor: 450,
        });

        // the payout: cross the cooling period, run the week
        await control.advance(49 * 3600);
        expect((await control.runJob('payouts.run-weekly')).status).toBe(
          'SUCCEEDED',
        );
        const payout = await waitForContract(
          'H8',
          async () => {
            const reply = await fx.s1.owner.get(
              `/api/shops/${fx.s1.shopId}/payouts`,
              { schema: payoutPageSchema },
            );
            return (
              (reply.body as { items: PayoutView[] }).items.find(
                (p) => p.status === 'PAID',
              ) ?? null
            );
          },
          'the payout of S1 paid',
        );
        const payoutMonth = (await control.clock()).now.slice(0, 7);
        const afterPayout = await waitForContract(
          'H6',
          async () => {
            const s = await statementFor(fx.s1, payoutMonth);
            return s && s.own.payoutsPaidMinor === payout.amountMinor
              ? s
              : null;
          },
          'payoutsPaidMinor in the statement',
        );
        expect(afterPayout.own.payoutsPaidMinor).toBe(payout.amountMinor);
        await control.rebase();
      }, 180_000);

      it('J01 AS-14: closing the month freezes it: CLOSED, the snapshot equals the live numbers, a second close is 409', async () => {
        const [year, month] = fx.month.split('-').map(Number);
        const target = Date.UTC(year, month, 2, 3, 0, 0); // the 2nd of the next month, 03:00 UTC (the month index is 0-based)
        await control.advance(
          Math.ceil(
            (target - new Date((await control.clock()).now).getTime()) / 1000,
          ),
        );
        // the live numbers as of the moment of the close (read with the clock where the payout and the sale are known)
        live = (await statementFor(fx.s1, fx.month))!;
        expect(live).toMatchObject({ status: 'OPEN', source: 'live' });
        expect(live.own.payoutsPaidMinor).toBeGreaterThan(0);

        const accepted = await requestClose(fx.month, 'the close is accepted');
        expect(accepted.body).toMatchObject({
          month: fx.month,
          status: 'CLOSING',
        });

        const closed = await waitForContract(
          'H10',
          async () => {
            const reply = await admin.get(
              `/api/admin/accounting-periods/${fx.month}`,
              { schema: accountingPeriodSchema },
            );
            return reply.status === 200 &&
              (reply.body as AccountingPeriod).status === 'CLOSED'
              ? (reply.body as AccountingPeriod)
              : null;
          },
          `period ${fx.month} CLOSED`,
        );
        expect(closed.closedAt).not.toBeNull();

        const snapshot = (await statementFor(fx.s1, fx.month))!;
        expect(snapshot).toMatchObject({
          status: 'CLOSED',
          source: 'snapshot',
        });
        expect(snapshot.own).toEqual(live.own);

        const again = await admin.post(
          `/api/admin/accounting-periods/${fx.month}/close`,
          { key: randomUUID() },
        );
        expect(again.status).toBe(409);
        expect(problemCode(again.body)).toBe('period_closed');
      }, 240_000);

      it('J01 AS-15: the books tie out for the month: no mismatch finding for the shops of the journey', async () => {
        const period = await waitForContract(
          'H6',
          async () => {
            const reply = await admin.get(
              `/api/admin/accounting-periods/${fx.month}`,
              { schema: accountingPeriodSchema },
            );
            const body = reply.body as AccountingPeriod;
            return reply.status === 200 &&
              body.status === 'CLOSED' &&
              body.reconciliation !== 'unverified'
              ? body
              : null;
          },
          `the daily verification of ${fx.month}`,
        );
        expect(['clean', 'findings']).toContain(period.reconciliation);
        const findings = await admin.get(
          `/api/admin/accounting-periods/${fx.month}/findings?limit=100`,
          { schema: reconciliationFindingPageSchema },
        );
        expect(findings.status).toBe(200);
        const ours = (
          findings.body as { items: { kind: string; shopId: string | null }[] }
        ).items.filter(
          (f) => f.shopId === fx.s1.shopId || f.shopId === fx.s2.shopId,
        );
        expect(ours).toEqual([]);
      }, 180_000);
    });
  // (describeUS5 is invoked at the end of the file)

  describe('US6: the compensations', () => {
    const balances = async (...sellers: SellerFixture[]) =>
      Promise.all(
        sellers.map(
          async (s) => (await getBalance(s.owner, s.shopId)).availableMinor,
        ),
      );

    it('J01 AS-17: a declined card cancels the order (payment_failed), gives the stock back, moves no money, and a second intent is refused', async () => {
      const { s1, s2, buyer, A } = await marketplace();
      const { order } = await checkout(buyer, [{ product: A, quantity: 1 }]);
      expect(await stockOf(s1, A.id)).toBe(9);

      const accepted = await payOrder(buyer, order.orderId, 'pm_test_declined');
      expect(accepted.status).toBe(202);
      await waitPaymentStatus(
        buyer,
        (accepted.body as { paymentId: string }).paymentId,
        'FAILED',
        'H2',
      );
      const cancelled = await waitOrderStatus(
        buyer,
        order.orderId,
        'CANCELLED',
        'H11',
      );
      expect(cancelled.timeline.at(-1)).toMatchObject({
        status: 'CANCELLED',
        reason: 'payment_failed',
      });
      await waitForContract(
        'H11',
        async () => ((await stockOf(s1, A.id)) === 10 ? true : null),
        'stock of A back',
      );

      // a second intent is a 409 in every state; once payments' order copy has seen the cancellation (H1) it says why: not payable
      const second = await waitForContract(
        'H1',
        async () => {
          const reply = await startPayment(
            buyer,
            order.orderId,
            'pm_test_visa',
          );
          expect(reply.status).toBe(409);
          return problemCode(reply.body) === 'order_not_payable' ? reply : null;
        },
        'the second intent is refused as order_not_payable',
      );
      expect(second.body).toMatchObject({ reason: 'order_cancelled' });

      expect(await balances(s1, s2)).toEqual([0, 0]);
      const stored = (await inboxOf(buyer))
        .filter((n) => n.type !== 'account.welcome')
        .map((n) => n.type);
      expect(stored).toEqual(['payment.failed']); // no order.confirmed: order.paid was never published
    });

    it('J01 AS-18: cancelling while the charge is in flight refunds the late success; the order stays CANCELLED and the stock returns once', async () => {
      const { s1, s2, buyer, A } = await marketplace();
      const { order } = await checkout(buyer, [{ product: A, quantity: 1 }]);
      const accepted = await payOrder(buyer, order.orderId, 'pm_test_slow');
      const paymentId = (accepted.body as { paymentId: string }).paymentId;
      expect((await getPayment(buyer, paymentId)).status).toBe('PENDING');

      const cancel = await cancelOrder(buyer, order.orderId);
      expect(cancel.status).toBeLessThan(300);
      const cancelled = await getOrder(buyer, order.orderId);
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.timeline.at(-1)).toMatchObject({
        reason: 'user_cancelled',
      });
      await waitForContract(
        'H11',
        async () => ((await stockOf(s1, A.id)) === 10 ? true : null),
        'stock of A back',
      );

      // the provider answers 8 s later: the sale is booked, orders asks for the refund, payments refunds and reverses it
      const refunded = await waitPaymentStatus(
        buyer,
        paymentId,
        'REFUNDED',
        'H12',
      );
      expect(refunded.status).toBe('REFUNDED');
      const after = await getOrder(buyer, order.orderId);
      expect(after.status).toBe('CANCELLED');
      expect(after.timeline.map((t) => t.status)).not.toContain('PAID');
      expect(await stockOf(s1, A.id)).toBe(10); // restored exactly once, not twice
      expect(await balances(s1, s2)).toEqual([0, 0]);
      expect(
        (await inboxOf(s1.owner)).filter(
          (n) => n.type === 'shop.order_received',
        ),
      ).toEqual([]);
    });

    it('J01 AS-19: an unpaid hold that ends is cancelled (hold_expired), the stock returns, the intent is refused, and no money moved', async () => {
      const { s1, s2, buyer, A } = await marketplace();
      const { order } = await checkout(buyer, [{ product: A, quantity: 1 }]);
      expect(await stockOf(s1, A.id)).toBe(9);

      try {
        await control.advance(16 * 60); // the hold lasts 15 minutes
        const cancelled = await waitOrderStatus(
          buyer,
          order.orderId,
          'CANCELLED',
          'H11',
        );
        expect(cancelled.timeline.at(-1)).toMatchObject({
          status: 'CANCELLED',
          reason: 'hold_expired',
        });
        await waitForContract(
          'H11',
          async () => ((await stockOf(s1, A.id)) === 10 ? true : null),
          'stock of A back',
        );

        // payments learns of the cancellation through its order copy (H1); until then the deadline alone makes the hold
        // `hold_expired` (S13.R-03), after it the order is `order_cancelled`: always a 409, and it settles on the latter
        const refused = await waitForContract(
          'H1',
          async () => {
            const reply = await startPayment(
              buyer,
              order.orderId,
              'pm_test_visa',
            );
            expect(reply.status).toBe(409);
            expect(problemCode(reply.body)).toBe('order_not_payable');
            return (reply.body as { reason?: string }).reason ===
              'order_cancelled'
              ? reply
              : null;
          },
          'the intent is refused as order_cancelled',
        );
        expect(refused.status).toBe(409);
        expect(await balances(s1, s2)).toEqual([0, 0]);
      } finally {
        await control.rebase();
      }
    });
  });

  describe('US7: duplicates, replay and out-of-order signals', () => {
    it('J01 AS-24: the same key five times at once and again later, one webhook ten times: one order, one payment, one of everything', async () => {
      const { s1, buyer, A } = await marketplace();
      const put = await buyer.put(`/api/cart/items/${A.id}`, {
        body: { quantity: 2 },
      });
      expect(put.status).toBeLessThan(300);

      const key = randomUUID();
      const sendCheckout = () =>
        buyer.post('/api/checkout', {
          body: {},
          key,
          schema: checkoutResponseSchema,
        });
      const first = await inParallel(5, sendCheckout);
      expect(first.every((r) => r.status === 'fulfilled')).toBe(true);
      const replies = first.map(
        (r) =>
          (
            r as PromiseFulfilledResult<
              Awaited<ReturnType<typeof sendCheckout>>
            >
          ).value,
      );
      // while the first request runs, the others are told so (409 idempotency_in_flight); every 202 is the same order
      const created = replies.filter((r) => r.status === 202);
      expect(created.length).toBeGreaterThanOrEqual(1);
      for (const other of replies.filter((r) => r.status !== 202)) {
        expect([other.status, problemCode(other.body)]).toEqual([
          409,
          'idempotency_in_flight',
        ]);
      }
      const orderId = (created[0].body as { orderId: string }).orderId;
      expect(
        new Set(created.map((r) => (r.body as { orderId: string }).orderId)),
      ).toEqual(new Set([orderId]));
      const orders = await buyer.get('/api/orders', {
        schema: orderPageSchema,
      });
      expect(
        (orders.body as { items: { id: string }[] }).items.filter(
          (o) => o.id === orderId,
        ),
      ).toHaveLength(1);
      expect((orders.body as { items: unknown[] }).items).toHaveLength(1);

      // five intents with one key: one payment
      // (each call waits through the `404` of the order copy by itself, so none of them is a probe that creates the payment)
      const intentKey = randomUUID();
      const intents = await inParallel(5, () =>
        payOrder(buyer, orderId, 'pm_test_visa', intentKey),
      );
      expect(intents.every((r) => r.status === 'fulfilled')).toBe(true);
      const answers = intents.map(
        (r) =>
          (r as PromiseFulfilledResult<Awaited<ReturnType<typeof payOrder>>>)
            .value,
      );
      for (const other of answers.filter((r) => r.status !== 202)) {
        expect([other.status, problemCode(other.body)]).toEqual([
          409,
          'idempotency_in_flight',
        ]);
      }
      const paymentIds = new Set(
        answers
          .filter((r) => r.status === 202)
          .map((r) => (r.body as { paymentId: string }).paymentId),
      );
      expect(paymentIds.size).toBe(1);
      const paymentId = [...paymentIds][0];
      await waitPaymentStatus(buyer, paymentId, 'COMPLETED', 'H2');
      await waitOrderStatus(buyer, orderId, 'PAID', 'H3');

      // the webhook ten times at once, and the checkout again with the same key after the order is paid
      const hooks = await inParallel(10, () =>
        postSignedWebhook(orderId, control),
      );
      expect(
        hooks.map((h) =>
          h.status === 'fulfilled'
            ? h.value.status
            : `rejected: ${String(h.reason)}`,
        ),
      ).toEqual(Array(10).fill(200));
      const late = await sendCheckout();
      expect(late.status).toBe(202);
      expect((late.body as { orderId: string }).orderId).toBe(orderId);

      const payments = await buyer.get(`/api/payments?orderId=${orderId}`, {
        schema: paymentPageSchema,
      });
      expect((payments.body as { items: unknown[] }).items).toHaveLength(1);

      // what a single delivery gives: one confirmation, the shop credited once, one statement line
      const confirmed = await noticesOfType(buyer, 'order.confirmed', orderId);
      expect(confirmed).toHaveLength(1);
      const balance = await waitBalance(
        s1,
        (b) => b.availableMinor > 0 && b.source === 'read_model',
        'S1 credited',
      );
      expect(balance.availableMinor).toBe(1800);
      const statement = await waitForContract(
        'H6',
        async () => {
          const reply = await s1.owner.get(
            `/api/shops/${s1.shopId}/statements/${(await control.clock()).now.slice(0, 7)}`,
            { schema: statementSchema },
          );
          return reply.status === 200 &&
            (reply.body as Statement).own.lineCount > 0
            ? (reply.body as Statement)
            : null;
        },
        'statement shows the sale',
      );
      expect(statement.own).toMatchObject({ lineCount: 1, grossMinor: 2000 });
      expect(
        (await getOrder(buyer, orderId)).timeline.map((t) => t.status),
      ).toEqual(['PENDING', 'RESERVED', 'PAID']);
    });

    it('J01 AS-25: replaying the topics for the six consumer groups changes no observable', async () => {
      const s1 = await createSeller(admin, {
        products: [{ priceMinor: 1000, quantity: 10 }],
        destination: 'acct_test_ok',
      });
      const buyer = await JourneyClient.signUp('buyer');
      const since = new Date(
        new Date((await control.clock()).now).getTime() - 60_000,
      );
      const { order } = await checkout(buyer, [
        { product: s1.products[0], quantity: 2 },
      ]);
      const accepted = await payOrder(buyer, order.orderId);
      const paymentId = (accepted.body as { paymentId: string }).paymentId;
      await waitPaymentStatus(buyer, paymentId, 'COMPLETED', 'H2');
      await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3');
      await waitBalance(
        s1,
        (b) => b.availableMinor > 0 && b.source === 'read_model',
        'S1 credited',
      );

      try {
        await control.advance(49 * 3600);
        expect((await control.runJob('payouts.run-weekly')).status).toBe(
          'SUCCEEDED',
        );
        const payout = await waitForContract(
          'H8',
          async () =>
            (await payoutsFor(s1)).find((p) => p.status === 'PAID') ?? null,
          'the payout is paid',
        );
        await waitBalance(
          s1,
          (b) => b.availableMinor === payout.reserveHeldMinor,
          'balance equals the reserve',
        );
        await noticesOfType(s1.owner, 'payout.paid', s1.shopId);
        const month = (await control.clock()).now.slice(0, 7);
        await waitForContract(
          'H6',
          async () => {
            const s = await statementAt(s1, month);
            return s && s.own.payoutsPaidMinor === payout.amountMinor
              ? s
              : null;
          },
          'the payout in the statement',
        );

        const observe = async () => ({
          order: await getOrder(buyer, order.orderId),
          payment: await getPayment(buyer, paymentId),
          balance: (await getBalance(s1.owner, s1.shopId)).availableMinor,
          payouts: (await payoutsFor(s1)).map((p) => ({
            id: p.id,
            status: p.status,
            amountMinor: p.amountMinor,
            reserveHeldMinor: p.reserveHeldMinor,
          })),
          buyerInbox: (await inboxOf(buyer)).map((n) => n.type).sort(),
          ownerInbox: (await inboxOf(s1.owner)).map((n) => n.type).sort(),
          statement: (await statementAt(s1, month))?.own,
        });
        const recorded = await observe();
        expect(
          recorded.buyerInbox.filter((t) => t === 'order.confirmed'),
        ).toHaveLength(1);

        const groups = [
          'payments-order-copy',
          'orders-payment-results',
          'ledger-settlement',
          'ledger-balances',
          'notification-router',
          'statements-facts',
        ];
        for (const group of groups) await control.replay(group, since);
        for (const group of groups) await control.waitCaughtUp(group);
        // give the replayed messages the settle time of the slowest hop before looking
        await control.waitCaughtUp('statements-facts');
        expect(await observe()).toEqual(recorded);
      } finally {
        await control.rebase();
      }
    }, 240_000);

    it('J01 AS-26: a payment_failed signal that arrives after the success changes nothing', async () => {
      const { s1, buyer, A } = await marketplace();
      const { order } = await checkout(buyer, [{ product: A, quantity: 1 }]);
      const accepted = await payOrder(buyer, order.orderId);
      await waitPaymentStatus(
        buyer,
        (accepted.body as { paymentId: string }).paymentId,
        'COMPLETED',
        'H2',
      );
      const paid = await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3');
      const balance = await waitBalance(
        s1,
        (b) => b.availableMinor > 0 && b.source === 'read_model',
        'S1 credited',
      );
      await noticesOfType(buyer, 'order.confirmed', order.orderId);
      const inboxBefore = (await inboxOf(buyer)).map((n) => n.type).sort();

      const reply = await postSignedWebhook(
        order.orderId,
        control,
        'payment_intent.payment_failed',
      );
      expect(reply.status).toBe(200);
      // the signal is handled asynchronously and nothing is published when it changes nothing: watch the order for the
      // contract time of its own webhook hop
      await staysTrue(
        'H3w',
        async () => {
          const current = await getOrder(buyer, order.orderId);
          expect(current.status).toBe('PAID');
          expect(current.timeline).toHaveLength(paid.timeline.length);
        },
        'the order',
      );
      const after = await getOrder(buyer, order.orderId);
      expect(after.status).toBe('PAID');
      expect(after.timeline).toHaveLength(paid.timeline.length);
      expect((await getBalance(s1.owner, s1.shopId)).availableMinor).toBe(
        balance.availableMinor,
      );
      expect((await inboxOf(buyer)).map((n) => n.type).sort()).toEqual(
        inboxBefore,
      );
      expect(inboxBefore).not.toContain('order.cancelled');
      expect(await stockOf(s1, A.id)).toBe(9); // no restock
    });
  });

  describe('US8: a consumer is down', () => {
    it('J01 AS-27: with the settlement consumer down the order is PAID and notified but the balance waits; a payout run pays only what is settled; resume credits once', async () => {
      const s1 = await createSeller(admin, {
        products: [{ priceMinor: 1000, quantity: 10 }],
        destination: 'acct_test_ok',
      });
      const buyer = await JourneyClient.signUp('buyer');
      try {
        await control.advance(49 * 3600); // the destination has cooled: the shop is payable as soon as it has a balance
        await control.pause('ledger-settlement');

        const { order } = await checkout(buyer, [
          { product: s1.products[0], quantity: 2 },
        ]);
        const accepted = await payOrder(buyer, order.orderId);
        await waitPaymentStatus(
          buyer,
          (accepted.body as { paymentId: string }).paymentId,
          'COMPLETED',
          'H2',
        );
        await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3');
        expect(
          await noticesOfType(buyer, 'order.confirmed', order.orderId),
        ).toHaveLength(1);

        const down = await waitForContract(
          'H4',
          async () => {
            const view = await control.consumer('ledger-settlement');
            return view.state === 'PAUSED' && view.lag >= 1 ? view : null;
          },
          'the paused settlement consumer lags',
        );
        expect(down.lag).toBeGreaterThanOrEqual(1);
        await staysTrue(
          'H4',
          async () =>
            expect((await getBalance(s1.owner, s1.shopId)).availableMinor).toBe(
              0,
            ),
          'the balance of S1',
        );

        // a run while the consumer is down pays only what is settled: nothing
        expect((await control.runJob('payouts.run-weekly')).status).toBe(
          'SUCCEEDED',
        );
        expect(await payoutsFor(s1)).toEqual([]);

        await control.resume('ledger-settlement');
        const credited = await waitBalance(
          s1,
          (b) => b.availableMinor > 0 && b.source === 'read_model',
          'S1 credited after resume',
        );
        expect(credited.availableMinor).toBe(1800); // once, not twice
        await control.waitCaughtUp('ledger-settlement');

        // the next run pays the settled balance (less the reserve)
        expect(
          (await control.runJob('payouts.run-weekly', undefined, randomUUID()))
            .status,
        ).toBe('SUCCEEDED');
        const payout = await waitForContract(
          'H7',
          async () => (await payoutsFor(s1))[0] ?? null,
          'the payout of S1',
        );
        expect(payout.amountMinor + payout.reserveHeldMinor).toBe(1800);
      } finally {
        await control.resume('ledger-settlement');
        await control.rebase();
      }
    }, 240_000);
  });

  describe('US2: the books follow the payment', () => {
    /** Default commission is 10 % (1000 bps, S16 seed) on every category: net = line total − half-up commission per line. */
    const net = (lineTotal: number) =>
      lineTotal - Math.floor((lineTotal * 1000 + 5000) / 10_000);
    /** The month of the stack's clock (the journey may live in a later month than the real one, see `alignToOpenMonth`). */
    const month = async () => (await control.clock()).now.slice(0, 7);

    it('J01 AS-05: both shop balances equal net(s); nets plus the fee equal 2500; asOf is not before paidAt; cross-shop is 404', async () => {
      const { s1, s2, buyer, A, B } = await marketplace();
      const { order } = await checkout(buyer, [
        { product: A, quantity: 2 },
        { product: B, quantity: 1 },
      ]);
      const accepted = await payOrder(buyer, order.orderId, 'pm_test_visa');
      await waitPaymentStatus(
        buyer,
        (accepted.body as { paymentId: string }).paymentId,
        'COMPLETED',
        'H2',
      );
      const paid = await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3');
      const paidAt = paid.timeline.find((t) => t.status === 'PAID')!.at;

      const b1 = await waitBalance(
        s1,
        (b) => b.availableMinor > 0 && b.source === 'read_model',
        'S1 credited in the read model',
      );
      const b2 = await waitBalance(
        s2,
        (b) => b.availableMinor > 0 && b.source === 'read_model',
        'S2 credited in the read model',
      );
      expect(b1.availableMinor).toBe(net(2000));
      expect(b2.availableMinor).toBe(net(500));
      expect(
        b1.availableMinor + b2.availableMinor + (2500 - net(2000) - net(500)),
      ).toBe(2500);
      expect(b1.source).toBe('read_model');
      expect(new Date(b1.asOf).getTime()).toBeGreaterThanOrEqual(
        new Date(paidAt).getTime(),
      );

      const cross = await s1.owner.get(`/api/shops/${s2.shopId}/balance`);
      expect(cross.status).toBe(404);
      expect(problemCode(cross.body)).toBe('shop_not_found');
      expect((await s1.owner.get(`/api/shops/not-a-uuid/balance`)).status).toBe(
        400,
      );
      expect(
        (await s1.owner.get(`/api/shops/${s1.shopId}/balance?bogus=1`)).status,
      ).toBe(400);
    });

    it('J01 AS-06: a declined order credits nobody', async () => {
      const { s1, s2, buyer, A, B } = await marketplace();
      const { order } = await checkout(buyer, [
        { product: A, quantity: 1 },
        { product: B, quantity: 1 },
      ]);
      const accepted = await payOrder(buyer, order.orderId, 'pm_test_declined');
      await waitPaymentStatus(
        buyer,
        (accepted.body as { paymentId: string }).paymentId,
        'FAILED',
        'H2',
      );
      await waitOrderStatus(buyer, order.orderId, 'CANCELLED', 'H11');
      expect((await getBalance(s1.owner, s1.shopId)).availableMinor).toBe(0);
      expect((await getBalance(s2.owner, s2.shopId)).availableMinor).toBe(0);
    });

    it('J01 AS-07: the statement net equals the ledger credit and the findings hold no mismatch', async () => {
      const { s1, buyer, A } = await marketplace();
      const { order } = await checkout(buyer, [{ product: A, quantity: 2 }]);
      const accepted = await payOrder(buyer, order.orderId, 'pm_test_visa');
      await waitPaymentStatus(
        buyer,
        (accepted.body as { paymentId: string }).paymentId,
        'COMPLETED',
        'H2',
      );
      await waitOrderStatus(buyer, order.orderId, 'PAID', 'H3');
      const balance = await waitBalance(
        s1,
        (b) => b.availableMinor > 0,
        'S1 credited',
      );

      const statement = await waitForContract(
        'H6',
        async () => {
          const reply = await s1.owner.get(
            `/api/shops/${s1.shopId}/statements/${await month()}`,
            { schema: statementSchema },
          );
          const body = reply.body as Statement;
          return reply.status === 200 && body.own.lineCount > 0 ? body : null;
        },
        'statement shows the sale',
      );
      expect(statement.own.netMinor).toBe(balance.availableMinor);

      const findings = await admin.get(
        `/api/admin/accounting-periods/${await month()}/findings?limit=100`,
        { schema: reconciliationFindingPageSchema },
      );
      expect(findings.status).toBe(200);
      const mine = (
        findings.body as { items: { kind: string; shopId: string | null }[] }
      ).items.filter((f) => f.shopId === s1.shopId);
      expect(
        mine.filter(
          (f) => f.kind === 'net_mismatch' || f.kind === 'fee_mismatch',
        ),
      ).toEqual([]);
    });
  });

  /** AS-28 ends with a real close of the month it lives in, so it comes after every story that reads a statement of "now". */
  const describeUS8Close = () =>
    describe('US8: the notification and statements consumers are down', () => {
      it('J01 AS-28: inboxes stay empty and the statement behind while they are down, the close is refused naming the stream; after resume one notice each and the close succeeds', async () => {
        const month = await control.alignToOpenMonth(); // US5 froze its month: this one is the first that is still open
        // The watermarks of the fact streams only grow (the latest event time applied), and earlier moves of the clock pushed
        // them forward: "behind the sale" needs the sale to be later than what the streams have applied.
        const periods = await admin.get(
          '/api/admin/accounting-periods?limit=1',
          { schema: accountingPeriodPageSchema },
        );
        const marks = Object.values(
          (periods.body as { items: AccountingPeriod[] }).items[0]
            ?.watermarks ?? {},
        )
          .filter((m): m is string => !!m)
          .map((m) => new Date(m).getTime());
        const clockNow = new Date((await control.clock()).now).getTime();
        if (marks.length && Math.max(...marks) + 60_000 > clockNow)
          await control.advance(
            Math.ceil((Math.max(...marks) + 60_000 - clockNow) / 1000),
          );
        if ((await control.clock()).now.slice(0, 7) !== month) {
          throw new Error(
            `BLOCKED: the statement watermarks of this stack are past the end of ${month}; recreate the stack (scripts/qa/fresh-run.sh)`,
          );
        }
        const { s1, buyer, A } = await marketplace();
        try {
          await control.pause('notification-router');
          await control.pause('statements-facts');

          const { order } = await checkout(buyer, [
            { product: A, quantity: 2 },
          ]);
          const accepted = await payOrder(buyer, order.orderId);
          await waitPaymentStatus(
            buyer,
            (accepted.body as { paymentId: string }).paymentId,
            'COMPLETED',
            'H2',
          );
          const paid = await waitOrderStatus(
            buyer,
            order.orderId,
            'PAID',
            'H3',
          );
          const paidAt = paid.timeline.find((t) => t.status === 'PAID')!.at;
          // orders and the books do not depend on these consumers
          expect(
            (
              await waitBalance(
                s1,
                (b) => b.availableMinor > 0 && b.source === 'read_model',
                'S1 credited',
              )
            ).availableMinor,
          ).toBe(1800);

          await staysTrue(
            'H6',
            async () => {
              expect(
                (await inboxOf(buyer)).filter(
                  (n) => n.type === 'order.confirmed',
                ),
              ).toEqual([]);
              expect(
                (await inboxOf(s1.owner)).filter(
                  (n) => n.type === 'shop.order_received',
                ),
              ).toEqual([]);
              const statement = await statementAt(s1, month);
              expect(statement?.own.lineCount ?? 0).toBe(0);
              if (statement?.dataAsOf)
                expect(new Date(statement.dataAsOf).getTime()).toBeLessThan(
                  new Date(paidAt).getTime(),
                );
            },
            'the inboxes and the statement of S1',
          );

          // the month ends while the statements consumer is down: the close names the stream that is behind
          const [year, monthIndex] = month.split('-').map(Number);
          const target = Date.UTC(year, monthIndex, 2, 3, 0, 0);
          await control.advance(
            Math.ceil(
              (target - new Date((await control.clock()).now).getTime()) / 1000,
            ),
          );
          const refused = await admin.post(
            `/api/admin/accounting-periods/${month}/close`,
            { key: randomUUID() },
          );
          expect(refused.status).toBe(409);
          expect(problemCode(refused.body)).toBe('period_not_ready');
          expect(['orders', 'payouts', 'ledger']).toContain(
            (refused.body as { details?: { stream?: string } }).details?.stream,
          );

          await control.resume('notification-router');
          await control.resume('statements-facts');
          expect(
            await noticesOfType(buyer, 'order.confirmed', order.orderId),
          ).toHaveLength(1);
          expect(
            await noticesOfType(s1.owner, 'shop.order_received', order.orderId),
          ).toHaveLength(1);
          await waitForContract(
            'H6',
            async () => {
              const s = await statementAt(s1, month);
              return s &&
                s.own.lineCount === 1 &&
                s.dataAsOf &&
                new Date(s.dataAsOf) >= new Date(paidAt)
                ? s
                : null;
            },
            'the statement includes the sale',
          );

          const accepted2 = await requestClose(
            month,
            'the close is accepted after resume',
          );
          expect(accepted2.body).toMatchObject({ month, status: 'CLOSING' });
          await waitForContract(
            'H10',
            async () => {
              const reply = await admin.get(
                `/api/admin/accounting-periods/${month}`,
                { schema: accountingPeriodSchema },
              );
              return reply.status === 200 &&
                (reply.body as AccountingPeriod).status === 'CLOSED'
                ? true
                : null;
            },
            `period ${month} CLOSED`,
          );
          const snapshot = (await statementAt(s1, month))!;
          expect(snapshot).toMatchObject({
            status: 'CLOSED',
            source: 'snapshot',
          });
          expect(snapshot.own).toMatchObject({
            lineCount: 1,
            grossMinor: 2000,
          });
        } finally {
          await control.resume('notification-router');
          await control.resume('statements-facts');
          await control.rebase();
        }
      }, 300_000);
    });

  /** AS-30 looks back at the whole file: it runs last, after the month closes and with every consumer resumed. */
  const describeUS9 = () =>
    describe('US9: every hop is observable', () => {
      it('J01 AS-30: the counters of every hop moved during the run, every journey consumer reports lag 0, the log lines carry ids and no secret', async () => {
        if (!startMetrics) throw new Error(metricsBlocked);
        const before = startMetrics;
        const end = await readMetrics();
        const moved = (name: string, labels: Record<string, string> = {}) =>
          metricValue(end, name, labels) - metricValue(before, name, labels);
        const counters: Array<[string, string, Record<string, string>]> = [
          ['orders paid', 'orders_paid_total', {}],
          [
            'payments succeeded',
            'payments_status_transitions_total',
            { to: 'COMPLETED' },
          ],
          [
            'settlements posted',
            'ledger_journals_posted_total',
            { kind: 'SETTLEMENT' },
          ],
          ['payouts paid', 'payout_transfer_total', { outcome: 'paid' }],
          [
            'statement periods closed',
            'statements_period_close_total',
            { status: 'completed' },
          ],
          ['notifications created', 'notifications_inbox_created_total', {}],
        ];
        for (const [what, name, labels] of counters)
          expect([what, moved(name, labels) > 0]).toEqual([what, true]);

        for (const group of JOURNEY_CONSUMER_GROUPS) {
          const view = await control.waitCaughtUp(group);
          expect([group, view.state, view.lag]).toEqual([group, 'RUNNING', 0]);
        }

        const log = apiLogPath();
        if (!log) {
          // An environment limit, not a pass: the API log is not readable from here (the runner provides it as API_LOG).
          console.warn(
            '[AS-30] log checks NOT run: set API_LOG (or JOURNEY_API_LOG) to the API log file; see specs/UNVERIFIED.md',
          );
          return;
        }
        const lines = logLinesSince(log, logStart);
        const mine = [...orderIdsOfThisRun];
        const aboutOrders = lines.filter((line) =>
          mine.some((id) => line.includes(id)),
        );
        expect(aboutOrders.length).toBeGreaterThan(0);
        for (const line of aboutOrders)
          expect([
            line.slice(0, 200),
            /requestId|traceId|trace_id|request_id/.test(line),
          ]).toEqual([line.slice(0, 200), true]);
        // (the provider's own error text shows its key masked, `sk_test_*ummy`: that is not a key)
        const forbidden = [
          webhookSecret(),
          JOURNEY_PASSWORD,
          'Bearer ey',
          '4242424242424242',
        ];
        for (const secret of forbidden)
          expect(
            lines
              .filter((line) => line.includes(secret))
              .map((line) => line.slice(0, 120)),
          ).toEqual([]);
        expect(
          lines
            .filter((line) =>
              /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/.test(line),
            )
            .map((line) => line.slice(0, 120)),
        ).toEqual([]);
      }, 180_000);
    });

  describeUS5(); // after everything that reads a statement of "now": it closes a month for good
  describeUS8Close(); // and this one closes the next month
  describeUS9(); // and this one looks back at all of it
});

/**
 * The provider's signed `payment_intent.succeeded` for a payment (Stripe scheme: `t=<unix>,v1=HMAC_SHA256(secret, "<t>.<body>")`).
 * The secret comes from the stack's env file (`JOURNEY_ENV`) or `STRIPE_WEBHOOK_SECRET`; it is never printed.
 */
async function postSignedWebhook(
  orderId: string,
  control: ControlSurface,
  type = 'payment_intent.succeeded',
): Promise<{ status: number }> {
  const secret = webhookSecret();
  // the signature's timestamp is checked against the stack's clock, which the journey may have moved
  const stackNow = new Date((await control.clock()).now).getTime();
  const body = JSON.stringify({
    id: `evt_${randomUUID()}`,
    object: 'event',
    type,
    // the provider double names its intent `pi_scripted_<orderId>`; the intake finds the order by `metadata.orderId`
    data: {
      object: {
        id: `pi_scripted_${orderId}`,
        object: 'payment_intent',
        metadata: { orderId },
      },
    },
  });
  const t = Math.floor(stackNow / 1000);
  const signature = createHmac('sha256', secret)
    .update(`${t}.${body}`)
    .digest('hex');
  const response = await fetch(
    `${process.env.API_URL ?? 'http://localhost:8000'}/api/webhooks/stripe`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${t},v1=${signature}`,
      },
      body,
    },
  );
  return { status: response.status };
}

function webhookSecret(): string {
  if (process.env.STRIPE_WEBHOOK_SECRET)
    return process.env.STRIPE_WEBHOOK_SECRET;
  const file =
    process.env.JOURNEY_ENV ??
    new URL('../../.env', `file://${__dirname}/`).pathname;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('STRIPE_WEBHOOK_SECRET='));
  if (!line)
    throw new Error(
      `STRIPE_WEBHOOK_SECRET is not set in ${file}; regenerate the stack env (scripts/infra/make-dev-env.sh) and restart the API`,
    );
  return line.slice('STRIPE_WEBHOOK_SECRET='.length).trim();
}
