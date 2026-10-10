import { randomUUID } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import { paymentAcceptedSchema } from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { PAYMENT_REPOSITORY, type PaymentRepository } from './domain/ports';
import { ChargeCommandWorker } from './infra/charge-command.worker';
import {
  createGate,
  createPaymentsApp,
  exec,
  historyOf,
  paymentCount,
  paymentForOrder,
  paymentRow,
  publishOrderCancelled,
  publishOrderPaid,
  publishOrderReserved,
  rows,
  type PaymentsTestApp,
} from './testing';

const DAY = 24 * 3_600_000;
const T = new Date('2026-10-10T12:00:00.000Z');

describe('Payment intents: accept, idempotency, validation and access', () => {
  let t: PaymentsTestApp;

  beforeAll(async () => {
    t = await createPaymentsApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    t.clock.set(T);
  });

  type User = Awaited<ReturnType<PaymentsTestApp['newUser']>>;
  const newKey = () => `key-${randomUUID()}`;
  const pay = (user: User, key: string | null, body: object) => {
    const req = t.as(user).post('/api/payments/intents');
    return (key === null ? req : req.set('Idempotency-Key', key)).send(body);
  };
  const body = (orderId: string, over: object = {}) => ({
    orderId,
    paymentMethodId: 'pm_card_visa',
    ...over,
  });
  /** A buyer with a reserved EUR 25.00 order. */
  const buyer = async (
    over: { totalMinor?: number; currency?: string } = {},
  ) => {
    const user = await t.newUser();
    const order = await publishOrderReserved(t.app, {
      userId: user.id,
      ...over,
    });
    return { user, order };
  };
  const strip = (b: Record<string, unknown>) => {
    const { instance: _i, requestId: _r, ...rest } = b;
    return rest;
  };
  const tasksOf = async (paymentId: string) =>
    (await outboxRowsFor(t.app, paymentId)).filter((r) => r.kind === 'task');

  describe('the accepted payment (AS-01, AS-02)', () => {
    it('S13 AS-01: 202 with Location and the full effect: payment, history, charge command, idempotency record; no provider call', async () => {
      const { user, order } = await buyer();
      const key = newKey();

      const res = await pay(user, key, body(order.orderId));

      expect(res.status).toBe(202);
      const accepted = paymentAcceptedSchema.parse(res.body);
      expect(res.headers.location).toBe(`/api/payments/${accepted.paymentId}`);
      expect(accepted).toEqual({
        paymentId: accepted.paymentId,
        orderId: order.orderId,
        status: 'PENDING',
        amountMinor: 2_500,
        currency: 'EUR',
        createdAt: T.toISOString(),
      });

      const payment = await paymentRow(t.app, accepted.paymentId);
      expect(payment).toMatchObject({
        userId: user.id,
        orderId: order.orderId,
        status: 'PENDING',
        version: 1,
        amount: '2500',
        currency: 'EUR',
        chargeAttemptedAt: null,
        providerRef: null,
        paymentMethodToken: 'pm_card_visa',
      });
      expect(await historyOf(t.app, accepted.paymentId)).toEqual([
        {
          version: 1,
          fromStatus: null,
          toStatus: 'PENDING',
          reason: null,
          actor: `user:${user.id}`,
        },
      ]);
      const tasks = await tasksOf(accepted.paymentId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        topic: 'payments-charge',
        type: 'payments.charge_requested',
        status: 'pending',
        payload: { body: { paymentId: accepted.paymentId, attempt: 0 } },
      });
      expect(
        await rows(
          t.app,
          `SELECT 1 FROM "IdempotencyKey" WHERE "scope" = :scope AND "key" = :key AND "state" = 'completed'`,
          { scope: `principal:${user.id}`, key },
        ),
      ).toHaveLength(1);
      expect(t.provider.calls).toHaveLength(0);
    });

    it("S13 AS-02: the amount and currency are the order's; money, owner and card fields and unknown properties are refused and named", async () => {
      const { user, order } = await buyer();
      const refused: Array<[string, object]> = [
        ['amountMinor', { amountMinor: 1 }],
        ['currency', { currency: 'USD' }],
        ['userId', { userId: randomUUID() }],
        ['cardNumber', { cardNumber: '4242424242424242' }],
        ['extra', { extra: true }],
      ];
      for (const [property, extra] of refused) {
        const res = await pay(user, newKey(), body(order.orderId, extra));
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toContain(property);
      }
      // (a second buyer: the first has used five of her ten requests a minute)
      const another = await t.newUser();
      for (const bad of [
        { paymentMethodId: 'pm_x' },
        { orderId: order.orderId },
        { orderId: 'not-a-uuid', paymentMethodId: 'pm_x' },
        { orderId: order.orderId, paymentMethodId: '' },
        { orderId: order.orderId, paymentMethodId: 'x'.repeat(256) },
        { orderId: order.orderId, paymentMethodId: 42 },
      ]) {
        const res = await pay(another, newKey(), bad);
        expect(res.status).toBe(400);
      }
      expect(await paymentCount(t.app)).toBe(0);
      expect(await outboxRowsFor(t.app, order.orderId)).toHaveLength(0);

      const ok = await pay(user, newKey(), body(order.orderId));
      expect(ok.status).toBe(202);
      expect(ok.body).toMatchObject({ amountMinor: 2_500, currency: 'EUR' });
    });
  });

  describe('the same key (AS-03 to AS-05)', () => {
    it('S13 AS-03: the same key and body replays the original answer byte for byte, with no new rows and no provider call', async () => {
      const { user, order } = await buyer();
      const key = newKey();
      const first = await pay(user, key, body(order.orderId));
      await exec(
        t.app,
        `UPDATE "Payment" SET "status" = 'COMPLETED', "version" = 2 WHERE "id" = :id`,
        {
          id: first.body.paymentId,
        },
      );

      const again = await pay(user, key, body(order.orderId));

      expect(again.status).toBe(202);
      expect(again.text).toBe(first.text);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.headers.location).toBe(first.headers.location);
      expect(first.headers['idempotency-replayed']).toBeUndefined();
      expect(await paymentCount(t.app)).toBe(1);
      expect(await tasksOf(first.body.paymentId)).toHaveLength(1);
      expect(t.provider.calls).toHaveLength(0);
    });

    it('S13 AS-04: while the first request is still running, the same key answers 409 idempotency_in_flight with Retry-After: 1; afterwards it replays', async () => {
      const { user, order } = await buyer();
      const key = newKey();
      const gate = createGate();
      const repo = t.app.get<PaymentRepository>(PAYMENT_REPOSITORY, {
        strict: false,
      });
      t.patch(
        repo,
        'insertAccepted',
        (original) =>
          (async (...args: Parameters<PaymentRepository['insertAccepted']>) => {
            await gate.wait();
            return original(...args);
          }) as never,
      );

      const first = pay(user, key, body(order.orderId)).then((r) => r);
      await gate.reached;
      const second = await pay(user, key, body(order.orderId));
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('idempotency_in_flight');
      expect(second.headers['retry-after']).toBe('1');

      gate.open();
      const done = await first;
      expect(done.status).toBe(202);
      const third = await pay(user, key, body(order.orderId));
      expect(third.status).toBe(202);
      expect(third.headers['idempotency-replayed']).toBe('true');
      expect(third.body.paymentId).toBe(done.body.paymentId);
      expect(await paymentCount(t.app)).toBe(1);
    });

    it('S13 AS-05: five identical requests at once give 202 or 409 idempotency_in_flight, at least one 202, one payment, one command and one provider create after processing', async () => {
      const { user, order } = await buyer();
      const key = newKey();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => pay(user, key, body(order.orderId))),
      );

      for (const r of results) {
        if (r.status === 409) expect(r.body.code).toBe('idempotency_in_flight');
        else expect(r.status).toBe(202);
      }
      expect(results.some((r) => r.status === 202)).toBe(true);
      expect(await paymentCount(t.app)).toBe(1);
      const payment = (await paymentForOrder(t.app, order.orderId))!;
      const tasks = await tasksOf(payment.id);
      expect(tasks).toHaveLength(1);

      const worker = t.app.get(ChargeCommandWorker, { strict: false });
      for (const task of tasks)
        await worker.handle({ body: (task.payload as { body: never }).body });
      expect(t.provider.count('create')).toBe(1);
    });
  });

  describe('one payment per order (AS-06)', () => {
    it('S13 AS-06: two keys at once, 50 times: one 202 and one 409 payment_already_exists naming the payment; a third key is refused too, also after FAILED', async () => {
      for (let i = 0; i < 50; i++) {
        const { user, order } = await buyer();
        const [a, b] = await Promise.all([
          pay(user, newKey(), body(order.orderId)),
          pay(user, newKey(), body(order.orderId)),
        ]);
        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([202, 409]);
        const won = a.status === 202 ? a : b;
        const lost = a.status === 202 ? b : a;
        expect(lost.body).toMatchObject({
          code: 'payment_already_exists',
          existingPaymentId: won.body.paymentId,
        });
        expect(await tasksOf(won.body.paymentId)).toHaveLength(1);
        if (i < 3) {
          const third = await pay(user, newKey(), body(order.orderId));
          expect(third.status).toBe(409);
          expect(third.body.existingPaymentId).toBe(won.body.paymentId);
          await exec(
            t.app,
            `UPDATE "Payment" SET "status" = 'FAILED', "version" = 2 WHERE "id" = :id`,
            {
              id: won.body.paymentId,
            },
          );
          const fourth = await pay(user, newKey(), body(order.orderId));
          expect(fourth.status).toBe(409);
          expect(fourth.body.code).toBe('payment_already_exists');
        }
      }
      expect(await paymentCount(t.app)).toBe(50);
    }, 120_000);
  });

  describe('key misuse and key memory (AS-07 to AS-09)', () => {
    it('S13 AS-07: another body under a used key, a missing key and malformed keys are 422 and change nothing', async () => {
      const { user, order } = await buyer();
      const other = await publishOrderReserved(t.app, { userId: user.id });
      const key = newKey();
      expect((await pay(user, key, body(order.orderId))).status).toBe(202);

      const reuse = await pay(user, key, body(other.orderId));
      expect(reuse.status).toBe(422);
      expect(reuse.body.code).toBe('idempotency_key_reuse');

      const missing = await pay(user, null, body(order.orderId));
      expect(missing.status).toBe(422);
      expect(missing.body.code).toBe('idempotency_key_required');

      for (const bad of ['short', 'x'.repeat(129), 'has a space in it']) {
        const res = await pay(user, bad, body(other.orderId));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('idempotency_key_invalid');
      }
      expect(await paymentCount(t.app)).toBe(1);
      expect(await paymentForOrder(t.app, other.orderId)).toBeUndefined();
    });

    it("S13 AS-08: keys are per buyer: the second buyer uses the first one's key for her own order", async () => {
      const u = await buyer();
      const v = await buyer();
      const key = newKey();
      const a = await pay(u.user, key, body(u.order.orderId));
      const b = await pay(v.user, key, body(v.order.orderId));
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(b.body.paymentId).not.toBe(a.body.paymentId);
      expect(b.headers['idempotency-replayed']).toBeUndefined();
      expect(await paymentCount(t.app)).toBe(2);
    });

    it('S13 AS-09: a failure before a payment exists leaves the key unused; a 5xx releases it; a 202 is final for 24 hours and not after', async () => {
      const { user, order } = await buyer();
      const key = newKey();

      // order cancelled -> 409; the order becomes payable again (newer version) -> the same key gives a fresh 202
      await publishOrderCancelled(t.app, {
        orderId: order.orderId,
        userId: user.id,
        version: 2,
      });
      const refused = await pay(user, key, body(order.orderId));
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('order_not_payable');
      await publishOrderReserved(t.app, {
        orderId: order.orderId,
        userId: user.id,
        version: 3,
        holdSeconds: 3 * 24 * 3600,
      });
      // a malformed body, then a valid one, under the same key
      const invalid = await pay(user, key, { orderId: order.orderId });
      expect(invalid.status).toBe(400);

      // a 5xx before the payment exists releases the key
      const repo = t.app.get<PaymentRepository>(PAYMENT_REPOSITORY, {
        strict: false,
      });
      let failed = false;
      t.patch(
        repo,
        'insertAccepted',
        (original) =>
          (async (...args: Parameters<PaymentRepository['insertAccepted']>) => {
            if (!failed) {
              failed = true;
              throw new Error('database went away');
            }
            return original(...args);
          }) as never,
      );
      const broken = await pay(user, key, body(order.orderId));
      expect(broken.status).toBe(500);
      expect(await paymentCount(t.app)).toBe(0);

      const fresh = await pay(user, key, body(order.orderId));
      expect(fresh.status).toBe(202);
      expect(fresh.headers['idempotency-replayed']).toBeUndefined();

      // final for 24 h ...
      t.clock.advance(DAY - 1_000);
      await t.reauth(user);
      const replay = await pay(user, key, body(order.orderId));
      expect(replay.status).toBe(202);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      // ... and not 24 h and one second after the first answer
      t.clock.advance(2_000);
      await t.reauth(user);
      const later = await pay(user, key, body(order.orderId));
      expect(later.headers['idempotency-replayed']).toBeUndefined();
      expect(later.status).toBe(409);
      expect(later.body.code).toBe('payment_already_exists');
    });
  });

  describe('access and payable orders (AS-10 to AS-13)', () => {
    it("S13 AS-10: no credentials is 401; another buyer's order is 404 order_not_found, identical to an unknown order; nothing is persisted", async () => {
      const { order } = await buyer();
      const stranger = await t.newUser();

      const anonymous = await t
        .http()
        .post('/api/payments/intents')
        .set('Idempotency-Key', newKey())
        .send(body(order.orderId));
      expect(anonymous.status).toBe(401);
      const guest = await t
        .http()
        .post('/api/payments/intents')
        .set('Idempotency-Key', newKey())
        .set('Cookie', 'cart=guest-cart-token')
        .send(body(order.orderId));
      expect(guest.status).toBe(401);

      const foreign = await pay(stranger, newKey(), body(order.orderId));
      const unknown = await pay(stranger, newKey(), body(randomUUID()));
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('order_not_found');
      expect(strip(unknown.body)).toEqual(strip(foreign.body));
      expect(unknown.status).toBe(404);
      expect(await paymentCount(t.app)).toBe(0);
      expect(t.provider.calls).toHaveLength(0);
    }, 30_000);

    it('S13 AS-11: only payable orders: cancelled, paid, expired and the instant of expiry are 409 order_not_payable with a reason; nothing is persisted', async () => {
      const cancelled = await buyer();
      await publishOrderCancelled(t.app, {
        orderId: cancelled.order.orderId,
        userId: cancelled.user.id,
        version: 2,
      });
      const paid = await buyer();
      await publishOrderPaid(t.app, {
        orderId: paid.order.orderId,
        userId: paid.user.id,
        version: 2,
      });
      const justBefore = await buyer();
      const atTheInstant = await buyer();
      const expired = await buyer();

      for (const [b, reason] of [
        [cancelled, 'order_cancelled'],
        [paid, 'order_paid'],
      ] as const) {
        const res = await pay(b.user, newKey(), body(b.order.orderId));
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'order_not_payable', reason });
      }

      // the hold is 900 s: one second before its end the order is payable, at the end it is not
      t.clock.advance(900_000 - 1_000);
      for (const b of [justBefore, atTheInstant, expired])
        await t.reauth(b.user);
      expect(
        (await pay(justBefore.user, newKey(), body(justBefore.order.orderId)))
          .status,
      ).toBe(202);
      t.clock.advance(1_000);
      for (const b of [atTheInstant, expired]) await t.reauth(b.user);
      const exact = await pay(
        atTheInstant.user,
        newKey(),
        body(atTheInstant.order.orderId),
      );
      expect(exact.status).toBe(409);
      expect(exact.body).toMatchObject({
        code: 'order_not_payable',
        reason: 'hold_expired',
      });
      t.clock.advance(60_000);
      await t.reauth(expired.user);
      const late = await pay(
        expired.user,
        newKey(),
        body(expired.order.orderId),
      );
      expect(late.body).toMatchObject({
        code: 'order_not_payable',
        reason: 'hold_expired',
      });
      expect(await paymentCount(t.app)).toBe(1);
    });

    it('S13 AS-12: an order fact that arrives inside the 2 s wait is used; one that never arrives is 404 order_not_found after the wait', async () => {
      const user = await t.newUser();
      const orderId = randomUUID();
      const request = pay(user, newKey(), body(orderId));
      await new Promise((r) => setTimeout(r, 1_000));
      await publishOrderReserved(t.app, { userId: user.id, orderId });
      const late = await request;
      expect(late.status).toBe(202);

      const missing = randomUUID();
      const started = performance.now();
      const none = await pay(user, newKey(), body(missing));
      const waited = performance.now() - started;
      expect(none.status).toBe(404);
      expect(none.body.code).toBe('order_not_found');
      expect(waited).toBeGreaterThanOrEqual(1_900);
      expect(waited).toBeLessThan(5_000);
    }, 30_000);

    it('S13 AS-13: totals outside 1..99,999,999 are 422 amount_out_of_range and unsupported currencies 422 currency_unsupported; nothing is persisted', async () => {
      for (const totalMinor of [0, 100_000_000]) {
        const { user, order } = await buyer({ totalMinor });
        const res = await pay(user, newKey(), body(order.orderId));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('amount_out_of_range');
      }
      // The consumer refuses other currencies (AS-44), so a copy in one can only be corrupt data: seeded directly.
      const jpyUser = await t.newUser();
      const jpy = { user: jpyUser, order: { orderId: randomUUID() } };
      await exec(
        t.app,
        `INSERT INTO "PayableOrder" ("orderId", "userId", "totalMinor", "currency", "status", "reservedUntil", "orderVersion", "updatedAt")
         VALUES (:orderId, :userId, 5000, 'JPY', 'RESERVED', :until, 1, :now)`,
        {
          orderId: jpy.order.orderId,
          userId: jpyUser.id,
          until: new Date(t.clock.now().getTime() + 900_000),
          now: t.clock.now(),
        },
      );
      const res = await pay(jpy.user, newKey(), body(jpy.order.orderId));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('currency_unsupported');
      for (const totalMinor of [1, 99_999_999]) {
        const { user, order } = await buyer({ totalMinor });
        expect((await pay(user, newKey(), body(order.orderId))).status).toBe(
          202,
        );
      }
      expect(await paymentCount(t.app)).toBe(2);
    });
  });

  describe('the rate limit (AS-14)', () => {
    it('S13 AS-14: the 11th request in a minute is 429 with Retry-After and creates nothing', async () => {
      const { user, order } = await buyer();
      for (let i = 0; i < 10; i++) {
        const res = await pay(user, newKey(), { orderId: order.orderId });
        expect(res.status).toBe(400); // counted by the limiter, refused by validation
      }
      const eleventh = await pay(user, newKey(), body(order.orderId));
      expect(eleventh.status).toBe(429);
      expect(eleventh.body.code).toBe('rate_limited');
      expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);
      expect(await paymentCount(t.app)).toBe(0);
    });
  });
});

describe('Payment intents: fail-closed rate limiting (AS-14)', () => {
  it('S13 AS-14: with the limiter store down the request is refused and no payment exists', async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
    const proxy = await TcpFaultProxy.start({
      host: redis.hostname,
      port: Number(redis.port || 6379),
    });
    const t = await createPaymentsApp({
      redisUrl: `redis://127.0.0.1:${proxy.port}/0`,
    });
    try {
      await t.reset();
      const user = await t.newUser();
      const order = await publishOrderReserved(t.app, { userId: user.id });
      proxy.mode = 'refuse';
      proxy.sever();
      await new Promise((r) => setTimeout(r, 300));

      const res = await t
        .as(user)
        .post('/api/payments/intents')
        .set('Idempotency-Key', `key-${randomUUID()}`)
        .send({ orderId: order.orderId, paymentMethodId: 'pm_card_visa' });

      // refused fail closed by whichever guard meets the dead store first (the sensitive-session check or the limiter)
      expect(res.status).toBe(503);
      expect(['rate_limiter_unavailable', 'overloaded']).toContain(
        res.body.code,
      );
      expect(
        await t.app
          .get(RateLimiterService)
          .check('payments.create.user', `user:${user.id}`),
      ).toMatchObject({ allowed: false });
      proxy.mode = 'pass';
      expect(await paymentCount(t.app)).toBe(0);
      expect(t.provider.calls).toHaveLength(0);
    } finally {
      proxy.mode = 'pass';
      await t.close();
      await proxy.close();
    }
  }, 60_000);
});
