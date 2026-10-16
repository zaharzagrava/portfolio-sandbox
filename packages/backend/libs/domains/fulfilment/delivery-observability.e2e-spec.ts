import { Logger as PinoLogger } from 'nestjs-pino';
import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RequestContext } from '@app/infrastructure/context';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { DispatchService } from './application/dispatch.service';
import { RecoveryService } from './application/recovery.service';
import {
  DELIVERABLE_ORDER_STORE,
  DISPATCH_TIMERS,
  TRACK_STORE,
  type DeliverableOrderStore,
  type DispatchTimers,
  type TrackStore,
} from './domain/delivery-ports';
import { RING_KEY } from './infra/courier-keys';
import { CourierTrackProjector } from './infra/courier-track.projector';
import { DeliveryJobHandlers } from './infra/delivery-job-handlers';
import { FakeOrderFulfilment, fakeOrdersModule } from './testing/fake-orders';
import {
  BERLIN,
  createDeliveryApp,
  type DeliveryTestApp,
  type DeliveryTestCourier,
} from './testing/delivery-fixtures';
import {
  startWorkerInstance,
  type WorkerInstance,
} from './testing/worker-instance';
import { ownerOf } from './domain/dispatcher-ring';

const fakeOrders = new FakeOrderFulfilment();
const OFFER_TTL_MS = 15_000;
const KM = 1 / 111.2;

/** Current value of a series (0 for one that was never touched). */
const metric = (
  name: string,
  labels: Record<string, string | number | boolean> = {},
) => MetricsRegistry.value(name, labels) ?? 0;
const histogramCount = (name: string) =>
  MetricsRegistry.histogramValue(name)?.count ?? 0;
/** Sum of the limiter's decisions that refused the courier location policy. */
const refusedBatches = () =>
  MetricsRegistry.labelSets('rate_limit_decisions_total')
    .filter(
      (l) =>
        l.policy === 'fulfilment.courier-locations' && l.allowed === 'false',
    )
    .reduce((sum, l) => sum + metric('rate_limit_decisions_total', l), 0);

describe('Delivery metrics and logs', () => {
  let t: DeliveryTestApp;
  let dispatch: DispatchService;
  let recovery: RecoveryService;
  let handlers: DeliveryJobHandlers;
  let orders: DeliverableOrderStore;
  let context: RequestContext;
  let stdout: jest.SpyInstance;
  const logChunks: string[] = [];
  let worker: WorkerInstance;

  beforeAll(async () => {
    stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        logChunks.push(String(chunk));
        return true;
      });
    t = await createDeliveryApp({
      structuredLogger: true,
      extraImports: [fakeOrdersModule(fakeOrders)],
    });
    dispatch = t.app.get(DispatchService);
    recovery = t.app.get(RecoveryService);
    handlers = t.app.get(DeliveryJobHandlers);
    orders = t.app.get<DeliverableOrderStore>(DELIVERABLE_ORDER_STORE);
    context = t.app.get(RequestContext);
    worker = await startWorkerInstance(t.clock, fakeOrders);
    // the second app's boot must not take the structured logger away from the services of this one
    Logger.overrideLogger(t.app.get(PinoLogger));
    jest
      .spyOn(worker.app.get<DispatchTimers>(DISPATCH_TIMERS), 'enqueue')
      .mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await worker.close();
    await t.close();
    stdout.mockRestore();
  });
  beforeEach(async () => {
    await t.reset();
    fakeOrders.reset();
  });

  /** Runs `fn` the way a job or a timer does: in its own request context. */
  const inJob = <T>(fn: () => Promise<T>) =>
    context.run({ requestId: `job:${uuidv4()}`, principalType: 'service' }, fn);
  const accept = (c: DeliveryTestCourier, id: string) =>
    t.as(c.user).post(`/api/deliveries/${id}/accept`);
  const decline = (c: DeliveryTestCourier, id: string) =>
    t.as(c.user).post(`/api/deliveries/${id}/decline`);
  const pickedUp = (c: DeliveryTestCourier, id: string) =>
    t.as(c.user).post(`/api/deliveries/${id}/picked-up`);
  const delivered = (c: DeliveryTestCourier, id: string) =>
    t.as(c.user).post(`/api/deliveries/${id}/delivered`);
  const north = (km: number) => BERLIN.pickup.lat + km * KM;
  const logLines = (from = 0) =>
    logChunks
      .join('')
      .slice(from)
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const logLength = () => logChunks.join('').length;

  it('S20 AS-57: offers by outcome, dispatch attempts, give-ups and the time to assignment follow the flows', async () => {
    const city = t.uniqueCity();
    const idle = t.uniqueCity();
    const before = {
      offered: metric('delivery_offers_total', { outcome: 'offered' }),
      accepted: metric('delivery_offers_total', { outcome: 'accepted' }),
      declined: metric('delivery_offers_total', { outcome: 'declined' }),
      expired: metric('delivery_offers_total', { outcome: 'expired' }),
      withdrawn: metric('delivery_offers_total', { outcome: 'withdrawn' }),
      attemptsOffered: metric('delivery_dispatch_attempts_total', {
        city,
        result: 'offered',
      }),
      attemptsNone: metric('delivery_dispatch_attempts_total', {
        city,
        result: 'no_candidate',
      }),
      attemptsIdle: metric('delivery_dispatch_attempts_total', {
        city: idle,
        result: 'no_candidate',
      }),
      giveUps: metric('delivery_give_ups_total', { city }),
      assignments: histogramCount('delivery_request_to_assignment_seconds'),
    };
    const c1 = await t.onShiftCourier({ city, lat: north(0.3) });
    const c2 = await t.onShiftCourier({ city, lat: north(1) });
    const c3 = await t.onShiftCourier({ city, lat: north(2) });

    // d1: offered to c1, declined, offered to c2, accepted (2 offered, 1 declined, 1 accepted)
    const d1 = await t.requested(city);
    await inJob(() => t.dispatch(d1));
    await decline(c1, d1).expect(204);
    await accept(c2, d1).expect(200);
    // d2: offered to c1 and left to lapse (1 offered, 1 expired), then to c3 (1 offered), who goes off shift (withdrawn)
    const d2 = await t.requested(city);
    await inJob(() => t.dispatch(d2));
    t.clock.advance(OFFER_TTL_MS);
    const [offer] = await t.offerRows(d2);
    await inJob(() =>
      dispatch.onTimer({
        deliveryId: d2,
        city,
        courierId: offer.courierId,
        attempt: offer.attempt,
      }),
    );
    const next = (await t.offerRows(d2)).find((o) => o.status === 'OFFERED')!;
    expect(next.courierId).toBe(c3.user.id);
    await t
      .as(c3.user)
      .put('/api/couriers/me/availability')
      .send({ available: false })
      .expect(200);
    // d3: a city without couriers (one attempt consumed with no candidate)
    const d3 = await t.requested(idle);
    await inJob(() => t.dispatch(d3));
    // d4: the last attempt is used up (given up)
    const d4 = await t.requested(city, { attempt: 8 });
    await inJob(() => t.dispatch(d4));

    expect(metric('delivery_offers_total', { outcome: 'offered' })).toBe(
      before.offered + 4,
    );
    expect(metric('delivery_offers_total', { outcome: 'accepted' })).toBe(
      before.accepted + 1,
    );
    expect(metric('delivery_offers_total', { outcome: 'declined' })).toBe(
      before.declined + 1,
    );
    expect(metric('delivery_offers_total', { outcome: 'expired' })).toBe(
      before.expired + 1,
    );
    expect(metric('delivery_offers_total', { outcome: 'withdrawn' })).toBe(
      before.withdrawn + 1,
    );
    expect(
      metric('delivery_dispatch_attempts_total', { city, result: 'offered' }),
    ).toBe(before.attemptsOffered + 4);
    expect(
      metric('delivery_dispatch_attempts_total', {
        city,
        result: 'no_candidate',
      }),
    ).toBe(before.attemptsNone + 1); // d2 after the withdrawal: nobody left
    expect(
      metric('delivery_dispatch_attempts_total', {
        city: idle,
        result: 'no_candidate',
      }),
    ).toBe(before.attemptsIdle + 1);
    expect(metric('delivery_give_ups_total', { city })).toBe(
      before.giveUps + 1,
    );
    expect(histogramCount('delivery_request_to_assignment_seconds')).toBe(
      before.assignments + 1,
    );
    expect((await t.deliveryRow(d4)).status).toBe('CANCELLED');
  });

  it('S20 AS-57: location points by result, rate-limited batches and history failures', async () => {
    const city = t.uniqueCity();
    const courier = await t.newCourier({ city, status: 'AVAILABLE' });
    const offline = await t.newCourier({ city });
    const before = {
      applied: metric('courier_location_points_total', { result: 'applied' }),
      late: metric('courier_location_points_total', { result: 'late' }),
      stale: metric('courier_location_points_total', { result: 'stale' }),
      future: metric('courier_location_points_total', { result: 'future' }),
      offShift: metric('courier_location_points_total', {
        result: 'off_shift',
      }),
      refused: refusedBatches(),
      produce: metric('courier_history_failures_total', { stage: 'produce' }),
      store: metric('courier_history_failures_total', { stage: 'store' }),
    };

    await t.ping(courier.user, [t.point(0)]).expect(202); // applied
    await t.ping(courier.user, [t.point(-1_000)]).expect(202); // late: not newer than the live one
    await t
      .ping(courier.user, [t.point(-10 * 60_000), t.point(60_000)])
      .expect(202); // one stale, one future
    await t.ping(offline.user, [t.point(0), t.point(1)]).expect(202); // off shift
    for (let i = 0; i < 27; i++)
      await t.ping(courier.user, [t.point(1 + i)]).expect(202);
    await t.ping(courier.user, [t.point(100)]).expect(429); // the 31st batch of the minute

    expect(metric('courier_location_points_total', { result: 'applied' })).toBe(
      before.applied + 28,
    );
    expect(metric('courier_location_points_total', { result: 'late' })).toBe(
      before.late + 1,
    );
    expect(metric('courier_location_points_total', { result: 'stale' })).toBe(
      before.stale + 1,
    );
    expect(metric('courier_location_points_total', { result: 'future' })).toBe(
      before.future + 1,
    );
    expect(
      metric('courier_location_points_total', { result: 'off_shift' }),
    ).toBe(before.offShift + 2);
    expect(refusedBatches()).toBe(before.refused + 1);

    // history: the broker is down for one batch; the track store fails for one message
    const other = await t.newCourier({ city, status: 'AVAILABLE' });
    t.kafkaProxy.mode = 'refuse';
    t.kafkaProxy.sever();
    await t.app.get(KafkaProducerService).reset('publisher');
    await t.ping(other.user, [t.point(0)]).expect(503);
    t.kafkaProxy.mode = 'pass';
    await t.ping(other.user, [t.point(1)]).expect(202);
    const [message] = t.produced(other.user.id);
    jest
      .spyOn(t.app.get<TrackStore>(TRACK_STORE), 'putPoints')
      .mockRejectedValueOnce(new Error('store unavailable'));
    await expect(
      t.app.get(CourierTrackProjector).project([message.envelope]),
    ).rejects.toThrow('store unavailable');

    expect(metric('courier_history_failures_total', { stage: 'produce' })).toBe(
      before.produce + 1,
    );
    expect(metric('courier_history_failures_total', { stage: 'store' })).toBe(
      before.store + 1,
    );
  }, 60_000);

  it('S20 AS-57: recovered timers and the order write-back by result', async () => {
    const city = t.uniqueCity();
    await t.onShiftCourier({ city });
    const before = {
      expiry: metric('delivery_recovered_timers_total', {
        kind: 'offer_expiry',
      }),
      retry: metric('delivery_recovered_timers_total', {
        kind: 'dispatch_retry',
      }),
      applied: metric('delivery_order_write_back_total', { result: 'applied' }),
      reached: metric('delivery_order_write_back_total', {
        result: 'already_reached',
      }),
      retried: metric('delivery_order_write_back_total', { result: 'retried' }),
      dead: metric('delivery_order_write_back_total', {
        result: 'dead_lettered',
      }),
    };
    const lapsing = await t.giveOffer(await t.newCourier({ city }), {
      expiresAt: new Date(t.clock.nowMs() + 1_000),
    });
    const waiting = await t.requested(city);
    t.clock.advance(OFFER_TTL_MS);
    await inJob(() => recovery.recoverOverdue(t.clock.now(), null));
    expect(
      metric('delivery_recovered_timers_total', { kind: 'offer_expiry' }),
    ).toBe(before.expiry + 1);
    expect(
      metric('delivery_recovered_timers_total', { kind: 'dispatch_retry' }),
    ).toBe(before.retry + 1);
    expect((await t.deliveryRow(waiting)).status).toBe('OFFERED');
    expect((await t.deliveryRow(lapsing)).status).toBe('REQUESTED');

    const shop = await t.shopMembers();
    const writeBack = async (orderStatus: 'PAID' | 'FULFILLING') => {
      const orderId = uuidv4();
      await orders.applyPaid(
        {
          orderId,
          buyerId: shop.buyer.id,
          shopIds: [shop.shopId],
          currency: 'EUR',
          orderVersion: 4,
        },
        t.clock.now(),
      );
      fakeOrders.setOrder(orderId, orderStatus);
      const courier = await t.newCourier({ city });
      return t.makeBusy(courier, {
        orderId,
        shopId: shop.shopId,
        buyerId: shop.buyer.id,
      });
    };
    const run = (deliveryId: string, isLastAttempt = false) =>
      inJob(() =>
        handlers.applyOrderLifecycle({ deliveryId, status: 'ASSIGNED' }, {
          isLastAttempt,
        } as never),
      );
    await run(await writeBack('PAID')); // applied
    await run(await writeBack('FULFILLING')); // the order is already there
    const flaky = await writeBack('PAID');
    fakeOrders.failNext(1);
    await expect(run(flaky)).rejects.toThrow('order service unavailable'); // retried
    fakeOrders.failNext(1);
    await expect(run(flaky, true)).rejects.toThrow(); // out of attempts

    expect(
      metric('delivery_order_write_back_total', { result: 'applied' }),
    ).toBe(before.applied + 1);
    expect(
      metric('delivery_order_write_back_total', { result: 'already_reached' }),
    ).toBe(before.reached + 1);
    expect(
      metric('delivery_order_write_back_total', { result: 'retried' }),
    ).toBe(before.retried + 1);
    expect(
      metric('delivery_order_write_back_total', { result: 'dead_lettered' }),
    ).toBe(before.dead + 1);
  });

  it('S20 AS-57: hand-backs and dispatch failures are counted per city, and double assignments stay 0', async () => {
    await t.redis.client.del(RING_KEY);
    await worker.heartbeat.beat();
    await t.redis.client.hset(
      RING_KEY,
      'peer-instance',
      String(t.clock.nowMs()),
    );
    const instances = [worker.instanceId, 'peer-instance'];
    const pick = (owner: string) => {
      for (;;) {
        const city = t.uniqueCity();
        if (ownerOf(city, instances) === owner) return city;
      }
    };
    const peerCity = pick('peer-instance');
    const ownCity = pick(worker.instanceId);
    const before = {
      handBacks: metric('delivery_hand_backs_total', { city: peerCity }),
      handBacksOwn: metric('delivery_hand_backs_total', { city: ownCity }),
      failures: metric('delivery_dispatch_failures_total', { city: ownCity }),
      failuresPeer: metric('delivery_dispatch_failures_total', {
        city: peerCity,
      }),
    };
    const message = (city: string) => ({
      deliveryId: uuidv4(),
      city,
      courierId: '',
      attempt: 0,
    });

    await worker.worker.handle(message(peerCity));
    jest
      .spyOn(worker.app.get(DispatchService), 'onTimer')
      .mockRejectedValueOnce(new Error('dispatch broke'));
    await expect(worker.worker.handle(message(ownCity))).rejects.toThrow(
      'dispatch broke',
    );
    await inJob(() => recovery.recoverOverdue(t.clock.now(), null));

    expect(metric('delivery_hand_backs_total', { city: peerCity })).toBe(
      before.handBacks + 1,
    );
    expect(metric('delivery_hand_backs_total', { city: ownCity })).toBe(
      before.handBacksOwn,
    );
    expect(metric('delivery_dispatch_failures_total', { city: ownCity })).toBe(
      before.failures + 1,
    );
    expect(metric('delivery_dispatch_failures_total', { city: peerCity })).toBe(
      before.failuresPeer,
    );
    expect(metric('fulfilment_double_assignments_total')).toBe(0);
  });

  it('S20 AS-57: no metric label carries a delivery, courier, coordinate or address', async () => {
    const city = t.uniqueCity();
    const courier = await t.onShiftCourier({ city });
    const id = await t.requested(city);
    await inJob(() => t.dispatch(id));
    await accept(courier, id).expect(200);

    const labelSets = [
      'delivery_offers_total',
      'delivery_dispatch_attempts_total',
      'delivery_give_ups_total',
      'courier_location_points_total',
      'delivery_recovered_timers_total',
      'delivery_order_write_back_total',
      'delivery_hand_backs_total',
      'delivery_dispatch_failures_total',
      'delivery_push_failures_total',
    ].flatMap((name) => MetricsRegistry.labelSets(name));
    const keys = new Set(labelSets.flatMap((l) => Object.keys(l)));
    const allowed = ['city', 'kind', 'outcome', 'result', 'topic'];
    expect([...keys].filter((key) => !allowed.includes(key))).toEqual([]);
    for (const labels of labelSets)
      for (const value of Object.values(labels))
        expect(String(value)).not.toMatch(
          /[0-9a-f]{8}-[0-9a-f]{4}-|\d+\.\d{3,}/,
        );
  });

  it('S20 AS-57: every delivery log line of the flows has a request or trace id, the ids it knows and no coordinates, addresses or tokens', async () => {
    const start = logLength();
    await t.redis.client.del(RING_KEY); // no ring: this worker handles every city
    const shop = await t.shopMembers();
    const city = t.uniqueCity();
    const courier = await t.onShiftCourier({ city });
    const id = await t.requested(city, {
      shopId: shop.shopId,
      buyerId: shop.buyer.id,
    });
    await inJob(() => t.dispatch(id));
    await accept(courier, id).expect(200);
    t.clock.advance(1_000);
    await t
      .ping(courier.user, [t.point(0, 52.5555555, 13.4444444)])
      .expect(202);
    await pickedUp(courier, id).expect(204);
    await delivered(courier, id).expect(204);
    // a timer and a recovery tick, outside any HTTP request
    const d2 = await t.requested(city);
    await inJob(() => t.dispatch(d2));
    t.clock.advance(OFFER_TTL_MS);
    const [offer] = await t.offerRows(d2);
    await worker.worker.handle({
      deliveryId: d2,
      city,
      courierId: offer.courierId,
      attempt: offer.attempt,
    });
    // failing effects log too: the realtime store is down for one cancel
    t.realtimeDown('unpublished');
    const d3 = await t.requested(city, {
      shopId: shop.shopId,
      buyerId: shop.buyer.id,
    });
    await t
      .as(shop.owner)
      .post(`/api/shops/${shop.shopId}/deliveries/${d3}/cancel`)
      .send({ reason: 'buyer_changed_mind' })
      .expect(200);

    const lines = logLines(start);
    const domain = lines.filter(
      (l) =>
        typeof l.event === 'string' &&
        /^(delivery|courier|dispatcher|surge)\./.test(l.event),
    );
    expect(domain.map((l) => l.event)).toEqual(
      expect.arrayContaining([
        'delivery.offered',
        'delivery.accepted',
        'delivery.picked_up',
        'delivery.delivered',
        'delivery.offer_lapsed',
        'delivery.cancelled',
        'delivery.push_failed',
      ]),
    );
    for (const line of domain)
      expect({ event: line.event, id: line.requestId ?? line.traceId }).toEqual(
        {
          event: line.event,
          id: expect.any(String),
        },
      );
    const withIds = (event: string) => domain.filter((l) => l.event === event);
    for (const event of [
      'delivery.offered',
      'delivery.accepted',
      'delivery.picked_up',
      'delivery.delivered',
    ])
      expect(withIds(event)[0]).toMatchObject({
        deliveryId: id,
        courierId: courier.user.id,
        city,
      });
    expect(withIds('delivery.offer_lapsed')[0]).toMatchObject({
      deliveryId: d2,
      courierId: offer.courierId,
      city,
    });
    expect(withIds('delivery.push_failed')[0]).toMatchObject({
      deliveryId: d3,
      city,
    });

    const raw = JSON.stringify(domain);
    for (const coordinate of [
      '52.5555555',
      '13.4444444',
      String(BERLIN.pickup.lat),
      String(BERLIN.pickup.lng),
      String(BERLIN.dropoff.lat),
      String(BERLIN.dropoff.lng),
    ])
      expect(raw).not.toContain(coordinate);
    expect(raw).not.toMatch(/-?\d{1,3}\.\d{4,}/);
    const everything = lines.map((l) => JSON.stringify(l)).join('\n');
    for (const secret of [courier.user.bearer, shop.owner.bearer])
      expect(everything).not.toContain(secret.replace('Bearer ', ''));
  });
});
