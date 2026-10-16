import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v4 as uuidv4 } from 'uuid';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type {
  CourierVehicle,
  OfferTimeoutMessage,
} from '@marketplace-sandbox/contracts';
import { StoreGuard } from '@app/infrastructure/rate-limit/store-guard';
import { StoreUnavailableError } from '@app/infrastructure/rate-limit/store-guard';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { KAFKA_CLIENT_OVERRIDES } from '@app/infrastructure/kafka/kafka-client.options';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { outboxRowsFor, type OutboxRowView } from '@app/common/testing';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { DeliveryModule } from '../delivery.module';
import { DeliveryProjectorModule } from '../delivery-projector.module';
import { CourierLocationsReported } from '../application/events/courier-events';
import { DispatchService } from '../application/dispatch.service';
import { GEO_INDEX, type GeoIndex } from '../domain/delivery-ports';
import { OFFER_TIMEOUT_QUEUE } from '../infra/dispatch-timers';
import { geoKey } from '../infra/courier-keys';

/**
 * Shared helpers of the S20 e2e specs (courier shift, location ingest, track history, and later dispatch, lifecycle,
 * request, tracking, surge, ownership, order events and observability). Everything here is generic: a spec composes
 * these helpers and adds its own scenario. Users, shops and sessions come from the shared catalog/tenancy fixtures;
 * the tables of this capability (Courier, Delivery, DeliveryOffer, DeliveryEvent) are seeded with explicit SQL
 * because test code may touch every table (IX.6) and the seeders must not depend on the service under test.
 */

/** Berlin: pickup at Alexanderplatz and drop-off about 3 km away. */
export const BERLIN = {
  pickup: { lat: 52.5219, lng: 13.4132 },
  dropoff: { lat: 52.5096, lng: 13.3759 },
};

export interface DeliveryTestCourier {
  user: TestUser;
  city: string;
  vehicle: CourierVehicle;
}

export interface SeedDeliveryInput {
  shopId?: string;
  buyerId?: string;
  orderId?: string;
  city: string;
  status?:
    | 'REQUESTED'
    | 'OFFERED'
    | 'ASSIGNED'
    | 'PICKED_UP'
    | 'DELIVERED'
    | 'CANCELLED';
  courierId?: string | null;
  feeMinor?: number;
  currency?: string;
  /** Attempts consumed so far. Default 0 for `REQUESTED`, 1 otherwise. */
  attempt?: number;
  /** Default: now for `REQUESTED`, now + 15 s for `OFFERED`, none otherwise. */
  nextActionAt?: Date | null;
}

export interface RecordedPush {
  topic: string;
  type: string;
  data: unknown;
  options?: { replay?: boolean };
}

export interface QueuedTimer {
  queue: string;
  body: OfferTimeoutMessage;
  delaySeconds: number | undefined;
}

export interface DeliveryRow {
  id: string;
  shopId: string;
  orderId: string;
  buyerId: string;
  city: string;
  status: string;
  courierId: string | null;
  attempt: number;
  version: number;
  feeMinor: string | number;
  nextActionAt: Date | null;
  cancelReason: string | null;
  orderSyncedStatus: string | null;
}

export interface OfferRow {
  id: string;
  deliveryId: string;
  courierId: string;
  attempt: number;
  status: string;
  offeredAt: Date;
  expiresAt: Date;
  respondedAt: Date | null;
}

export interface HistoryRow {
  from: string | null;
  to: string;
  actorKind: string;
  actorId: string | null;
  detail: string | null;
  version: number;
  at: Date;
}

export type CourierStatusValue = 'OFFLINE' | 'AVAILABLE' | 'BUSY';

export interface DeliveryTestApp extends CatalogTestApp {
  sql<T extends object = Record<string, unknown>>(
    query: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  redis: RedisService;
  /** The live-position / searchable-set adapter, as the services use it. */
  geo: GeoIndex;
  /** Fault proxy in front of the Kafka broker, used by the application's producer only. `refuse` = broker down. */
  kafkaProxy: TcpFaultProxy;

  /** A city slug no other test uses, so Redis keys never meet leftovers of an earlier test. */
  uniqueCity(prefix?: string): string;
  /** A new user, registered as a courier through the API; optionally already on shift. */
  newCourier(options?: {
    city?: string;
    vehicle?: CourierVehicle;
    /** `AVAILABLE` also switches the shift on through the API. Default `OFFLINE`. */
    status?: 'OFFLINE' | 'AVAILABLE';
  }): Promise<DeliveryTestCourier>;
  /** `POST /couriers/me/locations` as `user` with the given points (the server clock is `t.clock`). */
  ping(
    user: TestUser,
    points: { lat: number; lng: number; ts: number; accuracy?: number }[],
  ): ReturnType<ReturnType<CatalogTestApp['as']>['post']>;
  /** A point at the frozen clock plus `offsetMs`, in Berlin. */
  point(
    offsetMs?: number,
    lat?: number,
    lng?: number,
  ): {
    lat: number;
    lng: number;
    ts: number;
  };

  /** Creates a shop and a buyer user to hang seeded deliveries on. */
  seller(): Promise<{ shopId: string; buyer: TestUser }>;
  /** A shop with an OWNER (orders.manage), a VIEWER (read only) and a buyer user. */
  shopMembers(): Promise<{
    shopId: string;
    owner: TestUser;
    viewer: TestUser;
    buyer: TestUser;
  }>;
  /** A courier on shift with a fresh position (`ageMs` old) at `lat`/`lng` (default: the pickup). */
  onShiftCourier(options: {
    city: string;
    lat?: number;
    lng?: number;
    ageMs?: number;
  }): Promise<DeliveryTestCourier>;
  /** A `REQUESTED` delivery with no attempt yet, in the city; returns its id. */
  requested(
    city: string,
    options?: Omit<SeedDeliveryInput, 'city' | 'status'>,
  ): Promise<string>;
  /** Runs the dispatcher for the delivery, as the request path and the timers do. */
  dispatch(deliveryId: string): ReturnType<DispatchService['dispatch']>;

  /** Timer messages the application enqueued (successfully) since the last `reset`. */
  queued(queue?: string): QueuedTimer[];
  /** The next `times` enqueues are refused by the queue (the message is not queued). */
  failEnqueues(times: number): void;
  /** Realtime pushes since the last `reset`, optionally of one topic. */
  pushes(topic?: string): RecordedPush[];
  /**
   * Forces the realtime store down for pushes: `unpublished` is what the real publisher answers on a store fault
   * (`{published: false}`), `throws` is a publisher that rejects; `false` restores. Cleared by `reset`.
   */
  realtimeDown(mode: false | 'unpublished' | 'throws'): void;
  deliveryRow(id: string): Promise<DeliveryRow>;
  offerRows(deliveryId: string): Promise<OfferRow[]>;
  historyRows(deliveryId: string): Promise<HistoryRow[]>;
  outboxRows(deliveryId: string): Promise<OutboxRowView[]>;
  /** Inserts a `Delivery` row (and its creation history row) directly; returns its id. */
  seedDelivery(input: SeedDeliveryInput): Promise<string>;
  /** Inserts a `DeliveryOffer` row. `expiresAt` defaults to the frozen clock + 15 s. */
  seedOffer(input: {
    deliveryId: string;
    courierId: string;
    status?: 'OFFERED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'WITHDRAWN';
    attempt?: number;
    expiresAt?: Date;
  }): Promise<string>;
  /** Makes the courier `BUSY` with a seeded `ASSIGNED` delivery (stored status and the live mirror); returns its id. */
  makeBusy(
    courier: DeliveryTestCourier,
    options?: Pick<
      SeedDeliveryInput,
      'orderId' | 'shopId' | 'buyerId' | 'status'
    >,
  ): Promise<string>;
  /** Gives the courier a live offer on a seeded `OFFERED` delivery; returns the delivery id. */
  giveOffer(
    courier: DeliveryTestCourier,
    options?: { expiresAt?: Date } & Pick<
      SeedDeliveryInput,
      'orderId' | 'shopId' | 'buyerId'
    >,
  ): Promise<string>;

  courierRow(
    id: string,
  ): Promise<
    { id: string; city: string; vehicle: string; status: string } | undefined
  >;
  courierRows(): Promise<number>;
  /** The live position of the courier in the city, or null. */
  livePosition(
    city: string,
    courierId: string,
  ): Promise<{ lat: number; lng: number; ts: number } | null>;
  /** Courier ids in the city's searchable set. */
  searchable(city: string): Promise<string[]>;

  /** Messages the application produced on `courier` for this courier since the last `reset` (passthrough spy). */
  produced(courierId: string): { key: string; envelope: EventEnvelope }[];
  /** Number of write statements (INSERT, UPDATE, DELETE) sent to Postgres while `fn` runs. */
  postgresWrites(fn: () => Promise<unknown>): Promise<string[]>;
  /** Makes the rate limiter's store unavailable (the guard in front of its store call fails); `false` restores. */
  limiterStoreDown(down: boolean): void;

  /** Track items of the courier on a UTC day (`yyyymmdd`), oldest first. */
  trackItems(
    courierId: string,
    day: string,
  ): Promise<Record<string, unknown>[]>;
  /** A contract-valid `courier.locations_reported` envelope. */
  locationsEnvelope(input: {
    courierId: string;
    city?: string;
    deliveryId?: string | null;
    points: { lat: number; lng: number; ts: number; accuracy?: number }[];
  }): EventEnvelope;
}

/** The real `DeliveryModule` and `DeliveryProjectorModule` behind the production HTTP pipeline. */
export async function createDeliveryApp(
  options: Parameters<typeof createCatalogApp>[0] = {},
): Promise<DeliveryTestApp> {
  const kafkaProxy = await TcpFaultProxy.start({
    host: 'localhost',
    port: 9192,
  });
  const base = await createCatalogApp({
    ...options,
    overrides: [
      ...(options.overrides ?? []),
      {
        provide: KAFKA_CLIENT_OVERRIDES,
        useValue: { socketFactory: kafkaProxy.kafkaSocketFactory() },
      },
    ],
    extraImports: [
      DeliveryModule,
      DeliveryProjectorModule,
      ...(options.extraImports ?? []),
    ],
  });
  const app: INestApplication = base.app;
  const sequelize = app.get(Sequelize);
  const redis = app.get(RedisService);
  const dynamo = app.get(DynamoService);
  const geo = app.get<GeoIndex>(GEO_INDEX);
  const producer = app.get(KafkaProducerService);

  const sql = <T extends object = Record<string, unknown>>(
    query: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<T>(query, { type: QueryTypes.SELECT, replacements });

  let sent: { topic: string; key: string; value: EventEnvelope }[] = [];
  const originalSend = producer.send.bind(producer);
  jest.spyOn(producer, 'send').mockImplementation(async (message, opts) => {
    await originalSend(message, opts);
    sent.push(message as never);
  });

  let guardSpy: jest.SpyInstance | undefined;

  // The timer queue and the realtime publisher are spied with pass-through: the real stand-ins still receive the calls.
  let enqueued: QueuedTimer[] = [];
  let enqueueFailures = 0;
  const taskQueue = app.get(TaskQueue);
  const originalEnqueue = taskQueue.enqueue.bind(taskQueue) as (
    queue: string,
    body: unknown,
    options?: { delaySeconds?: number },
  ) => Promise<string>;
  jest.spyOn(taskQueue, 'enqueue').mockImplementation((async (
    queue: string,
    body: unknown,
    options?: { delaySeconds?: number },
  ) => {
    if (enqueueFailures > 0) {
      enqueueFailures--;
      throw new Error('queue refused the message');
    }
    const id = await originalEnqueue(queue, body, options);
    enqueued.push({
      queue,
      body: body as OfferTimeoutMessage,
      delaySeconds: options?.delaySeconds,
    });
    return id;
  }) as never);
  let pushed: RecordedPush[] = [];
  let realtimeFault: false | 'unpublished' | 'throws' = false;
  const publisher = app.get(RealtimePublisher);
  const originalPublish = publisher.publish.bind(publisher) as (
    topic: string,
    type: string,
    data: unknown,
    options?: { replay?: boolean },
  ) => Promise<unknown>;
  jest.spyOn(publisher, 'publish').mockImplementation((async (
    topic: string,
    type: string,
    data: unknown,
    options?: { replay?: boolean },
  ) => {
    pushed.push({ topic, type, data, options });
    if (realtimeFault === 'throws') throw new Error('realtime store is down');
    if (realtimeFault === 'unpublished') return { published: false, id: null };
    return originalPublish(topic, type, data, options);
  }) as never);

  const t: DeliveryTestApp = {
    ...base,
    sql,
    redis,
    geo,
    kafkaProxy,
    uniqueCity: (prefix = 'berlin') => `${prefix}-${uuidv4().slice(0, 6)}`,
    async newCourier(opts = {}) {
      const user = await base.newUser();
      const city = opts.city ?? t.uniqueCity();
      const vehicle = opts.vehicle ?? 'bike';
      const res = await base
        .as(user)
        .post('/api/couriers/me')
        .send({ city, vehicle });
      if (res.status !== 201)
        throw new Error(
          `register courier: ${res.status} ${JSON.stringify(res.body)}`,
        );
      if (opts.status === 'AVAILABLE') {
        const shift = await base
          .as(user)
          .put('/api/couriers/me/availability')
          .send({ available: true });
        if (shift.status !== 200)
          throw new Error(
            `go on shift: ${shift.status} ${JSON.stringify(shift.body)}`,
          );
      }
      return { user, city, vehicle };
    },
    ping: (user, points) =>
      base.as(user).post('/api/couriers/me/locations').send({ points }),
    point: (offsetMs = 0, lat = 52.5219, lng = 13.4132) => ({
      lat,
      lng,
      ts: base.clock.now().getTime() + offsetMs,
    }),
    async seller() {
      const shop = await createShop(app, null);
      return { shopId: shop.id, buyer: await base.newUser() };
    },
    async seedDelivery(input) {
      const shopId = input.shopId ?? (await t.seller()).shopId;
      const buyer = {
        id: input.buyerId ?? (await base.newUser()).id,
      };
      const status = input.status ?? 'REQUESTED';
      const fee = input.feeMinor ?? 499;
      const now = base.clock.now();
      const nextActionAt =
        input.nextActionAt !== undefined
          ? input.nextActionAt
          : status === 'REQUESTED'
            ? now
            : status === 'OFFERED'
              ? new Date(now.getTime() + 15_000)
              : null;
      const [row] = await sql<{ id: string }>(
        `INSERT INTO "Delivery" ("shopId", "orderId", "buyerId", "city", "pickupLat", "pickupLng", "dropoffLat",
           "dropoffLng", "status", "courierId", "attempt", "feeMinor", "currency", "nextActionAt", "version", "createdAt",
           "updatedAt")
         VALUES (:shopId, :orderId, :buyerId, :city, :plat, :plng, :dlat, :dlng, :status, :courierId, :attempt, :fee,
           :currency, :nextActionAt, 1, :now, :now)
         RETURNING "id"`,
        {
          shopId,
          orderId: input.orderId ?? uuidv4(),
          buyerId: buyer.id,
          city: input.city,
          plat: BERLIN.pickup.lat,
          plng: BERLIN.pickup.lng,
          dlat: BERLIN.dropoff.lat,
          dlng: BERLIN.dropoff.lng,
          status,
          courierId: input.courierId ?? null,
          fee,
          currency: input.currency ?? 'EUR',
          attempt: input.attempt ?? (status === 'REQUESTED' ? 0 : 1),
          nextActionAt,
          now,
        },
      );
      await sql(
        `INSERT INTO "DeliveryEvent" ("deliveryId", "from", "to", "actorKind", "version", "at")
         VALUES (:id, NULL, :status, 'system', 1, :now) RETURNING "id"`,
        { id: row.id, status, now: base.clock.now() },
      );
      return row.id;
    },
    async seedOffer(input) {
      const now = base.clock.now();
      const [row] = await sql<{ id: string }>(
        `INSERT INTO "DeliveryOffer" ("deliveryId", "courierId", "attempt", "status", "offeredAt", "expiresAt")
         VALUES (:deliveryId, :courierId, :attempt, :status, :now, :expiresAt) RETURNING "id"`,
        {
          deliveryId: input.deliveryId,
          courierId: input.courierId,
          attempt: input.attempt ?? 1,
          status: input.status ?? 'OFFERED',
          now,
          expiresAt: input.expiresAt ?? new Date(now.getTime() + 15_000),
        },
      );
      return row.id;
    },
    async makeBusy(courier, opts = {}) {
      const deliveryId = await t.seedDelivery({
        ...opts,
        city: courier.city,
        status: opts.status ?? 'ASSIGNED',
        courierId: courier.user.id,
      });
      await sql(
        `UPDATE "Courier" SET "status" = 'BUSY' WHERE "id" = :id RETURNING "id"`,
        {
          id: courier.user.id,
        },
      );
      await geo.setStatus(courier.city, courier.user.id, 'BUSY', deliveryId);
      return deliveryId;
    },
    async giveOffer(courier, opts = {}) {
      const { expiresAt, ...seed } = opts;
      const deliveryId = await t.seedDelivery({
        ...seed,
        city: courier.city,
        status: 'OFFERED',
      });
      await t.seedOffer({
        deliveryId,
        courierId: courier.user.id,
        ...(expiresAt && { expiresAt }),
      });
      return deliveryId;
    },
    async shopMembers() {
      const owner = await base.newUser();
      const viewer = await base.newUser();
      const shop = await createShop(app, owner);
      await addMember(app, shop.id, viewer.id, 'VIEWER');
      return { shopId: shop.id, owner, viewer, buyer: await base.newUser() };
    },
    async onShiftCourier(opts) {
      const courier = await t.newCourier({
        city: opts.city,
        status: 'AVAILABLE',
      });
      const res = await t.ping(courier.user, [
        t.point(
          -(opts.ageMs ?? 0),
          opts.lat ?? BERLIN.pickup.lat,
          opts.lng ?? BERLIN.pickup.lng,
        ),
      ]);
      if (res.status !== 202)
        throw new Error(`ping: ${res.status} ${JSON.stringify(res.body)}`);
      return courier;
    },
    requested: (city, opts = {}) =>
      t.seedDelivery({ ...opts, city, status: 'REQUESTED' }),
    dispatch: (deliveryId) => app.get(DispatchService).dispatch(deliveryId),
    queued: (queue = OFFER_TIMEOUT_QUEUE) =>
      enqueued.filter((m) => m.queue === queue),
    failEnqueues(times) {
      enqueueFailures = times;
    },
    pushes: (topic) => pushed.filter((p) => !topic || p.topic === topic),
    realtimeDown(mode) {
      realtimeFault = mode;
    },
    async deliveryRow(id) {
      return (
        await sql<DeliveryRow>(
          `SELECT "id", "shopId", "orderId", "buyerId", "city", "status", "courierId", "attempt", "version",
                  "feeMinor", "nextActionAt", "cancelReason", "orderSyncedStatus"
             FROM "Delivery" WHERE "id" = :id`,
          { id },
        )
      )[0];
    },
    offerRows: (deliveryId) =>
      sql<OfferRow>(
        `SELECT "id", "deliveryId", "courierId", "attempt", "status", "offeredAt", "expiresAt", "respondedAt"
           FROM "DeliveryOffer" WHERE "deliveryId" = :deliveryId ORDER BY "attempt", "offeredAt", "id"`,
        { deliveryId },
      ),
    historyRows: (deliveryId) =>
      sql<HistoryRow>(
        `SELECT "from", "to", "actorKind", "actorId", "detail", "version", "at"
           FROM "DeliveryEvent" WHERE "deliveryId" = :deliveryId ORDER BY "version", "at", "id"`,
        { deliveryId },
      ),
    outboxRows: (deliveryId) => outboxRowsFor(app, deliveryId),
    async courierRow(id) {
      return (
        await sql<{
          id: string;
          city: string;
          vehicle: string;
          status: string;
        }>(
          `SELECT "id", "city", "vehicle", "status" FROM "Courier" WHERE "id" = :id`,
          { id },
        )
      )[0];
    },
    async courierRows() {
      return (
        await sql<{ n: number }>(`SELECT count(*)::int AS n FROM "Courier"`)
      )[0].n;
    },
    livePosition: (city, courierId) => geo.position(city, courierId),
    searchable: (city) => redis.client.zrange(geoKey(city), 0, -1),
    produced: (courierId) =>
      sent
        .filter(
          (m) =>
            m.topic === CourierLocationsReported.topic &&
            (m.value.payload as { courierId?: string }).courierId === courierId,
        )
        .map((m) => ({ key: m.key, envelope: m.value })),
    async postgresWrites(fn) {
      const writes: string[] = [];
      const original = sequelize.query.bind(sequelize);
      const spy = jest.spyOn(sequelize, 'query').mockImplementation(((
        q: unknown,
        o: unknown,
      ) => {
        const text =
          typeof q === 'string' ? q : ((q as { query?: string }).query ?? '');
        if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)) writes.push(text);
        return (original as (...a: unknown[]) => unknown)(q, o);
      }) as never);
      try {
        await fn();
      } finally {
        spy.mockRestore();
      }
      return writes;
    },
    limiterStoreDown(down) {
      guardSpy?.mockRestore();
      guardSpy = undefined;
      if (down)
        guardSpy = jest
          .spyOn(app.get(StoreGuard), 'run')
          .mockRejectedValue(new StoreUnavailableError('error'));
    },
    async trackItems(courierId, day) {
      const res = await dynamo.doc.send(
        new QueryCommand({
          TableName: dynamo.table('CourierTrack'),
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `COURIER#${courierId}#${day}` },
          ConsistentRead: true,
        }),
      );
      return (res.Items ?? []) as Record<string, unknown>[];
    },
    locationsEnvelope: (input) =>
      CourierLocationsReported.create(input.courierId, 0, {
        courierId: input.courierId,
        city: input.city ?? 'berlin',
        deliveryId: input.deliveryId ?? null,
        points: input.points,
      }),
    async reset() {
      t.limiterStoreDown(false);
      kafkaProxy.mode = 'pass';
      kafkaProxy.delayMs = 0;
      sent = [];
      enqueued = [];
      enqueueFailures = 0;
      pushed = [];
      realtimeFault = false;
      await base.reset();
    },
    async close() {
      t.limiterStoreDown(false);
      await base.close();
      await kafkaProxy.close();
    },
  };
  return t;
}
