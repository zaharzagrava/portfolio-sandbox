import { INestApplication, Global, Module } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { createTopics, readTopic } from '@app/test/utils/kafka-test';
import { OrderPaid } from '@app/domains/orders';
import { useEventClock } from '@app/infrastructure/events/define-event';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { TopicRegistry } from '@app/infrastructure/events/topic-registry';
import { parseEnvelope } from '@app/infrastructure/projections/envelope-parser';
import { OutboxService } from './outbox.service';
import { OutboxPublisherModule } from './outbox-publisher.module';
import { OutboxPublisherService } from './outbox-publisher.service';

const clock = new FakeClock(new Date('2026-10-15T10:00:00.000Z'));

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: clock }],
  exports: [CLOCK],
})
class TestClockModule {}

/**
 * J01 G-01: the message on a real topic must parse through the consumers' strict `parseEnvelope` into the typed
 * event, whichever relay produced it. The CDC half uses the value the shipped connector config
 * (`infra/debezium/outbox-connector.json`: EventRouter, `expand.json.payload`, JsonConverter without schemas)
 * emits for an outbox row: the `payload` column as JSON, nothing around it.
 */
describe('Outbox relay shape on the real topic', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let outbox: OutboxService;
  let relay: OutboxPublisherService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([
      TestClockModule,
      EventsModule,
      OutboxPublisherModule.register({ ticker: false }),
    ]);
    app = moduleRef.createNestApplication();
    await app.init();
    useEventClock(clock);
    sequelize = app.get(Sequelize);
    outbox = app.get(OutboxService);
    relay = app.get(OutboxPublisherService);
    app.get(TopicRegistry).ensure({
      aggregateType: 'orders',
      retention: 'full-history',
    });
    await createTopics([{ topic: 'orders.events' }]).catch(() => undefined);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // The Outbox table is shared with every other suite: rows they left pending would fill the relay batch (100) ahead of
    // this test's rows, so they are leased away for an hour before the test appends its own.
    await sequelize.query(
      `UPDATE "Outbox" SET "leaseUntil" = now() + interval '1 hour'
       WHERE "status" = 'pending' AND ("leaseUntil" IS NULL OR "leaseUntil" < now())`,
    );
  });

  const paid = (orderId: string) =>
    OrderPaid.create(orderId, 2, {
      orderId,
      userId: 'u-1',
      orderVersion: 2,
      totalMinor: 3000,
      currency: 'eur',
      paymentRef: 'pay_1',
      paidAt: '2026-10-15T10:00:00.000Z',
      lines: [
        {
          lineId: 'l-1',
          category: 'books',
          productId: 'p-1',
          shopId: 's-1',
          title: 'Book',
          quantity: 1,
          unitPriceMinor: 3000,
          discountMinor: 0,
          lineTotalMinor: 3000,
        },
      ],
      shopOrders: [{ shopOrderId: 'so-1', shopId: 's-1', subtotalMinor: 3000 }],
    });

  it('J01 G-01: a poller message parses through parseEnvelope into the typed order.paid event', async () => {
    const orderId = uuidv7();
    const event = paid(orderId);
    await outbox.appendStandalone(event);
    await relay.drain();

    const message = (await readTopic('orders.events')).find(
      (m) => m.key === orderId,
    );
    expect(message).toBeDefined();
    const parsed = parseEnvelope(
      message!.value === null ? null : Buffer.from(message!.value),
    );
    expect(parsed.ok).toBe(true);
    const typed = OrderPaid.match(
      (parsed as { ok: true; envelope: never }).envelope,
    );
    expect(typed).not.toBeNull();
    expect(typed!.payload.totalMinor).toBe(3000);
    expect(typed!.payload.paymentRef).toBe('pay_1');
  });

  it('J01 G-01: the CDC connector output for the same row (expanded payload) parses to the same typed event', async () => {
    const orderId = uuidv7();
    const event = paid(orderId);
    await outbox.appendStandalone(event);
    // what EventRouter emits: the expanded `payload` column of the outbox row
    const [rows] = await sequelize.query(
      `SELECT "payload" FROM "Outbox" WHERE "aggregateId" = $1`,
      { bind: [orderId] },
    );
    const connectorValue = Buffer.from(
      JSON.stringify((rows as { payload: unknown }[])[0].payload),
    );
    await relay.drain();
    const pollerMessage = (await readTopic('orders.events')).find(
      (m) => m.key === orderId,
    )!;

    const fromCdc = parseEnvelope(connectorValue);
    const fromPoller = parseEnvelope(
      pollerMessage.value === null ? null : Buffer.from(pollerMessage.value),
    );
    expect(fromCdc.ok).toBe(true);
    expect(fromPoller.ok).toBe(true);
    expect((fromCdc as { envelope: unknown }).envelope).toEqual(
      (fromPoller as { envelope: unknown }).envelope,
    );
    expect(
      OrderPaid.match((fromCdc as { ok: true; envelope: never }).envelope),
    ).not.toBeNull();
  });

  it('J01 G-01: a value wrapped as {payload, extra, error} is refused by parseEnvelope', () => {
    const wrapped = Buffer.from(
      JSON.stringify({ payload: paid(uuidv7()), extra: {}, error: null }),
    );
    expect(parseEnvelope(wrapped).ok).toBe(false);
  });
});
