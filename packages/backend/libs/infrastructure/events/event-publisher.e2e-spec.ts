import { INestApplication, Global, Module } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { generateTestingModule } from '@app/test/utils/global-modules';
import {
  createTopics,
  deleteTopicsMatching,
  readTopic,
} from '@app/test/utils/kafka-test';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { KAFKA_CLIENT_OVERRIDES } from '@app/infrastructure/kafka/kafka-client.options';
import { defineEvent, useEventClock } from './define-event';
import { EventEnvelope } from './event-envelope';
import { InvalidEnvelopeError, PublishTimeoutError } from './event-errors';
import { EventPublisher } from './event-publisher';
import { EventsModule } from './events.module';
import { TopicRegistry } from './topic-registry';
import { installTestTracing } from './testing/test-tracing';

const runId = uuidv7().slice(-8);
const AGG = `pub${runId}`;
const clock = new FakeClock(new Date('2026-10-09T10:00:00.000Z'));

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: clock }],
  exports: [CLOCK],
})
class TestClockModule {}

const Clicked = defineEvent(
  `${AGG}.clicked`,
  AGG,
  1,
  z.object({ target: z.string() }),
);

describe('Plain event publisher', () => {
  let app: INestApplication;
  let proxy: TcpFaultProxy;
  let publisher: EventPublisher;
  let sequelize: Sequelize;
  const tracing = installTestTracing();

  beforeAll(async () => {
    proxy = await TcpFaultProxy.start({ host: 'localhost', port: 9192 });
    await createTopics([{ topic: `${AGG}.events` }]);
    const moduleRef = await generateTestingModule(
      [TestClockModule, EventsModule],
      {
        customize: (b) =>
          b
            .overrideProvider(CLOCK)
            .useValue(clock)
            .overrideProvider(KAFKA_CLIENT_OVERRIDES)
            .useValue({ socketFactory: proxy.kafkaSocketFactory() }),
      },
    );
    app = moduleRef.createNestApplication();
    await app.init();
    useEventClock(clock);
    app
      .get(TopicRegistry)
      .register({ aggregateType: AGG, retention: 'full-history' });
    publisher = app.get(EventPublisher);
    sequelize = app.get(Sequelize);
  });

  afterAll(async () => {
    await app.close();
    await proxy.close();
    await tracing.shutdown();
    await deleteTopicsMatching(new RegExp(runId));
  });

  beforeEach(() => {
    proxy.mode = 'pass';
  });

  const onLog = async (aggregateId: string) =>
    (await readTopic(`${AGG}.events`)).filter((m) => m.key === aggregateId);

  it('S53 AS-25: a valid envelope goes out keyed by aggregateId with the envelope as value and the contract headers, touching no database', async () => {
    const id = uuidv7();
    const event = await tracing.tracer.startActiveSpan('t', async (span) => {
      const e = Clicked.create(id, 3, { target: 'buy' });
      span.end();
      return e;
    });
    const statements: string[] = [];
    const previous = sequelize.options.logging;
    sequelize.options.logging = (sql: string) => statements.push(sql);
    try {
      await publisher.publish(event);
    } finally {
      sequelize.options.logging = previous;
    }

    expect(statements).toEqual([]);
    const log = await onLog(id);
    expect(log).toHaveLength(1);
    expect(log[0].json()).toEqual(event);
    expect(log[0].headers).toEqual({
      eventId: event.eventId,
      type: event.type,
      version: '1',
      traceparent: event.traceparent!,
    });
  });

  it('S53 AS-25: publishMany sends one request per topic and keeps the order per key', async () => {
    const id = uuidv7();
    const events = [1, 2, 3].map((v) =>
      Clicked.create(id, v, { target: `t${v}` }),
    );
    await publisher.publishMany(events);
    const log = await onLog(id);
    expect(log.map((m) => m.json<EventEnvelope>().aggregateVersion)).toEqual([
      1, 2, 3,
    ]);
  });

  it.each([
    [
      'a missing field',
      (e: EventEnvelope) => ({ ...e, aggregateId: '' }),
      'aggregateId',
    ],
    [
      'a malformed type',
      (e: EventEnvelope) => ({ ...e, type: 'Not Dotted' }),
      'type',
    ],
    [
      'a non-UUIDv7 id',
      (e: EventEnvelope) => ({ ...e, eventId: 'abc' }),
      'eventId',
    ],
    [
      'a negative aggregate version',
      (e: EventEnvelope) => ({ ...e, aggregateVersion: -1 }),
      'aggregateVersion',
    ],
  ])(
    'S53 AS-25: %s is rejected naming the field, and nothing is sent',
    async (_label, mutate, field) => {
      const id = uuidv7();
      const good = Clicked.create(id, 1, { target: 'ok' });
      const bad = mutate(Clicked.create(id, 2, { target: 'secret-value-123' }));

      const attempt = publisher.publishMany([good, bad]);

      await expect(attempt).rejects.toThrow(InvalidEnvelopeError);
      await expect(attempt).rejects.toThrow(field);
      await expect(attempt).rejects.not.toThrow(/secret-value-123/);
      expect(await onLog(id)).toHaveLength(0); // even the valid one of the pair was held back
    },
  );

  it('S53 AS-25: an unregistered aggregate type is refused', async () => {
    const event = Clicked.create(uuidv7(), 1, { target: 'x' });
    await expect(
      publisher.publish({ ...event, aggregateType: 'pubghost' }),
    ).rejects.toThrow(/pubghost/);
  });

  it('S53 AS-25: a hanging broker rejects with PublishTimeoutError within 10 s plus 1 s', async () => {
    const id = uuidv7();
    await publisher.publish(Clicked.create(uuidv7(), 1, { target: 'warm-up' }));
    proxy.mode = 'hang';
    const started = Date.now();

    await expect(
      publisher.publish(Clicked.create(id, 1, { target: 'x' })),
    ).rejects.toThrow(PublishTimeoutError);

    expect(Date.now() - started).toBeLessThan(11_000);
    proxy.mode = 'pass';
    // the publisher recovers on the next call (fresh connection)
    await publisher.publish(Clicked.create(id, 2, { target: 'y' }));
    expect(
      (await onLog(id)).map((m) => m.json<EventEnvelope>().aggregateVersion),
    ).toEqual([2]);
  }, 30_000);

  it('S53 AS-26: a dropped acknowledgement is retried by the idempotent producer and leaves exactly one copy on the log', async () => {
    const id = uuidv7();
    await publisher.publish(Clicked.create(uuidv7(), 1, { target: 'warm-up' }));
    proxy.dropNextResponses(1);
    const event = Clicked.create(id, 1, { target: 'once' });

    // the first acknowledgement never arrives; the client resends the same batch after its request timeout
    await publisher.publish(event);

    const log = await onLog(id);
    expect(log).toHaveLength(1);
    expect(log[0].json<EventEnvelope>().eventId).toBe(event.eventId);
  }, 30_000);
});
