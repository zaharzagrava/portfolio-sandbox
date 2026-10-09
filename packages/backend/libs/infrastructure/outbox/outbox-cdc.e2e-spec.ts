import { INestApplication, Global, Module } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { ApiConfigService } from '@app/common/config';
import { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createTopics,
  LogMessage,
  readTopic,
} from '@app/test/utils/kafka-test';
import {
  defineEvent,
  useEventClock,
} from '@app/infrastructure/events/define-event';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { TopicRegistry } from '@app/infrastructure/events/topic-registry';
import { OutboxService } from './outbox.service';
import { OutboxPublisherModule } from './outbox-publisher.module';
import { OutboxPublisherService } from './outbox-publisher.service';

/**
 * Needs the opt-in CDC profile (`docker compose -f docker-compose.test.yaml --profile cdc up -d --build`, see
 * infra/debezium/README.md) and `S53_CDC=1`. Without the profile there is no Kafka Connect to talk to; the unit spec
 * `connector-config.spec.ts` (AS-22) still pins the connector configuration.
 */
const cdcUp = process.env.S53_CDC === '1';
const describeCdc = cdcUp ? describe : describe.skip;
const CONNECT = process.env.S53_CONNECT_URL ?? 'http://localhost:8183';

const runId = uuidv7().slice(-8);
const AGG = `cdc${runId}`;
const clock = new FakeClock(new Date('2026-10-09T10:00:00.000Z'));
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: clock }],
  exports: [CLOCK],
})
class TestClockModule {}

const Changed = defineEvent(
  `${AGG}.item_changed`,
  AGG,
  1,
  z.object({ name: z.string() }),
);

describeCdc('Outbox CDC relay equals the poller', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let outbox: OutboxService;
  let relay: OutboxPublisherService;
  let config: MockApiConfigService;

  beforeAll(async () => {
    await createTopics([{ topic: `${AGG}.events` }]);
    const moduleRef = await generateTestingModule(
      [
        TestClockModule,
        EventsModule,
        OutboxPublisherModule.register({ ticker: false }),
      ],
      { customize: (b) => b.overrideProvider(CLOCK).useValue(clock) },
    );
    app = moduleRef.createNestApplication();
    await app.init();
    useEventClock(clock);
    sequelize = app.get(Sequelize);
    outbox = app.get(OutboxService);
    relay = app.get(OutboxPublisherService);
    config = app.get(ApiConfigService) as MockApiConfigService;
    app
      .get(TopicRegistry)
      .register({ aggregateType: AGG, retention: 'full-history' });

    const connector = JSON.parse(
      readFileSync(
        join(__dirname, '../../../../../infra/debezium/outbox-connector.json'),
        'utf8',
      ),
    ) as { name: string; config: unknown };
    const put = await fetch(`${CONNECT}/connectors/${connector.name}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(connector.config),
    });
    expect([200, 201]).toContain(put.status);
    await waitFor(
      async () => {
        const status = (await (
          await fetch(`${CONNECT}/connectors/${connector.name}/status`)
        ).json()) as {
          tasks: { state: string }[];
        };
        return (
          status.tasks.length > 0 &&
          status.tasks.every((t) => t.state === 'RUNNING')
        );
      },
      { timeoutMs: 60_000, description: 'connector tasks running' },
    );
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('S53 AS-21: in cdc mode no poller starts, and the CDC message equals the poller message in topic, key, value and headers', async () => {
    config.set('outbox_relay', 'cdc');
    expect(relay.startTicker()).toBe(false);

    const [a, b] = [uuidv7(), uuidv7()];
    const make = (aggregateId: string) => ({
      ...Changed.create(aggregateId, 1, { name: 'same' }),
      traceparent: TRACEPARENT,
    });
    const viaCdc = make(a);
    await outbox.appendStandalone(viaCdc);

    const fromCdc = await waitFor(
      async () => (await readTopic(`${AGG}.events`)).find((m) => m.key === a),
      { timeoutMs: 60_000, description: 'CDC message on the log' },
    );
    // the row is still pending: CDC does not mark it. Mark it so the poller does not send it a second time.
    await sequelize.query(
      `UPDATE "Outbox" SET "status" = 'published', "publishedAt" = now() WHERE "aggregateId" = $1`,
      { bind: [a] },
    );

    config.set('outbox_relay', 'poller');
    await outbox.appendStandalone(make(b));
    await relay.drain();
    const fromPoller = (await readTopic(`${AGG}.events`)).find(
      (m) => m.key === b,
    )!;

    const normalise = (m: LogMessage, id: string) => ({
      topic: m.topic,
      keyIsAggregateId: m.key === id,
      value: {
        ...m.json<Record<string, unknown>>(),
        eventId: '*',
        aggregateId: '*',
      },
      headers: { ...m.headers, eventId: '*' },
    });
    expect(normalise(fromCdc, a)).toEqual(normalise(fromPoller, b));
    expect(fromCdc.headers.eventId).toBe(viaCdc.eventId);
    expect(Object.keys(fromCdc.headers).sort()).toEqual([
      'eventId',
      'traceparent',
      'type',
      'version',
    ]);
  }, 180_000);
});
