import { Injectable } from '@nestjs/common';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { waitFor } from '@app/test/utils/async-helpers';
import { readTopic } from '@app/test/utils/kafka-test';
import * as backoff from '@app/common/core/backoff';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import { CourierTrackProjector } from './infra/courier-track.projector';
import { DeliveryProjectorModule } from './delivery-projector.module';
import {
  createDeliveryApp,
  type DeliveryTestApp,
} from './testing/delivery-fixtures';

const DAY = '20261016';
const T0 = Date.parse('2026-10-16T10:00:00.000Z');
const point = (offsetMs: number, extra: { accuracy?: number } = {}) => ({
  lat: 52.52,
  lng: 13.4,
  ts: T0 + offsetMs,
  ...extra,
});

describe('Courier track history: consumer idempotency, poison messages and store faults', () => {
  let t: DeliveryTestApp;
  let projector: CourierTrackProjector;
  const kit = new ConsumerKit();

  beforeAll(async () => {
    t = await createDeliveryApp();
    projector = t.app.get(CourierTrackProjector);
    await kit.start();
  });
  afterAll(async () => {
    await kit.stopAll();
    await t.close();
  });
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => t.reset());

  describe('US1 - duplicates (AS-10)', () => {
    it('S20 AS-10: the same message twice, and a point repeated inside a bigger batch, leave three items with their fields and a 90-day expiry', async () => {
      const courierId = uuidv4();
      const deliveryId = uuidv4();
      const first = t.locationsEnvelope({
        courierId,
        deliveryId,
        points: [point(0, { accuracy: 5 }), point(4_000), point(8_000)],
      });
      const bigger = t.locationsEnvelope({
        courierId,
        deliveryId,
        points: [point(4_000), point(8_000), point(8_000)],
      });

      await projector.project([first]);
      await projector.project([first]);
      await projector.project([first, bigger]);

      const items = await t.trackItems(courierId, DAY);
      expect(items).toHaveLength(3);
      expect(items[0]).toMatchObject({
        PK: `COURIER#${courierId}#${DAY}`,
        SK: T0,
        lat: 52.52,
        lng: 13.4,
        accuracy: 5,
        deliveryId,
        expiresAtEpoch: Math.floor(T0 / 1000) + 90 * 86_400,
      });
      expect(items[1]).not.toHaveProperty('accuracy');
      expect(items.map((i) => i.SK)).toEqual([T0, T0 + 4_000, T0 + 8_000]);
    });

    it('S20 AS-10: points of two UTC days go to two partitions; a point without a delivery carries no deliveryId', async () => {
      const courierId = uuidv4();
      const lateEvening = Date.parse('2026-10-16T23:59:58.000Z');
      await projector.project([
        t.locationsEnvelope({
          courierId,
          points: [
            { lat: 1, lng: 2, ts: lateEvening },
            { lat: 1, lng: 2, ts: lateEvening + 4_000 },
          ],
        }),
      ]);

      expect(await t.trackItems(courierId, '20261016')).toHaveLength(1);
      const next = await t.trackItems(courierId, '20261017');
      expect(next).toHaveLength(1);
      expect(next[0]).not.toHaveProperty('deliveryId');
    });
  });

  describe('US1 - store faults (AS-12)', () => {
    it('S20 AS-12: unprocessed items twice are retried with full-jitter backoff and every point is stored once', async () => {
      const courierId = uuidv4();
      const dynamo = t.app.get(DynamoService);
      const original = dynamo.doc.send.bind(dynamo.doc) as (
        c: unknown,
      ) => Promise<unknown>;
      let refused = 0;
      jest.spyOn(dynamo.doc, 'send').mockImplementation((async (
        command: unknown,
      ) => {
        if (command instanceof BatchWriteCommand && refused < 2) {
          refused++;
          return { UnprocessedItems: command.input.RequestItems };
        }
        return original(command);
      }) as never);
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      const sleeps: number[] = [];
      jest.spyOn(backoff, 'sleep').mockImplementation(async (ms) => {
        sleeps.push(ms);
      });

      await projector.project([
        t.locationsEnvelope({
          courierId,
          points: [point(0), point(1_000), point(2_000)],
        }),
      ]);

      expect(refused).toBe(2);
      // full jitter: random() * min(max, base * 2^attempt) with base 50 ms, random pinned at 0.5
      expect(sleeps).toEqual([25, 50]);
      expect(await t.trackItems(courierId, DAY)).toHaveLength(3);
    });

    it('S20 AS-12: when the retries are exhausted the projector throws and nothing is stored', async () => {
      const courierId = uuidv4();
      const dynamo = t.app.get(DynamoService);
      jest.spyOn(dynamo.doc, 'send').mockImplementation((async (
        command: unknown,
      ) => {
        if (command instanceof BatchWriteCommand)
          return { UnprocessedItems: command.input.RequestItems };
        throw new Error('unexpected command');
      }) as never);
      jest.spyOn(backoff, 'sleep').mockResolvedValue(undefined);

      await expect(
        projector.project([
          t.locationsEnvelope({ courierId, points: [point(0)] }),
        ]),
      ).rejects.toThrow(/unprocessed/i);

      jest.restoreAllMocks();
      expect(await t.trackItems(courierId, DAY)).toHaveLength(0);
    });
  });

  describe('US1 - on the real consumer framework (AS-11, AS-12)', () => {
    const boot = async () => {
      const s = await kit.scenario();
      const name = `courier-track-${s.id}`;
      @Injectable()
      class Sub extends (CourierTrackProjector as new (
        ...args: never[]
      ) => CourierTrackProjector) {
        readonly name: string = name;
        readonly topics: string[] = [s.topic];
      }
      const app = await s.boot([Sub as never], {
        imports: [DeliveryProjectorModule],
      });
      const publish = (envelopes: unknown[]) =>
        s.publishRaw(
          envelopes.map((e) => ({
            key: (e as { aggregateId: string }).aggregateId,
            value: JSON.stringify(e),
          })),
        );
      return { app, name, publish, dlq: () => readTopic(`${name}.dlq`) };
    };

    it('S20 AS-11: a bad lat, a missing courierId, a non-integer ts and an unknown version are dead-lettered with a reason; valid siblings are written', async () => {
      const { publish, dlq } = await boot();
      const good = uuidv4();
      const envelope = (courierId: string, points: unknown[]) =>
        t.locationsEnvelope({ courierId, points: points as never });
      const valid1 = envelope(good, [point(0)]);
      const badLat = {
        ...envelope(good, [point(1_000)]),
        payload: {
          courierId: good,
          city: 'berlin',
          deliveryId: null,
          points: [{ lat: 95, lng: 1, ts: T0 }],
        },
      };
      const noCourier = {
        ...envelope(good, [point(2_000)]),
        payload: { city: 'berlin', deliveryId: null, points: [point(2_000)] },
      };
      const badTs = {
        ...envelope(good, [point(3_000)]),
        payload: {
          courierId: good,
          city: 'berlin',
          deliveryId: null,
          points: [{ lat: 1, lng: 1, ts: 1.5 }],
        },
      };
      const unknownVersion = { ...envelope(good, [point(4_000)]), version: 2 };
      const valid2 = envelope(good, [point(5_000)]);

      await publish([valid1, badLat, noCourier, badTs, unknownVersion, valid2]);

      await waitFor(async () => (await dlq()).length === 4, {
        description: 'four dead letters',
      });
      await waitFor(async () => (await t.trackItems(good, DAY)).length === 2, {
        description: 'valid siblings written',
      });
      const letters = await dlq();
      expect(letters.map((l) => l.headers['x-dlq-reason-code']).sort()).toEqual(
        [
          'INVALID_PAYLOAD',
          'INVALID_PAYLOAD',
          'INVALID_PAYLOAD',
          'UNSUPPORTED_VERSION',
        ],
      );
      for (const letter of letters)
        expect(letter.headers['x-dlq-reason']).toBeTruthy();
      expect((await t.trackItems(good, DAY)).map((i) => i.SK)).toEqual([
        T0,
        T0 + 5_000,
      ]);
    }, 120_000);

    it('S20 AS-12: a message whose store retries are exhausted is dead-lettered whole, nothing partial is stored, and the next message is processed once the store recovers', async () => {
      const { app, publish, dlq } = await boot();
      const courierId = uuidv4();
      const doomed = t.locationsEnvelope({
        courierId,
        points: [point(0), point(1_000)],
      });
      const dynamo = app.get(DynamoService);
      const original = dynamo.doc.send.bind(dynamo.doc) as (
        c: unknown,
      ) => Promise<unknown>;
      let failing = true;
      jest.spyOn(dynamo.doc, 'send').mockImplementation((async (
        command: unknown,
      ) => {
        if (failing && command instanceof BatchWriteCommand)
          return { UnprocessedItems: command.input.RequestItems };
        return original(command);
      }) as never);
      jest.spyOn(Math, 'random').mockReturnValue(0);

      await publish([doomed]);
      await waitFor(async () => (await dlq()).length === 1, {
        description: 'one dead letter',
      });
      expect((await dlq())[0].headers['x-dlq-reason-code']).toBe(
        'HANDLER_FAILED',
      );
      expect(await t.trackItems(courierId, DAY)).toHaveLength(0);

      failing = false;
      await publish([
        t.locationsEnvelope({ courierId, points: [point(2_000)] }),
      ]);
      await waitFor(
        async () => (await t.trackItems(courierId, DAY)).length === 1,
        { description: 'next message stored' },
      );
      expect((await dlq()).length).toBe(1);
    }, 120_000);
  });
});
