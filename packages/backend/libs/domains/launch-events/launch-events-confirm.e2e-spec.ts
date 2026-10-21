import { v4 } from 'uuid';
import { DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  confirmResponseSchema,
  bookingVoucherRequestedSchema,
  launchEventEventSchemas,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { hasSeat } from './domain/seat-bitmap';
import { HOLD_LEDGER, type HoldLedger } from './domain/ports';
import { LaunchEventsModule } from './launch-events.module';
import {
  MINUTE,
  SECOND,
  createLaunchApp,
  expectContract,
  expectProblem,
  type LaunchTestApp,
  type Seller,
} from './testing/launch-events-test-kit';

/** Runs the rounds of a repeated test five at a time (each round uses data of its own). */
const eachRound = async (
  rounds: number,
  body: (round: number) => Promise<void>,
  size = 5,
): Promise<void> => {
  for (let from = 0; from < rounds; from += size)
    await Promise.all(
      Array.from({ length: Math.min(size, rounds - from) }, (_, k) =>
        body(from + k),
      ),
    );
};

const FAST = { admissionRatePerSec: 100_000 };
const pad = (seat: number) => String(seat).padStart(6, '0');

jest.setTimeout(180_000); // the suites create hundreds of people through the real stores

describe('Launch events: booking confirmation, idempotency and recovery', () => {
  let t: LaunchTestApp;
  let s: Seller;
  beforeAll(async () => {
    t = await createLaunchApp();
    s = await t.seller();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const store of Object.values(t.stores)) {
      store.up();
      store.failing.clear();
    }
    t.published.length = 0;
  });

  const ledger = () =>
    t.app.select(LaunchEventsModule).get<HoldLedger>(HOLD_LEDGER);
  const sale = (overrides: Record<string, unknown> = {}) =>
    t.onSale(s, { ...FAST, ...overrides });
  const count = async (
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => Number((await t.rows<{ n: string }>(sql, replacements))[0].n);
  const bookingsOf = (holdId: string) =>
    count(
      `SELECT count(*)::text AS n FROM "Booking" WHERE "holdId" = :holdId`,
      { holdId },
    );
  const historyOf = (holdId: string) =>
    count(
      `SELECT count(*)::text AS n FROM "BookingEvent" WHERE "holdId" = :holdId`,
      { holdId },
    );
  const doubleBooked = () =>
    count(
      `SELECT count(*)::text AS n FROM (SELECT 1 FROM "Booking" WHERE "status" = 'CONFIRMED' GROUP BY "eventId", "seat" HAVING count(*) > 1) d`,
    );
  /** A buyer with a live hold on `seats`. */
  const holding = async (event: { id: string }, seats: number[]) => {
    const who = await t.buyer();
    const hold = await t.held(event, who, seats);
    return { who, hold };
  };
  const mapShows = async (event: { id: string }, seat: number) =>
    hasSeat(
      Buffer.from(
        (
          await t
            .http()
            .get(`/api/launch-events/${event.id}/seatmap`)
            .expect(200)
        ).body.bitmap,
        'base64',
      ),
      seat,
    );
  const eventRows = async (aggregateId: string, type: string) =>
    (await t.outbox(aggregateId)).filter((r) => r.type === type);

  // ------------------------------------------------------------------------------------------------- AS-33

  it('S22 AS-33: confirm writes the bookings, history, event and voucher command in one transaction, with no store call inside', async () => {
    const event = await sale();
    const { who, hold } = await holding(event, [42, 43]);
    await t.http().get(`/api/launch-events/${event.id}/seatmap`).expect(200); // the map exists: its deltas are published
    t.published.length = 0;
    t.callLog.length = 0;

    const res = await t.confirm(hold.holdId, who).expect(201);
    const body = expectContract(confirmResponseSchema, res.body);
    expect(body.bookings.map((b) => b.seat)).toEqual([42, 43]);
    expect(body.confirmedAt).toBe(new Date(t.clock.nowMs()).toISOString());

    const rows = await t.rows<{ id: string; status: string; seat: number }>(
      `SELECT "id", "status", "seat" FROM "Booking" WHERE "holdId" = :id ORDER BY "seat"`,
      { id: hold.holdId },
    );
    expect(rows.map((r) => [r.seat, r.status])).toEqual([
      [42, 'CONFIRMED'],
      [43, 'CONFIRMED'],
    ]);
    expect(await historyOf(hold.holdId)).toBe(2);
    const confirmed = await eventRows(
      hold.holdId,
      'launchevents.booking_confirmed',
    );
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      kind: 'event',
      topic: 'launch_events.events',
      aggregateType: 'launch_events',
    });
    expect(
      launchEventEventSchemas['launchevents.booking_confirmed'].parse(
        (confirmed[0].payload as { payload: unknown }).payload,
      ),
    ).toMatchObject({
      holdId: hold.holdId,
      userId: who.id,
      seats: [42, 43],
      bookingIds: rows.map((r) => r.id),
    });
    const commands = (await t.outbox(hold.holdId)).filter(
      (r) => r.kind === 'task',
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      topic: 'orders-booking-voucher-requested',
      type: 'orders.booking_voucher_requested',
    });
    expect(
      bookingVoucherRequestedSchema.parse(
        (commands[0].payload as { body: unknown }).body,
      ),
    ).toMatchObject({
      holdId: hold.holdId,
      seatCount: 2,
      dedupeKey: `booking-voucher:${hold.holdId}`,
    });

    expect((await ledger().get(hold.holdId))!.state).toBe('CONFIRMED');
    const seatRecords = (await ledger().records(event.id)).filter(
      (r) => r.holdId === hold.holdId,
    );
    expect(
      seatRecords.every(
        (r) =>
          r.state === 'CONFIRMED' && r.expiresAtMs === Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(true);
    expect(await mapShows(event, 42)).toBe(true);
    expect(
      t.published.find(
        (p) => (p.data as { change?: string }).change === 'booked',
      ),
    ).toMatchObject({
      data: { seats: [42, 43] },
    });
    await t
      .hold(event, who, await t.admit(event, who), { seats: [50] })
      .expect(422); // the quota still counts the seats

    // no Redis, Dynamo, token or queue call between the begin and the end of the transaction
    const begin = t.callLog.indexOf('tx:begin');
    const end = t.callLog.lastIndexOf('tx:end');
    expect(begin).toBeGreaterThanOrEqual(0);
    const inside = t.callLog
      .slice(begin, end + 1)
      .filter(
        (c) =>
          !c.startsWith('events.') &&
          !c.startsWith('bookings.') &&
          !c.startsWith('tx:'),
      );
    expect(inside).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------------- AS-34

  it('S22 AS-34: a replayed key returns the stored answer; a new key on a confirmed hold answers 200 with the same bookings', async () => {
    const event = await sale({ perUserLimit: 3 });
    const { who, hold } = await holding(event, [1, 2]);
    const key = `key-${v4()}`;
    const first = await t.confirm(hold.holdId, who, key).expect(201);
    const events = (await t.outbox(hold.holdId)).length;

    const replay = await t.confirm(hold.holdId, who, key).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const natural = await t.confirm(hold.holdId, who).expect(200);
    expect(natural.body).toEqual(first.body);
    expect(await bookingsOf(hold.holdId)).toBe(2);
    expect((await t.outbox(hold.holdId)).length).toBe(events);

    // the same key on another hold of the same buyer is a reuse (keys are scoped per buyer)
    const second = await t
      .hold(event, who, await t.admit(event, who), { seats: [3] })
      .expect(201);
    const reuse = await t.confirm(second.body.holdId, who, key).expect(422);
    expect(reuse.body.code).toBe('idempotency_key_reuse');
  });

  it('S22 AS-34: the key is required and checked; concurrent duplicates with one key confirm once', async () => {
    const event = await sale();
    const { who, hold } = await holding(event, [4]);
    const noKey = await t
      .http()
      .post(`/api/launch-holds/${hold.holdId}/confirm`)
      .set(who.auth)
      .send({})
      .expect(422);
    expect(noKey.body.code).toBe('idempotency_key_required');
    const key = `key-${v4()}`;
    const race = await Promise.all(
      Array.from({ length: 5 }, () => t.confirm(hold.holdId, who, key)),
    );
    race
      .filter((r) => ![200, 201].includes(r.status))
      .forEach((r) => expect(r.body.code).toBe('idempotency_in_flight'));
    expect(
      race.filter((r) => [200, 201].includes(r.status)).length,
    ).toBeGreaterThanOrEqual(1);
    expect(await bookingsOf(hold.holdId)).toBe(1);
    expect(
      await eventRows(hold.holdId, 'launchevents.booking_confirmed'),
    ).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------------------------- AS-35

  it('S22 AS-35: ten confirms at once make one set of bookings, one event and one voucher command (20 runs)', async () => {
    const event = await sale();
    // Sequential: the rounds share one event, and admitting a person admits the whole waiting queue of the event, so
    // rounds side by side take each other's place ("not admitted").
    for (let run = 0; run < 20; run++) {
      const { who, hold } = await holding(event, [run * 2, run * 2 + 1]);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => t.confirm(hold.holdId, who)),
      );
      results.forEach((r) => expect([200, 201]).toContain(r.status));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const ids = results.map((r) => JSON.stringify(r.body.bookings));
      expect(new Set(ids).size).toBe(1);
      expect(await bookingsOf(hold.holdId)).toBe(2);
      expect(
        await eventRows(hold.holdId, 'launchevents.booking_confirmed'),
      ).toHaveLength(1);
      expect(
        (await t.outbox(hold.holdId)).filter((r) => r.kind === 'task'),
      ).toHaveLength(1);
    }
  });

  // ------------------------------------------------------------------------------------------------- AS-36

  it('S22 AS-36: confirm racing the expiry job gives exactly one outcome per hold, never a booking on a freed seat (20 runs)', async () => {
    const event = await sale();
    for (let run = 0; run < 20; run++) {
      const { who, hold } = await holding(event, [run]);
      const expiresAt = Date.parse(hold.expiresAt);
      await t.setTime(new Date(expiresAt + (run % 2 === 0 ? -1 : 0)));
      const [confirm] = await Promise.all([
        t.confirm(hold.holdId, who),
        t.jobs.expireHold({ holdId: hold.holdId }),
      ]);
      const booked = await bookingsOf(hold.holdId);
      const state = (await ledger().get(hold.holdId))!.state;
      if (confirm.status === 201) {
        expect({ booked, state }).toEqual({ booked: 1, state: 'CONFIRMED' });
      } else {
        expect(confirm.status).toBe(409);
        expect(confirm.body.code).toBe('HOLD_EXPIRED');
        expect({ booked, state }).toEqual({ booked: 0, state: 'EXPIRED' });
        expect(
          (await ledger().records(event.id)).filter(
            (r) => r.seat === run && r.state === 'HELD',
          ),
        ).toHaveLength(0);
      }
    }
    expect(await doubleBooked()).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------- AS-37

  it('S22 AS-37: illegal transitions answer their own conflict code', async () => {
    const event = await sale();
    // expired: the job ran
    const expired = await holding(event, [1]);
    await t.advance(10 * MINUTE);
    await t.jobs.expireHold({ holdId: expired.hold.holdId });
    expect(
      (await t.confirm(expired.hold.holdId, expired.who).expect(409)).body.code,
    ).toBe('HOLD_EXPIRED');
    await t.release(expired.hold.holdId, expired.who).expect(204);

    // expired by the clock although no job ran: the confirm frees the seats
    const lapsed = await holding(event, [2]);
    await t.advance(10 * MINUTE);
    expect(
      (await t.confirm(lapsed.hold.holdId, lapsed.who).expect(409)).body.code,
    ).toBe('HOLD_EXPIRED');
    expect(
      (await ledger().records(event.id)).filter(
        (r) => r.seat === 2 && r.state === 'HELD',
      ),
    ).toHaveLength(0);

    // released
    const released = await holding(event, [3]);
    await t.release(released.hold.holdId, released.who).expect(204);
    expect(
      (await t.confirm(released.hold.holdId, released.who).expect(409)).body
        .code,
    ).toBe('HOLD_RELEASED');
    await t.release(released.hold.holdId, released.who).expect(204);

    // confirmed: release is refused and the booking stays
    const done = await holding(event, [4]);
    await t.confirm(done.hold.holdId, done.who).expect(201);
    expect(
      (await t.release(done.hold.holdId, done.who).expect(409)).body.code,
    ).toBe('HOLD_ALREADY_CONFIRMED');
    expect(await bookingsOf(done.hold.holdId)).toBe(1);

    // closed event
    const open = await holding(event, [5]);
    await t
      .http()
      .post(`/api/shops/${s.shopId}/launch-events/${event.id}/close`)
      .set(s.auth)
      .expect(200);
    expect(
      (await t.confirm(open.hold.holdId, open.who).expect(409)).body.code,
    ).toBe('EVENT_CLOSED');
    expect(await bookingsOf(open.hold.holdId)).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------- AS-38

  it('S22 AS-38: when the ledger fails and two holds own one seat, the database books it once (20 runs)', async () => {
    const dynamo = t.app.get(DynamoService);
    const redis = t.app.get(RedisService).client;
    const event = await sale({ perUserLimit: 2 });
    // Sequential: the rounds share one event, and admitting a person admits the whole waiting queue of the event, so
    // rounds side by side take each other's place ("not admitted").
    for (let run = 0; run < 20; run++) {
      const seat = 7 + run * 2;
      const a = await holding(event, [seat]);
      // a fault wipes the ledger record and the lock of the seat: a second hold takes it
      await dynamo.doc.send(
        new DeleteCommand({
          TableName: dynamo.table('Holds'),
          Key: { PK: `EVENT#${event.id}`, SK: `SEAT#${pad(seat)}` },
        }),
      );
      await redis.del(`sl:{${event.id}}:${seat}`);
      const b = await t.buyer();
      const tokenB = await t.admit(event, b);
      const holdB = await t
        .hold(event, b, tokenB, { seats: [seat, seat + 1] })
        .expect(201);

      const [first, second] = await Promise.all([
        t.confirm(a.hold.holdId, a.who),
        t.confirm(holdB.body.holdId, b),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      const loser = first.status === 409 ? first : second;
      expect(loser.body).toMatchObject({ code: 'SEAT_TAKEN', seat });
      const loserHold =
        first.status === 409 ? a.hold.holdId : holdB.body.holdId;
      expect(await bookingsOf(loserHold)).toBe(0); // a multi-seat confirm with one booked seat writes nothing
      expect(await doubleBooked()).toBe(0);
    }
  });

  // ------------------------------------------------------------------------------------------------- AS-39

  it("S22 AS-39: confirm and release of somebody else's hold look exactly like an unknown hold", async () => {
    const event = await sale();
    const a = await holding(event, [1]);
    const b = await t.buyer();
    const own = await t.confirm(v4(), b).expect(404);
    const confirm = await t.confirm(a.hold.holdId, b).expect(404);
    const release = await t.release(a.hold.holdId, b).expect(404);
    const unknownRelease = await t.release(v4(), b).expect(404);
    for (const res of [own, confirm, release, unknownRelease]) {
      const p = expectProblem(res.body);
      expect({
        code: p.code,
        status: p.status,
        title: p.title,
        detail: p.detail,
      }).toEqual({
        code: 'HOLD_NOT_FOUND',
        status: 404,
        title: 'Not found',
        detail: 'Hold not found.',
      });
    }
    expect((await ledger().get(a.hold.holdId))!.state).toBe('HELD');
    await t.confirm(a.hold.holdId, a.who).expect(201); // the session alone is enough
  });

  // ------------------------------------------------------------------------------------------------- AS-40

  it('S22 AS-40: the hold id must be a UUID and the body empty', async () => {
    const event = await sale();
    const a = await holding(event, [1]);
    const bad = await t
      .http()
      .post('/api/launch-holds/nope/confirm')
      .set(a.who.auth)
      .set('Idempotency-Key', `k-${v4()}`)
      .send({})
      .expect(400);
    expect(bad.body.code).toBe('validation_failed');
    await t.confirm(v4(), a.who).expect(404);
    const body = await t
      .http()
      .post(`/api/launch-holds/${a.hold.holdId}/confirm`)
      .set(a.who.auth)
      .set('Idempotency-Key', `k-${v4()}`)
      .send({ extra: 1 })
      .expect(400);
    expect(body.body.code).toBe('validation_failed');
    await t.http().delete('/api/launch-holds/nope').set(a.who.auth).expect(400);
  });

  // ------------------------------------------------------------------------------------------------- AS-41

  it('S22 AS-41: a fault before the booking is written answers 5xx and the retry with the same key books once', async () => {
    const event = await sale();
    const { who, hold } = await holding(event, [1, 2]);
    const key = `key-${v4()}`;
    t.stores.bookings.failing.add('insertConfirmed');
    const failed = await t.confirm(hold.holdId, who, key);
    expect(failed.status).toBe(500);
    expect(expectProblem(failed.body).detail).not.toMatch(
      /insertConfirmed|down/,
    );
    expect(await bookingsOf(hold.holdId)).toBe(0);
    expect((await ledger().get(hold.holdId))!.state).toBe('HELD');
    t.stores.bookings.failing.clear();

    await t.confirm(hold.holdId, who, key).expect(201);
    expect(await bookingsOf(hold.holdId)).toBe(2);
  });

  it('S22 AS-41: the reconciler finishes a confirmation the crash cut short and releases a confirmation without a booking', async () => {
    const event = await sale();
    const dynamo = t.app.get(DynamoService);
    // (a) booking exists, ledger still shows the hold sealed and the seats held, the map shows nothing
    const a = await holding(event, [10]);
    await t.confirm(a.hold.holdId, a.who).expect(201);
    await dynamo.doc.send(
      new UpdateCommand({
        TableName: dynamo.table('Holds'),
        Key: { PK: `HOLD#${a.hold.holdId}`, SK: 'META' },
        UpdateExpression: 'SET #st = :s',
        ExpressionAttributeNames: { '#st': 'state' },
        ExpressionAttributeValues: { ':s': 'CONFIRMING' },
      }),
    );
    await dynamo.doc.send(
      new UpdateCommand({
        TableName: dynamo.table('Holds'),
        Key: { PK: `EVENT#${event.id}`, SK: `SEAT#${pad(10)}` },
        UpdateExpression: 'SET #st = :s, expiresAtMs = :e',
        ExpressionAttributeNames: { '#st': 'state' },
        ExpressionAttributeValues: {
          ':s': 'HELD',
          ':e': t.clock.nowMs() + 60_000,
        },
      }),
    );
    const before =
      MetricsRegistry.value('launch_reconcile_repairs_total', {
        kind: 'booking_without_ledger',
      }) ?? 0;
    await t.reconciler.run();
    expect((await ledger().get(a.hold.holdId))!.state).toBe('CONFIRMED');
    expect(
      (await ledger().records(event.id)).find((r) => r.seat === 10)!.state,
    ).toBe('CONFIRMED');
    expect(await mapShows(event, 10)).toBe(true);
    expect(
      MetricsRegistry.value('launch_reconcile_repairs_total', {
        kind: 'booking_without_ledger',
      }),
    ).toBeGreaterThan(before);

    // (b) the ledger says confirmed, no booking exists, and 120 s pass
    const b = await holding(event, [11]);
    await t.confirm(b.hold.holdId, b.who).expect(201);
    await t
      .rows(`DELETE FROM "BookingEvent" WHERE "holdId" = :id`, {
        id: b.hold.holdId,
      })
      .catch(() => undefined);
    await t.db.query(`DELETE FROM "BookingEvent" WHERE "holdId" = :id`, {
      replacements: { id: b.hold.holdId },
    });
    await t.db.query(`DELETE FROM "Booking" WHERE "holdId" = :id`, {
      replacements: { id: b.hold.holdId },
    });
    const repairs =
      MetricsRegistry.value('launch_reconcile_repairs_total', {
        kind: 'ledger_without_booking',
      }) ?? 0;
    await t.reconciler.run();
    expect((await ledger().get(b.hold.holdId))!.state).toBe('CONFIRMED'); // too young to touch
    await t.advance(121 * SECOND);
    await t.reconciler.run();
    expect(
      (await ledger().records(event.id)).filter(
        (r) => r.seat === 11 && r.state !== 'FREE',
      ),
    ).toHaveLength(0);
    expect(await mapShows(event, 11)).toBe(false);
    expect(
      MetricsRegistry.value('launch_reconcile_repairs_total', {
        kind: 'ledger_without_booking',
      }),
    ).toBe(repairs + 1);
    const c = await t.buyer();
    await t
      .hold(event, c, await t.admit(event, c), { seats: [11] })
      .expect(201);
  });

  // ------------------------------------------------------------------------------------------------- AS-42

  it('S22 AS-42: a refused outbox append rolls the booking back and leaves the hold confirmable', async () => {
    const event = await sale();
    const { who, hold } = await holding(event, [1]);
    await t.http().get(`/api/launch-events/${event.id}/seatmap`).expect(200);
    t.published.length = 0;
    jest
      .spyOn(OutboxService.prototype, 'append')
      .mockRejectedValueOnce(new Error('outbox refused'));

    const res = await t.confirm(hold.holdId, who).expect(500);
    expect(expectProblem(res.body).detail).not.toMatch(/outbox|refused/i);
    expect(await bookingsOf(hold.holdId)).toBe(0);
    expect(await historyOf(hold.holdId)).toBe(0);
    expect((await ledger().get(hold.holdId))!.state).toBe('HELD');
    expect(
      t.published.filter(
        (p) => (p.data as { change?: string }).change === 'booked',
      ),
    ).toHaveLength(0);
    expect(
      await eventRows(hold.holdId, 'launchevents.booking_confirmed'),
    ).toHaveLength(0);

    await t.confirm(hold.holdId, who).expect(201);
  });

  // ------------------------------------------------------------------------------------------------- AS-43

  it('S22 AS-43: the last booked seat sells the event out exactly once (20 runs)', async () => {
    await eachRound(20, async () => {
      const event = await sale({
        seatCount: 3,
        seatsPerRow: 3,
        perUserLimit: 2,
      });
      await t.http().get(`/api/launch-events/${event.id}`).expect(200); // warm page cache
      const first = await holding(event, [0, 1]);
      await t.confirm(first.hold.holdId, first.who).expect(201);
      const last = await holding(event, [2]);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => t.confirm(last.hold.holdId, last.who)),
      );
      results.forEach((r) => expect([200, 201]).toContain(r.status));
      expect(
        (
          await t.rows<{ status: string }>(
            `SELECT "status" FROM "LaunchEvent" WHERE "id" = :id`,
            { id: event.id },
          )
        )[0].status,
      ).toBe('SOLD_OUT');
      expect(
        await count(
          `SELECT count(*)::text AS n FROM "LaunchEventHistory" WHERE "launchEventId" = :id AND "toStatus" = 'SOLD_OUT'`,
          { id: event.id },
        ),
      ).toBe(1);
      expect(
        await eventRows(event.id, 'launchevents.event_sold_out'),
      ).toHaveLength(1);
      expect(
        (await t.http().get(`/api/launch-events/${event.id}`).expect(200)).body
          .status,
      ).toBe('SOLD_OUT');
      const late = await t.buyer();
      const token = await t.admit(event, late).catch(() => undefined);
      void token;
      const refused = await t.join(event, late);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('EVENT_SOLD_OUT');
    });
  });

  // ------------------------------------------------------------------------------------------------- AS-44

  it('S22 AS-44: one voucher command per confirmed hold, deduplicated by hold, and the booking does not depend on it', async () => {
    const event = await sale();
    const { who, hold } = await holding(event, [1, 2]);
    await t.confirm(hold.holdId, who).expect(201);
    await t.confirm(hold.holdId, who).expect(200);
    const tasks = (await t.outbox(hold.holdId)).filter(
      (r) => r.kind === 'task',
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].topic).toBe('orders-booking-voucher-requested');
    expect(
      (tasks[0].payload as { body: { dedupeKey: string } }).body.dedupeKey,
    ).toBe(`booking-voucher:${hold.holdId}`);
    expect(await bookingsOf(hold.holdId)).toBe(2); // nothing consumed the command, the booking stands
  });
});
