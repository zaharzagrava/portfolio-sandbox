import {
  CreateQueueCommand,
  DeleteQueueCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import { createTopics } from '@app/test/utils/kafka-test';
import { defineEvent } from '@app/infrastructure/events/define-event';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { TopicRegistry } from '@app/infrastructure/events/topic-registry';
import {
  ConsumerKit,
  kitClock,
} from '@app/infrastructure/events/testing/consumer-kit';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { OutboxPublisherModule } from '@app/infrastructure/outbox/outbox-publisher.module';
import { OutboxPublisherService } from '@app/infrastructure/outbox/outbox-publisher.service';
import { SqsTaskQueue } from '@app/infrastructure/sqs/sqs-task-queue';
import { QueueMetricsService } from '@app/infrastructure/sqs/queue-metrics.service';
import { SinkBackpressureError } from './errors';

const ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:9424';
const PREFIX =
  process.env.SQS_QUEUE_URL_PREFIX ?? 'http://localhost:9424/000000000000/';
const sqsConfig = {
  get: (key: string) =>
    ({
      sqs_endpoint: ENDPOINT,
      sqs_queue_url_prefix: PREFIX,
      aws_region: 'eu-central-1',
    })[key],
};
const rawSqs = new SQSClient({
  region: 'eu-central-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

const kit = new ConsumerKit();
const SECRET = 'SECRET-PAYLOAD-VALUE-9f3a';
const EMAIL = 'alice.example@mail.test';
const TOKEN = 'tok_live_51Habcdef';

describe('Metrics and logs of the events and projections framework', () => {
  const lines: string[] = [];
  beforeAll(async () => {
    await kit.start();
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown, ...rest: unknown[]) => {
          lines.push(
            [message, ...rest]
              .map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
              .join(' '),
          );
        });
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await kit.stopAll();
  });

  it('S53 AS-105 + AS-106: a run that publishes, consumes, deduplicates, dead-letters, pauses and parks exposes the metrics, and no log line holds a payload value, token or address', async () => {
    const s = await kit.scenario();
    const Inbox = s.make('inbox', 'obs-inbox');
    const Guard = s.make('versionGuard', 'obs-guard');
    const bigAgg = `kit${s.id}big`;
    const Big = defineEvent(
      `${bigAgg}.blob`,
      bigAgg,
      1,
      z.object({ blob: z.string() }),
    );
    await createTopics([
      {
        topic: `${bigAgg}.events`,
        configEntries: [{ name: 'max.message.bytes', value: '2000' }],
      },
    ]);
    const app = await s.boot([Inbox, Guard], {
      imports: [
        EventsModule,
        OutboxPublisherModule.register({ ticker: false }),
      ],
    });
    const inbox = app.get(Inbox);
    const guard = app.get(Guard);
    const topics = app.get(TopicRegistry, { strict: false });
    topics.register({ aggregateType: s.agg, retention: 'full-history' });
    topics.register({ aggregateType: bigAgg, retention: 'full-history' });
    const outbox = app.get(OutboxService, { strict: false });
    const relay = app.get(OutboxPublisherService, { strict: false });
    const sequelize = app.get(Sequelize);

    // Published through the outbox relay: two good events, one too large for its topic (parked at once).
    const [a, b, big] = [uuidv7(), uuidv7(), uuidv7()];
    await outbox.appendStandalone(
      s.ItemChanged.create(a, 2, { name: 'applied' }),
    );
    await outbox.appendStandalone(
      s.ItemChanged.create(b, 1, { name: 'applied' }),
    );
    await outbox.appendStandalone(
      Big.create(big, 1, { blob: `${SECRET}${'x'.repeat(4_000)}` }),
    );
    await relay.drain();

    // Consumed directly: a duplicate, a stale version, an unknown type, a malformed payload, a failing handler, a pause.
    const dup = s.ItemChanged.create(uuidv7(), 1, { name: 'twice' });
    const stale = s.ItemChanged.create(a, 1, { name: 'older' });
    const unknown = {
      ...s.ItemChanged.create(uuidv7(), 1, { name: 'x' }),
      type: `${s.agg}.something_else`,
    };
    const malformed = {
      ...s.ItemChanged.create(uuidv7(), 1, { name: 'x' }),
      payload: { name: 42, email: EMAIL, secret: SECRET },
    };
    const failing = s.ItemChanged.create(uuidv7(), 1, { name: 'fails' });
    const pausing = s.ItemChanged.create(uuidv7(), 1, { name: 'pauses' });
    inbox.probe.throwBefore.set(failing.eventId, {
      times: -1,
      error: () =>
        new Error(`handler broke on ${EMAIL} with ${TOKEN} and ${SECRET}`),
    });
    guard.probe.throwBefore.set(pausing.eventId, {
      times: 1,
      error: () => new SinkBackpressureError(`store busy for ${EMAIL}`, 50),
    });
    await s.publish([dup, dup]);
    await waitFor(
      async () =>
        MetricsRegistry.value('consumer_events_total', {
          consumer: inbox.name,
          outcome: 'duplicate',
        }) === 1,
      { description: 'inbox duplicate counted', timeoutMs: 30_000 },
    );
    await s.publish([stale, unknown, malformed, failing, pausing] as never[]);

    await waitFor(
      async () =>
        MetricsRegistry.value('consumer_events_total', {
          consumer: inbox.name,
          outcome: 'duplicate',
        }) !== undefined &&
        MetricsRegistry.value('consumer_events_total', {
          consumer: guard.name,
          outcome: 'stale',
        }) !== undefined &&
        MetricsRegistry.value('dlq_total', {
          consumer: inbox.name,
          reason: 'HANDLER_FAILED',
        }) !== undefined &&
        MetricsRegistry.value('consumer_paused_total', {
          consumer: guard.name,
          reason: 'backpressure',
        }) !== undefined,
      {
        description: 'duplicate, stale, dead letter and pause recorded',
        timeoutMs: 60_000,
      },
    ).catch((error) => {
      const seen = [
        'consumer_events_total',
        'dlq_total',
        'consumer_paused_total',
      ].map((n) => [
        n,
        MetricsRegistry.labelSets(n).filter((l) =>
          String(l.consumer).includes(s.id),
        ),
      ]);
      throw new Error(
        `${(error as Error).message}; series: ${JSON.stringify(seen)}`,
      );
    });

    // Task queue gauges: one waiting message, then a consumer that sees it.
    const queue = `s53-obs-${s.id}`;
    await rawSqs.send(new CreateQueueCommand({ QueueName: queue }));
    await rawSqs.send(
      new SendMessageCommand({
        QueueUrl: `${PREFIX}${queue}`,
        MessageBody: '{"n":1}',
      }),
    );
    const queueMetrics = new QueueMetricsService(sqsConfig as never);
    await queueMetrics.refresh();
    const stopConsuming = new SqsTaskQueue(sqsConfig as never).consume(
      queue,
      async () => undefined,
      { waitTimeSec: 1 },
    );
    await waitFor(
      async () =>
        MetricsRegistry.value('task_queue_oldest_message_age_seconds', {
          queue,
        }) !== undefined,
      {
        description: 'queue age recorded',
      },
    );
    await stopConsuming();
    await rawSqs
      .send(new DeleteQueueCommand({ QueueUrl: `${PREFIX}${queue}` }))
      .catch(() => undefined);

    // AS-105: names, meanings, labels.
    const count = async (status: string) =>
      Number(
        (
          (
            await sequelize.query(
              `SELECT count(*) AS n FROM "Outbox" WHERE "status" = $1`,
              { bind: [status] },
            )
          )[0] as {
            n: string;
          }[]
        )[0].n,
      );
    expect(
      MetricsRegistry.value('outbox_published_total', { topic: s.topic }),
    ).toBe(2);
    expect(
      MetricsRegistry.value('outbox_publish_failures_total', {
        topic: `${bigAgg}.events`,
        reason: 'NON_RETRYABLE',
      }),
    ).toBe(1);
    expect(MetricsRegistry.value('outbox_parked')).toBe(await count('parked'));
    expect(MetricsRegistry.value('outbox_pending')).toBe(
      await count('pending'),
    );
    expect(
      MetricsRegistry.value('outbox_oldest_pending_age_seconds'),
    ).toBeGreaterThanOrEqual(0);
    expect(
      MetricsRegistry.value('consumer_events_total', {
        consumer: inbox.name,
        outcome: 'duplicate',
      }),
    ).toBe(1);
    expect(
      MetricsRegistry.value('consumer_events_total', {
        consumer: guard.name,
        outcome: 'stale',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      MetricsRegistry.value('consumer_events_total', {
        consumer: inbox.name,
        outcome: 'applied',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      MetricsRegistry.value('consumer_events_total', {
        consumer: inbox.name,
        outcome: 'ignored',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      MetricsRegistry.value('consumer_events_total', {
        consumer: inbox.name,
        outcome: 'dlq',
      }),
    ).toBeGreaterThanOrEqual(2);
    expect(
      MetricsRegistry.value('dlq_total', {
        consumer: inbox.name,
        reason: 'INVALID_PAYLOAD',
      }),
    ).toBe(1);
    expect(
      MetricsRegistry.value('dlq_total', {
        consumer: inbox.name,
        reason: 'HANDLER_FAILED',
      }),
    ).toBe(1);
    expect(
      MetricsRegistry.histogramValue('projection_lag_seconds', {
        consumer: inbox.name,
      })?.count,
    ).toBeGreaterThanOrEqual(1);
    expect(
      MetricsRegistry.value('task_queue_depth', { queue, state: 'visible' }),
    ).toBe(1);

    const allowed = new Set([
      'consumer',
      'topic',
      'outcome',
      'reason',
      'queue',
      'state',
    ]);
    for (const name of [
      'outbox_published_total',
      'outbox_publish_failures_total',
      'consumer_events_total',
      'consumer_paused_total',
      'dlq_total',
      'projection_lag_seconds',
      'task_queue_depth',
    ])
      for (const labels of MetricsRegistry.labelSets(name))
        for (const [key, value] of Object.entries(labels)) {
          expect(allowed).toContain(key);
          expect(String(value)).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/); // never an ID
        }

    // AS-106: logs.
    const text = lines.join('\n');
    for (const forbidden of [SECRET, EMAIL, TOKEN])
      expect(text).not.toContain(forbidden);
    const deadLetterLine = lines.find((l) => l.includes('HANDLER_FAILED'));
    expect(deadLetterLine).toBeDefined();
    expect(deadLetterLine).toContain(`consumer=${inbox.name}`);
    expect(deadLetterLine).toContain(`topic=${s.topic}`);
    expect(deadLetterLine).toContain(`eventId=${failing.eventId}`);
    expect(deadLetterLine).toMatch(/reasonCode=HANDLER_FAILED/);
    expect(lines.some((l) => l.includes('parked') && !l.includes(SECRET))).toBe(
      true,
    );
    void kitClock;
  }, 120_000);
});
