import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { OutboxPublisherModule } from './outbox-publisher.module';
import { OutboxPublisherService } from './outbox-publisher.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import Outbox, { KafkaTopicGroup } from './outbox.model';

/**
 * README #1 (outbox under chaos) against the real test Postgres. Kafka is
 * stubbed at the producer so "broker down" is deterministic.
 */
describe('OutboxPublisherService (e2e, real Postgres)', () => {
  let app: INestApplication;
  let seedsService: SeedsService;
  let publisher: OutboxPublisherService;
  let producer: KafkaProducerService;
  let outboxModel: typeof Outbox;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([
      OutboxPublisherModule,
      SeedsModule,
    ]);
    app = moduleRef.createNestApplication();
    await app.init();

    seedsService = app.get(SeedsService);
    publisher = app.get(OutboxPublisherService);
    producer = app.get(KafkaProducerService);
    outboxModel = app.get(getModelToken(Outbox));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedsService.clean();
    jest.restoreAllMocks();
  });

  const seedEvents = (n: number) =>
    seedsService.createTreelike(
      Array.from({ length: n }, (_, i) => ({
        __type__: TableName.Outbox,
        topic: KafkaTopicGroup.PAYMENTS_RESPONSES,
        payload: { idempotency_key: `key-${i}` },
      })),
    );

  it('publishes due rows keyed by idempotency key and marks them published', async () => {
    const sendSpy = jest
      .spyOn(producer, 'send')
      .mockResolvedValue(undefined as never);
    await seedEvents(3);

    await publisher.drain();

    expect(sendSpy).toHaveBeenCalledTimes(3);
    expect(
      sendSpy.mock.calls.map(([arg]) => (arg as { key: string }).key).sort(),
    ).toEqual(['key-0', 'key-1', 'key-2']);
    expect(await outboxModel.count({ where: { publishedAt: null } })).toBe(0);
  });

  it('broker down → rows stay unpublished with attempts incremented and a future nextAttemptAt (nothing lost)', async () => {
    jest
      .spyOn(producer, 'send')
      .mockRejectedValue(new Error('broker unavailable'));
    await seedEvents(2);
    const before = new Date();

    await publisher.drain();

    const rows = await outboxModel.findAll();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.publishedAt).toBeNull();
      expect(row.attempts).toBe(1);
      expect(new Date(row.nextAttemptAt).getTime()).toBeGreaterThan(
        before.getTime(),
      );
    }
  });

  it('recovers: after the broker comes back the same rows are published exactly once', async () => {
    const sendSpy = jest
      .spyOn(producer, 'send')
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(undefined as never);
    await seedEvents(1);

    await publisher.drain(); // fails, schedules retry
    await outboxModel.update({ nextAttemptAt: new Date(0) }, { where: {} }); // make it due now
    await publisher.drain();
    await publisher.drain(); // nothing left

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(await outboxModel.count({ where: { publishedAt: null } })).toBe(0);
  });
});
