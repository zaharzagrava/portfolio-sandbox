import { INestApplication, Injectable } from '@nestjs/common';
import { Kafka } from 'kafkajs';
import { v4 } from 'uuid';
import { z } from 'zod';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { waitFor } from '@app/test/utils/async-helpers';
import { ApiConfigService } from '@app/common/config';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import { defineEvent } from '@app/infrastructure/events/define-event';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from './projector';
import { ProjectionsModule } from './projections.module';
import { RedisDocSink } from './sinks/redis-doc.sink';
import { ProjectionCheckpoints } from './read-your-writes';

/**
 * F-05 framework against real Redpanda + Redis (docker-compose.test.yaml):
 * version guarding under out-of-order delivery, poison messages to the DLQ,
 * read-your-writes checkpoints.
 */
const runId = v4().slice(0, 8);
const TOPIC = `spec_${runId}.events`;
const GROUP = `spec-projector-${runId}`;

const PriceChanged = defineEvent(
  `spec_${runId}.price_changed`,
  `spec_${runId}`,
  1,
  z.object({ price: z.number().int() }),
);

@Injectable()
class PriceProjector implements Projector {
  readonly name = GROUP;
  readonly topics = [TOPIC];
  readonly coalesce = true;
  failOn?: string;

  constructor(
    private readonly sink: RedisDocSink,
    private readonly checkpoints: ProjectionCheckpoints,
  ) {}

  async project(events: EventEnvelope[]) {
    if (this.failOn && events.some((e) => e.aggregateId === this.failOn))
      throw new Error('poison');
    await this.sink.upsertMany(
      events.map((e) => ({
        key: `spec:price:${e.aggregateId}`,
        version: e.version,
        doc: PriceChanged.match(e)!.payload,
      })),
    );
    await this.checkpoints.record(this.name, events);
  }
}

describe('ProjectionRunner (e2e, real Kafka + Redis)', () => {
  let app: INestApplication;
  let kafka: Kafka;
  let sink: RedisDocSink;
  let projector: PriceProjector;
  let checkpoints: ProjectionCheckpoints;

  const publish = async (envelopes: EventEnvelope[]) => {
    const producer = kafka.producer();
    await producer.connect();
    await producer.send({
      topic: TOPIC,
      messages: envelopes.map((e) => ({
        key: e.aggregateId,
        value: JSON.stringify(e),
      })),
    });
    await producer.disconnect();
  };

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [ProjectionsModule.forProjectors([PriceProjector])],
      { stores: ['redis'] },
    );
    app = moduleRef.createNestApplication();
    kafka = createKafka(app.get(ApiConfigService), 'spec');

    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: TOPIC, numPartitions: 3 }, { topic: `${GROUP}.dlq` }],
    });
    await admin.disconnect();

    await app.init(); // starts the projector (onApplicationBootstrap)

    sink = app.get(RedisDocSink);
    projector = app.get(PriceProjector);
    checkpoints = app.get(ProjectionCheckpoints);
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps the newest version when versions arrive out of order', async () => {
    const productId = v4();
    await publish([
      PriceChanged.create(productId, 3, { price: 300 }),
      PriceChanged.create(productId, 1, { price: 100 }), // late, older
    ]);

    const doc = await waitFor(
      () => sink.get<{ price: number }>(`spec:price:${productId}`),
      { description: 'projected doc' },
    );
    expect(doc).toEqual({ version: 3, doc: { price: 300 } });

    await publish([PriceChanged.create(productId, 2, { price: 200 })]); // still older
    await new Promise((r) => setTimeout(r, 1_000));
    expect(
      (await sink.get<{ price: number }>(`spec:price:${productId}`))!.version,
    ).toBe(3);
  });

  it('read-your-writes: checkpoint reaches the written version', async () => {
    const productId = v4();
    await publish([PriceChanged.create(productId, 7, { price: 700 })]);
    expect(
      await checkpoints.waitFor(GROUP, `spec_${runId}`, productId, 7, 15_000),
    ).toBe(true);
  });

  it('routes a message that keeps failing to <projector>.dlq without blocking the partition', async () => {
    const poisonId = v4();
    const healthyId = v4();
    projector.failOn = poisonId;

    await publish([
      PriceChanged.create(poisonId, 1, { price: 1 }),
      PriceChanged.create(healthyId, 1, { price: 2 }),
    ]);

    await waitFor(() => sink.get(`spec:price:${healthyId}`), {
      description: 'healthy doc despite poison',
      timeoutMs: 30_000,
    });

    const consumer = kafka.consumer({ groupId: `dlq-reader-${runId}` });
    const dlqKeys: string[] = [];
    await consumer.connect();
    await consumer.subscribe({ topic: `${GROUP}.dlq`, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) =>
        void dlqKeys.push(message.key!.toString()),
    });
    await waitFor(async () => dlqKeys.includes(poisonId), {
      description: 'poison in DLQ',
    });
    await consumer.disconnect();

    projector.failOn = undefined;
  });
});
