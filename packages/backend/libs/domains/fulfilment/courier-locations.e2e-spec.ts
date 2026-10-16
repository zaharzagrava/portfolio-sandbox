import { locationBatchResponseSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { CourierTrackProjector } from './infra/courier-track.projector';
import {
  createDeliveryApp,
  type DeliveryTestApp,
  type DeliveryTestCourier,
} from './testing/delivery-fixtures';

const limiterFallbacks = () =>
  MetricsRegistry.value('rate_limit_store_unavailable_total', {
    policy: 'fulfilment.courier-locations',
    fail_mode: 'open',
  }) ?? 0;

describe('Courier location ingest: window, order, shift gating and rate limit', () => {
  let t: DeliveryTestApp;
  let c: DeliveryTestCourier;
  let T: number;

  beforeAll(async () => {
    t = await createDeliveryApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    c = await t.newCourier({ status: 'AVAILABLE' });
    T = t.clock.now().getTime();
  });

  const post = (body: unknown, user = c.user) =>
    t
      .as(user)
      .post('/api/couriers/me/locations')
      .send(body as object);
  const at = (offsetMs: number, lat = 52.52, lng = 13.4) => ({
    lat,
    lng,
    ts: T + offsetMs,
  });

  describe('US1 - batches (AS-03, AS-04)', () => {
    it('S20 AS-03: three unordered points are accepted, the newest is the live position, the courier is searchable, one sorted message is produced and Postgres is not written', async () => {
      const points = [
        at(0, 52.53, 13.41),
        at(-8_000, 52.51, 13.39),
        at(-4_000, 52.52, 13.4),
      ];

      let status = 0;
      let body: unknown;
      const writes = await t.postgresWrites(async () => {
        const res = await post({ points });
        status = res.status;
        body = res.body;
      });

      expect(status).toBe(202);
      expect(locationBatchResponseSchema.parse(body)).toEqual({
        accepted: 3,
        dropped: { stale: 0, future: 0 },
        applied: true,
      });
      expect(writes).toEqual([]);
      expect(await t.livePosition(c.city, c.user.id)).toEqual({
        lat: 52.53,
        lng: 13.41,
        ts: T,
      });
      expect(await t.searchable(c.city)).toEqual([c.user.id]);
      const produced = t.produced(c.user.id);
      expect(produced).toHaveLength(1);
      expect(produced[0].key).toBe(c.city);
      expect(produced[0].envelope.payload).toEqual({
        courierId: c.user.id,
        city: c.city,
        deliveryId: null,
        points: [
          at(-8_000, 52.51, 13.39),
          at(-4_000, 52.52, 13.4),
          at(0, 52.53, 13.41),
        ],
      });
    });

    it('S20 AS-04: a batch whose newest point is older than the live position is accepted, not applied, and still reaches history; the same batch twice changes nothing', async () => {
      await post({ points: [at(0, 52.53, 13.41)] }).expect(202);

      const late = { points: [at(-2_000, 52.5, 13.3)] };
      for (let i = 0; i < 2; i++) {
        const res = await post(late).expect(202);
        expect(res.body).toEqual({
          accepted: 1,
          dropped: { stale: 0, future: 0 },
          applied: false,
        });
      }

      expect(await t.livePosition(c.city, c.user.id)).toEqual({
        lat: 52.53,
        lng: 13.41,
        ts: T,
      });
      const produced = t.produced(c.user.id);
      expect(produced).toHaveLength(3);
      expect(produced[1].envelope.payload).toMatchObject({
        points: [at(-2_000, 52.5, 13.3)],
      });
    });

    it('S20 AS-04: a newer batch moves the live position; an equal timestamp does not', async () => {
      await post({ points: [at(-1_000, 52.5, 13.3)] }).expect(202);
      const newer = await post({ points: [at(0, 52.53, 13.41)] }).expect(202);
      expect(newer.body.applied).toBe(true);
      const equal = await post({ points: [at(0, 52.6, 13.5)] }).expect(202);
      expect(equal.body.applied).toBe(false);
      expect(await t.livePosition(c.city, c.user.id)).toEqual({
        lat: 52.53,
        lng: 13.41,
        ts: T,
      });
    });
  });

  describe('US1 - time window (AS-05)', () => {
    it('S20 AS-05: points exactly 300 000 ms old and 10 000 ms ahead are accepted; one millisecond further is dropped and counted', async () => {
      const res = await post({
        points: [at(-300_000), at(10_000), at(-300_001), at(10_001)],
      }).expect(202);

      expect(res.body).toEqual({
        accepted: 2,
        dropped: { stale: 1, future: 1 },
        applied: true,
      });
      expect(await t.livePosition(c.city, c.user.id)).toMatchObject({
        ts: T + 10_000,
      });
      expect(t.produced(c.user.id)[0].envelope.payload).toMatchObject({
        points: [{ ts: T - 300_000 }, { ts: T + 10_000 }],
      });
    });

    it('S20 AS-05: a batch where every point is dropped is 202 with accepted 0, produces nothing and changes no live state', async () => {
      const res = await post({
        points: [at(-300_001), at(10_001), at(-600_000)],
      }).expect(202);

      expect(res.body).toEqual({
        accepted: 0,
        dropped: { stale: 2, future: 1 },
        applied: false,
      });
      expect(t.produced(c.user.id)).toEqual([]);
      expect(await t.livePosition(c.city, c.user.id)).toBeNull();
      expect(await t.searchable(c.city)).toEqual([]);
    });
  });

  describe('US1 - validation (AS-06)', () => {
    const good = () => at(-1_000);
    it.each([
      ['points missing', {}, 'points'],
      ['points not an array', { points: 'x' }, 'points'],
      ['points empty', { points: [] }, 'points'],
      [
        '21 points',
        {
          points: Array.from({ length: 21 }, (_, i) => ({
            lat: 1,
            lng: 1,
            ts: 1_000 + i,
          })),
        },
        'points',
      ],
      ['lat above 90', { points: [{ ...good(), lat: 90.1 }] }, 'lat'],
      ['lat below -90', { points: [{ ...good(), lat: -90.1 }] }, 'lat'],
      ['lat not a number', { points: [{ ...good(), lat: 'north' }] }, 'lat'],
      ['lat missing', { points: [{ lng: 1, ts: 1_000 }] }, 'lat'],
      ['lng above 180', { points: [{ ...good(), lng: 180.1 }] }, 'lng'],
      ['lng below -180', { points: [{ ...good(), lng: -180.1 }] }, 'lng'],
      ['lng not a number', { points: [{ ...good(), lng: null }] }, 'lng'],
      ['ts not an integer', { points: [{ ...good(), ts: 1.5 }] }, 'ts'],
      ['ts zero', { points: [{ ...good(), ts: 0 }] }, 'ts'],
      ['ts negative', { points: [{ ...good(), ts: -5 }] }, 'ts'],
      ['ts a string', { points: [{ ...good(), ts: '1000' }] }, 'ts'],
      [
        'accuracy negative',
        { points: [{ ...good(), accuracy: -1 }] },
        'accuracy',
      ],
      [
        'accuracy above 10 000',
        { points: [{ ...good(), accuracy: 10_001 }] },
        'accuracy',
      ],
      [
        'courierId on the body',
        { courierId: 'x', points: [good()] },
        'courierId',
      ],
      ['city on the body', { city: 'berlin', points: [good()] }, 'city'],
      [
        'courierId on a point',
        { points: [{ ...good(), courierId: 'x' }] },
        'courierId',
      ],
      ['city on a point', { points: [{ ...good(), city: 'berlin' }] }, 'city'],
      ['unknown field on the body', { points: [good()], extra: 1 }, 'extra'],
      [
        'one bad point among good ones',
        { points: [good(), { ...good(), lat: 100 }] },
        'lat',
      ],
    ])(
      'S20 AS-06: %s is 400 validation_failed naming the field; nothing is stored or produced',
      async (_name, body, field) => {
        const res = await post(body).expect(400);

        expect(res.body.code).toBe('validation_failed');
        expect(JSON.stringify(res.body)).toContain(field);
        expect(t.produced(c.user.id)).toEqual([]);
        expect(await t.livePosition(c.city, c.user.id)).toBeNull();
        expect(await t.searchable(c.city)).toEqual([]);
      },
    );

    it('S20 AS-06: a body above 32 KB is 413 payload_too_large; nothing is stored or produced', async () => {
      const res = await post({
        points: [good()],
        padding: 'x'.repeat(33 * 1024),
      }).expect(413);

      expect(res.body.code).toBe('payload_too_large');
      expect(t.produced(c.user.id)).toEqual([]);
      expect(await t.livePosition(c.city, c.user.id)).toBeNull();
    });

    it('S20 AS-06: 20 points are accepted', async () => {
      const points = Array.from({ length: 20 }, (_, i) =>
        at(-20_000 + i * 1_000),
      );
      const res = await post({ points }).expect(202);
      expect(res.body.accepted).toBe(20);
    });
  });

  describe('US1 - shift gating (AS-07)', () => {
    it('S20 AS-07: a BUSY courier updates its live position and history tagged with the delivery, but is not searchable', async () => {
      const deliveryId = await t.makeBusy(c);

      const res = await post({ points: [at(0)] }).expect(202);

      expect(res.body).toEqual({
        accepted: 1,
        dropped: { stale: 0, future: 0 },
        applied: true,
      });
      expect(await t.livePosition(c.city, c.user.id)).toMatchObject({ ts: T });
      expect(await t.searchable(c.city)).toEqual([]);
      expect(t.produced(c.user.id)[0].envelope.payload).toMatchObject({
        deliveryId,
      });
    });

    it('S20 AS-07: an OFFLINE courier gets accepted 0 with reason off_shift and nothing is stored, indexed or produced', async () => {
      await t
        .as(c.user)
        .put('/api/couriers/me/availability')
        .send({ available: false })
        .expect(200);

      const res = await post({ points: [at(0), at(-400_000)] }).expect(202);

      expect(locationBatchResponseSchema.parse(res.body)).toEqual({
        accepted: 0,
        dropped: { stale: 0, future: 0 },
        applied: false,
        reason: 'off_shift',
      });
      expect(t.produced(c.user.id)).toEqual([]);
      expect(await t.livePosition(c.city, c.user.id)).toBeNull();
      expect(await t.searchable(c.city)).toEqual([]);
    });
  });

  describe('US1 - identity (AS-08)', () => {
    it('S20 AS-08: no credentials is 401', async () => {
      await t
        .http()
        .post('/api/couriers/me/locations')
        .send({ points: [at(0)] })
        .expect(401);
    });

    it('S20 AS-08: a user without a courier profile gets 403 courier_profile_required and nothing is stored', async () => {
      const user = await t.newUser();
      const res = await post({ points: [at(0)] }, user).expect(403);
      expect(res.body.code).toBe('courier_profile_required');
      expect(await t.searchable(c.city)).toEqual([]);
    });

    it('S20 AS-08: the registered city is the one used for the live position and the message key', async () => {
      const other = await t.newCourier({ status: 'AVAILABLE' });
      await post({ points: [at(0)] }, other.user).expect(202);

      expect(await t.livePosition(other.city, other.user.id)).toMatchObject({
        ts: T,
      });
      expect(await t.livePosition(c.city, other.user.id)).toBeNull();
      expect(t.produced(other.user.id)[0]).toMatchObject({ key: other.city });
    });
  });

  describe('US1 - rate limit (AS-09)', () => {
    it('S20 AS-09: the 31st batch in a minute is 429 with Retry-After and is not applied; another courier is unaffected', async () => {
      for (let i = 0; i < 30; i++)
        await post({ points: [at(-30_000 + i)] }).expect(202);

      const limited = await post({ points: [at(0)] }).expect(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(await t.livePosition(c.city, c.user.id)).toMatchObject({
        ts: T - 30_000 + 29,
      });

      const other = await t.newCourier({ status: 'AVAILABLE' });
      await post({ points: [at(0)] }, other.user).expect(202);
    });

    it('S20 AS-09: with the limiter store down the batch is accepted and the fallback is counted', async () => {
      const before = limiterFallbacks();
      t.limiterStoreDown(true);

      const res = await post({ points: [at(0)] }).expect(202);

      expect(res.body.applied).toBe(true);
      expect(limiterFallbacks()).toBeGreaterThan(before);
    });
  });

  describe('US1 - history producer down (AS-12)', () => {
    it('S20 AS-12: with the producer down the answer is 503 location_history_unavailable with a generic detail, the live position is applied, and a resend yields one history record per point', async () => {
      const points = [at(-4_000, 52.51, 13.39), at(0, 52.52, 13.4)];
      t.kafkaProxy.mode = 'refuse';
      t.kafkaProxy.sever();
      await t.app.get(KafkaProducerService).reset('publisher');

      const down = await post({ points }).expect(503);

      expect(down.body.code).toBe('location_history_unavailable');
      expect(down.headers['retry-after']).toBeDefined();
      expect(JSON.stringify(down.body)).not.toMatch(/kafka|broker|redpanda/i);
      expect(await t.livePosition(c.city, c.user.id)).toMatchObject({ ts: T });
      expect(t.produced(c.user.id)).toEqual([]);

      t.kafkaProxy.mode = 'pass';
      const resent = await post({ points }).expect(202);
      expect(resent.body).toEqual({
        accepted: 2,
        dropped: { stale: 0, future: 0 },
        applied: false,
      });
      const produced = t.produced(c.user.id);
      expect(produced).toHaveLength(1);

      const projector = t.app.get(CourierTrackProjector);
      await projector.project([produced[0].envelope, produced[0].envelope]);
      const day = new Date(T).toISOString().slice(0, 10).replace(/-/g, '');
      const items = await t.trackItems(c.user.id, day);
      expect(items.map((i) => i.SK)).toEqual([T - 4_000, T]);
    }, 60_000);
  });
});
