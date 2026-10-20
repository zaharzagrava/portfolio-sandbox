import { randomUUID } from 'node:crypto';
import {
  problemDetailsSchema,
  voucherPageSchema,
} from '@marketplace-sandbox/contracts';
import { ConsumerPauseFlags } from '@app/infrastructure/projections/consumer-pause';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  BOOKING_VOUCHER_GROUP,
  BOOKING_VOUCHER_QUEUE,
} from './infra/booking-voucher.consumer';
import { VouchersWorkerModule } from './vouchers-core.module';
import {
  createOrdersApp,
  rows,
  type OrdersTestApp,
} from './testing/orders-app';

describe('Orders: booking voucher (J03 G-04, G-44, S10)', () => {
  let t: OrdersTestApp;
  const queue = new InMemoryTaskQueue();

  beforeAll(async () => {
    t = await createOrdersApp({
      extraImports: [SqsModule, VouchersWorkerModule],
      overrides: [{ provide: TaskQueue, useValue: queue }],
    });
  }, 120_000);
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    queue.sent.length = 0;
    queue.deadLettered.length = 0;
    await t.app.get(ConsumerPauseFlags).resume(BOOKING_VOUCHER_GROUP);
  });

  const command = (over: Record<string, unknown> = {}) => {
    const holdId = randomUUID();
    return {
      holdId,
      bookingIds: [randomUUID(), randomUUID()],
      launchEventId: randomUUID(),
      shopId: randomUUID(),
      userId: randomUUID(),
      seatCount: 2,
      dedupeKey: `booking-voucher:${holdId}`,
      ...over,
    };
  };
  const voucherRows = (holdId: string) =>
    rows<{ id: string; seatCount: number; status: string }>(
      t.app,
      `SELECT "id", "seatCount", "status" FROM "Voucher" WHERE "holdId" = :holdId`,
      { holdId },
    );
  const send = async (body: unknown) => {
    await queue.enqueue(BOOKING_VOUCHER_QUEUE, body);
    await queue.drain(BOOKING_VOUCHER_QUEUE);
  };

  it('J03 G-04: a voucher command makes one voucher for the hold, ISSUED, with the seat count', async () => {
    const c = command({ seatCount: 3 });
    await send(c);
    const found = await voucherRows(c.holdId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ seatCount: 3, status: 'ISSUED' });
  });

  it('J03 G-04: the same command delivered twice, and concurrently, leaves one voucher', async () => {
    const c = command();
    await send(c);
    await send(c);
    await Promise.all([send(c), send(c), send(c)]);
    expect(await voucherRows(c.holdId)).toHaveLength(1);
  });

  it('J03 G-04: a body that is not a valid command goes to the dead-letter queue and makes nothing', async () => {
    const before = await rows<{ n: string }>(
      t.app,
      `SELECT count(*)::text AS n FROM "Voucher"`,
    );
    await send({ holdId: 'not-a-uuid', seatCount: 0 });
    await send({ nonsense: true });
    expect(queue.deadLettered).toHaveLength(2);
    expect(queue.deadLettered[0].reason).toBe('SCHEMA_INVALID');
    expect(
      await rows<{ n: string }>(
        t.app,
        `SELECT count(*)::text AS n FROM "Voucher"`,
      ),
    ).toEqual(before);
  });

  it("J03 G-44: GET /orders/vouchers lists the caller's own vouchers, newest first, parsed by the contract", async () => {
    const me = await t.newUser();
    const other = await t.newUser();
    const event = randomUUID();
    const mine = [command({ userId: me.id, launchEventId: event })];
    t.clock.advance(1_000);
    mine.push(command({ userId: me.id, launchEventId: event, seatCount: 1 }));
    for (const c of [...mine, command({ userId: other.id })]) await send(c);

    const res = await t.as(me).get('/api/orders/vouchers').expect(200);
    const page = voucherPageSchema.parse(res.body);
    expect(page.items.map((v) => v.holdId)).toEqual([
      mine[1].holdId,
      mine[0].holdId,
    ]);
    expect(page.items[0]).toMatchObject({
      launchEventId: event,
      seatCount: 1,
      status: 'ISSUED',
    });
    expect(page.nextCursor).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(other.id);
  });

  it('J03 G-44: launchEventId filters, limit and cursor page, and a filter matching nothing is an empty page', async () => {
    const me = await t.newUser();
    const event = randomUUID();
    for (let i = 0; i < 3; i++) {
      await send(command({ userId: me.id, launchEventId: event }));
      t.clock.advance(1_000);
    }
    await send(command({ userId: me.id }));

    const filtered = voucherPageSchema.parse(
      (
        await t
          .as(me)
          .get('/api/orders/vouchers')
          .query({ launchEventId: event })
          .expect(200)
      ).body,
    );
    expect(filtered.items).toHaveLength(3);

    const first = voucherPageSchema.parse(
      (
        await t
          .as(me)
          .get('/api/orders/vouchers')
          .query({ launchEventId: event, limit: 2 })
          .expect(200)
      ).body,
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = voucherPageSchema.parse(
      (
        await t
          .as(me)
          .get('/api/orders/vouchers')
          .query({ launchEventId: event, limit: 2, cursor: first.nextCursor! })
          .expect(200)
      ).body,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((v) => v.voucherId)).toEqual(
      filtered.items.map((v) => v.voucherId),
    );

    const none = await t
      .as(me)
      .get('/api/orders/vouchers')
      .query({ launchEventId: randomUUID() })
      .expect(200);
    expect(none.body).toEqual({ items: [], nextCursor: null });
  });

  it('J03 G-44: another buyer cannot use the cursor; bad input is refused; no token is 401', async () => {
    const me = await t.newUser();
    const other = await t.newUser();
    await send(command({ userId: me.id }));
    await send(command({ userId: me.id }));
    const first = voucherPageSchema.parse(
      (
        await t
          .as(me)
          .get('/api/orders/vouchers')
          .query({ limit: 1 })
          .expect(200)
      ).body,
    );
    const foreign = await t
      .as(other)
      .get('/api/orders/vouchers')
      .query({ cursor: first.nextCursor! })
      .expect(400);
    expect(problemDetailsSchema.parse(foreign.body).code).toBe(
      'invalid_cursor',
    );
    await t.as(me).get('/api/orders/vouchers').query({ limit: 0 }).expect(400);
    await t
      .as(me)
      .get('/api/orders/vouchers')
      .query({ launchEventId: 'nope' })
      .expect(400);
    await t.http().get('/api/orders/vouchers').expect(401);
  });

  it('J03 G-42: while the group is paused the consumer is told to take nothing; resumed, it takes the command', async () => {
    const flags = t.app.get(ConsumerPauseFlags);
    await flags.pause(
      BOOKING_VOUCHER_GROUP,
      randomUUID(),
      new Date().toISOString(),
    );
    expect(await flags.isPaused([BOOKING_VOUCHER_GROUP])).toBe(true);
    await flags.resume(BOOKING_VOUCHER_GROUP);
    expect(await flags.isPaused([BOOKING_VOUCHER_GROUP])).toBe(false);
  });
});
