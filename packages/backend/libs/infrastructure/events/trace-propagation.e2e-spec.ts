import { v7 as uuidv7 } from 'uuid';
import { waitFor } from '@app/test/utils/async-helpers';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { TopicRegistry } from '@app/infrastructure/events/topic-registry';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import { installTestTracing } from '@app/infrastructure/events/testing/test-tracing';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { OutboxPublisherModule } from '@app/infrastructure/outbox/outbox-publisher.module';
import { OutboxPublisherService } from '@app/infrastructure/outbox/outbox-publisher.service';

const kit = new ConsumerKit();
const tracing = installTestTracing();

describe('Trace propagation from append to the consumer', () => {
  beforeAll(() => kit.start());
  afterAll(async () => {
    await kit.stopAll();
    await tracing.shutdown();
  });

  it("S53 AS-27: the consumer's processing span has the trace ID of the span active at append", async () => {
    const s = await kit.scenario();
    const Inbox = s.make('inbox', 'trace-inbox');
    const app = await s.boot([Inbox], {
      imports: [
        EventsModule,
        OutboxPublisherModule.register({ ticker: false }),
      ],
    });
    const consumer = app.get(Inbox);
    app
      .get(TopicRegistry, { strict: false })
      .register({ aggregateType: s.agg, retention: 'full-history' });
    const outbox = app.get(OutboxService, { strict: false });
    const relay = app.get(OutboxPublisherService, { strict: false });

    const producerTraceId = await tracing.tracer.startActiveSpan(
      'append-under-test',
      async (span) => {
        await outbox.appendStandalone(
          s.ItemChanged.create(uuidv7(), 1, { name: 'traced' }),
        );
        span.end();
        return span.spanContext().traceId;
      },
    );
    await relay.drain();

    const consumerSpans = () =>
      tracing.exporter
        .getFinishedSpans()
        .filter((sp) => sp.name === `project ${consumer.name}`);
    await waitFor(async () => consumerSpans().length > 0, {
      description: 'consumer span finished',
      timeoutMs: 30_000,
    });
    expect(consumerSpans()[0].spanContext().traceId).toBe(producerTraceId);
  });
});
