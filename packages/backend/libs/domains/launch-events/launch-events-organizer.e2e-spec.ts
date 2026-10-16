import { v4 } from 'uuid';
import {
  bookingPageSchema,
  launchEventEventSchemas,
  launchEventSchema,
  myBookingsSchema,
} from '@marketplace-sandbox/contracts';
import { PurposeTokenService } from '@app/domains/identity';
import { HOLD_LEDGER, type HoldLedger } from './domain/ports';
import { LaunchEventsModule } from './launch-events.module';
import {
  DAY,
  MINUTE,
  SECOND,
  createLaunchApp,
  expectContract,
  expectProblem,
  type EventView,
  type HoldView,
  type LaunchTestApp,
  type Seller,
} from './testing/launch-events-test-kit';

const FAST = { admissionRatePerSec: 100_000 };

jest.setTimeout(180_000); // the suites create hundreds of people through the real stores

describe('Launch events: organizer routes, status machine and my bookings', () => {
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
    for (const store of Object.values(t.stores)) store.up();
  });

  const ledger = () =>
    t.app.select(LaunchEventsModule).get<HoldLedger>(HOLD_LEDGER);
  const count = async (
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => Number((await t.rows<{ n: string }>(sql, replacements))[0].n);
  const validBody = (overrides: Record<string, unknown> = {}) => ({
    title: 'Keynote',
    venue: 'Berlin',
    startsAt: new Date(t.clock.nowMs() + DAY).toISOString(),
    salesOpenAt: new Date(t.clock.nowMs() + 30 * MINUTE).toISOString(),
    seatCount: 800,
    ...overrides,
  });
  const create = (
    who: { auth: Record<string, string> },
    shopId: string,
    body: object,
  ) =>
    t
      .http()
      .post(`/api/shops/${shopId}/launch-events`)
      .set(who.auth)
      .send(body);
  const close = (
    who: { auth: Record<string, string> },
    shopId: string,
    eventId: string,
  ) =>
    t
      .http()
      .post(`/api/shops/${shopId}/launch-events/${eventId}/close`)
      .set(who.auth);
  const sale = (overrides: Record<string, unknown> = {}) =>
    t.onSale(s, { ...FAST, ...overrides });
  const status = async (id: string) =>
    (
      await t.rows<{ status: string }>(
        `SELECT "status" FROM "LaunchEvent" WHERE "id" = :id`,
        { id },
      )
    )[0].status;
  const mintFor = async (event: { id: string }, who: { id: string }) =>
    t.app.get(PurposeTokenService, { strict: false }).sign({
      subject: who.id,
      audience: `admission:${event.id}`,
      ttlSec: 600,
      claims: { purpose: 'admission' },
    });

  // ------------------------------------------------------------------------------------------------- AS-51

  it('S22 AS-51: a shop member creates an event: defaults, response DTO, no foreign key, event and the two jobs', async () => {
    const body = validBody();
    const res = await create(s, s.shopId, body).expect(201);
    const event = expectContract(launchEventSchema, res.body);
    expect(event).toMatchObject({
      shopId: s.shopId,
      status: 'SCHEDULED',
      seatsPerRow: 20,
      seatingMode: 'SEATED',
      perUserLimit: 2,
      humanCheckRequired: false,
      seatCount: 800,
    });
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(event).sort()); // the DTO, never the stored row
    expect(res.headers.location).toBe(`/api/launch-events/${event.id}`);

    const row = (
      await t.rows<{ admissionRatePerSec: number }>(
        `SELECT "admissionRatePerSec" FROM "LaunchEvent" WHERE "id" = :id`,
        { id: event.id },
      )
    )[0];
    expect(row.admissionRatePerSec).toBe(200);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM "LaunchEvent" WHERE "id" = :id`,
        { id: event.id },
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM information_schema.table_constraints WHERE table_name = 'LaunchEvent' AND constraint_type = 'FOREIGN KEY'`,
      ),
    ).toBe(0);
    const created = (await t.outbox(event.id)).filter(
      (r) => r.type === 'launchevents.event_created',
    );
    expect(created).toHaveLength(1);
    expect(created[0].topic).toBe('launch_events.events');
    expect(
      launchEventEventSchemas['launchevents.event_created'].parse(
        (created[0].payload as { payload: unknown }).payload,
      ),
    ).toMatchObject({
      launchEventId: event.id,
      shopId: s.shopId,
      title: 'Keynote',
      seatCount: 800,
    });
    const open = await t.probe.find('launch-events.open-sales', {
      eventId: event.id,
    });
    const closing = await t.probe.find('launch-events.close-event', {
      eventId: event.id,
      reason: 'started',
    });
    expect(open.map((j) => j.runAt.toISOString())).toEqual([body.salesOpenAt]);
    expect(closing.map((j) => j.runAt.toISOString())).toEqual([body.startsAt]);
  });

  // ------------------------------------------------------------------------------------------------- AS-52

  it('S22 AS-52: invalid events are refused with nothing stored', async () => {
    const before = await count(
      `SELECT count(*)::text AS n FROM "LaunchEvent" WHERE "shopId" = :id`,
      { id: s.shopId },
    );
    const now = t.clock.nowMs();
    const invalid: [string, Record<string, unknown>][] = [
      ['seatCount 0', { seatCount: 0 }],
      ['seatCount 100001', { seatCount: 100_001 }],
      ['perUserLimit 0', { perUserLimit: 0 }],
      ['perUserLimit 11', { perUserLimit: 11 }],
      ['admissionRate 0', { admissionRatePerSec: 0 }],
      ['admissionRate 100001', { admissionRatePerSec: 100_001 }],
      ['seatsPerRow 0', { seatsPerRow: 0 }],
      ['seatsPerRow 501', { seatsPerRow: 501 }],
      ['seatsPerRow > seatCount', { seatCount: 10, seatsPerRow: 11 }],
      ['non-ISO date', { startsAt: 'tomorrow' }],
      ['an unknown field', { vip: true }],
      ['a long title', { title: 'x'.repeat(121) }],
      ['a long venue', { venue: 'x'.repeat(201) }],
    ];
    for (const [name, override] of invalid) {
      const res = await create(s, s.shopId, validBody(override)).expect(400);
      expect({ name, code: res.body.code }).toEqual({
        name,
        code: 'validation_failed',
      });
    }
    const schedule: [string, Record<string, unknown>][] = [
      [
        'sales opened more than a minute ago',
        { salesOpenAt: new Date(now - 61_000).toISOString() },
      ],
      [
        'sales open after the start',
        { salesOpenAt: new Date(now + 2 * DAY).toISOString() },
      ],
      [
        'sales open at the start',
        { salesOpenAt: new Date(now + DAY).toISOString() },
      ],
    ];
    for (const [name, override] of schedule) {
      const res = await create(s, s.shopId, validBody(override)).expect(422);
      expect({ name, code: res.body.code }).toEqual({
        name,
        code: 'invalid_schedule',
      });
    }
    await t
      .http()
      .post(`/api/shops/${s.shopId}/launch-events`)
      .send(validBody())
      .expect(401);
    const viewer = await t.member(s.shopId, 'VIEWER');
    expect(
      (await create(viewer, s.shopId, validBody()).expect(403)).body.code,
    ).toBe('permission_denied');
    const outsider = await t.seller();
    await create(outsider, s.shopId, validBody()).expect(404);
    const suspended = await t.seller({ status: 'SUSPENDED' });
    expect(
      (await create(suspended, suspended.shopId, validBody()).expect(403)).body
        .code,
    ).toBe('shop_suspended');
    expect(
      await count(
        `SELECT count(*)::text AS n FROM "LaunchEvent" WHERE "shopId" = :id`,
        { id: s.shopId },
      ),
    ).toBe(before);
  });

  // ------------------------------------------------------------------------------------------------- AS-53

  it("S22 AS-53: the organizer's bookings come in stable keyset pages, scoped to the shop", async () => {
    const shop = await t.seller();
    const event = await t.onSale(shop, {
      ...FAST,
      seatCount: 200,
      seatsPerRow: 20,
      perUserLimit: 10,
    });
    for (let i = 0; i < 13; i++) {
      const buyer = await t.buyer();
      const token = await t.admit(event, buyer);
      const seats = Array.from({ length: 10 }, (_, k) => i * 10 + k);
      const hold = await t.hold(event, buyer, token, { seats }).expect(201);
      await t.confirm(hold.body.holdId, buyer).expect(201);
      await t.advance(1);
    }
    const path = `/api/shops/${shop.shopId}/launch-events/${event.id}/bookings`;
    const seen: { bookingId: string; confirmedAt: string }[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `${path}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await t.http().get(url).set(shop.auth).expect(200);
      const page = expectContract(bookingPageSchema, res.body);
      sizes.push(page.items.length);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([50, 50, 30]);
    expect(new Set(seen.map((b) => b.bookingId)).size).toBe(130);
    const ordered = [...seen].sort(
      (a, b) =>
        b.confirmedAt.localeCompare(a.confirmedAt) ||
        b.bookingId.localeCompare(a.bookingId),
    );
    expect(seen).toEqual(ordered);

    await t.http().get(`${path}?limit=101`).set(shop.auth).expect(400);
    await t.http().get(`${path}?cursor=garbage`).set(shop.auth).expect(400);
    const stranger = await t.seller();
    const other = await t
      .http()
      .get(path.replace(shop.shopId, stranger.shopId))
      .set(stranger.auth)
      .expect(404);
    const unknown = await t
      .http()
      .get(`/api/shops/${stranger.shopId}/launch-events/${v4()}/bookings`)
      .set(stranger.auth)
      .expect(404);
    expect(expectProblem(other.body).code).toBe(
      expectProblem(unknown.body).code,
    );
    expect(other.body.detail).toBe(unknown.body.detail);
    const viewer = await t.member(shop.shopId, 'VIEWER');
    await t.http().get(path).set(viewer.auth).expect(403);
  });

  // ------------------------------------------------------------------------------------------------- AS-54

  it('S22 AS-54: closing refuses new joins and confirms, ends the open holds, emits once and is exclusive (20 runs)', async () => {
    const event = await sale();
    const holders = await t.buyers(3);
    const holds: HoldView[] = [];
    for (let i = 0; i < holders.length; i++)
      holds.push(await t.held(event, holders[i], [i]));
    const waiting = await t.buyer();
    await t.join(event, waiting).expect(201);
    await t.http().get(`/api/launch-events/${event.id}`).expect(200); // warm the page cache
    expect(
      (await t.http().get(`/api/launch-events/${event.id}`)).body.status,
    ).toBe('ON_SALE');

    const res = await close(s, s.shopId, event.id).expect(200);
    expect(expectContract(launchEventSchema, res.body).status).toBe('CLOSED');
    expect(
      await count(
        `SELECT count(*)::text AS n FROM "LaunchEventHistory" WHERE "launchEventId" = :id AND "toStatus" = 'CLOSED'`,
        { id: event.id },
      ),
    ).toBe(1);
    const closed = (await t.outbox(event.id)).filter(
      (r) => r.type === 'launchevents.event_closed',
    );
    expect(closed).toHaveLength(1);
    expect(
      launchEventEventSchemas['launchevents.event_closed'].parse(
        (closed[0].payload as { payload: unknown }).payload,
      ),
    ).toEqual({
      launchEventId: event.id,
      shopId: s.shopId,
      reason: 'organizer',
    });
    expect(
      (await t.http().get(`/api/launch-events/${event.id}`).expect(200)).body
        .status,
    ).toBe('CLOSED');
    expect((await t.join(event, await t.buyer()).expect(409)).body.code).toBe(
      'EVENT_CLOSED',
    );
    expect(
      (await t.confirm(holds[0].holdId, holders[0]).expect(409)).body.code,
    ).toBe('EVENT_CLOSED');

    await t.jobs.closeEvent({ eventId: event.id, reason: 'organizer' });
    for (const hold of holds)
      expect((await ledger().get(hold.holdId))!.state).toBe('EXPIRED');
    expect(
      (await ledger().records(event.id)).filter((r) => r.state === 'HELD'),
    ).toHaveLength(0);
    expect((await close(s, s.shopId, event.id).expect(409)).body.code).toBe(
      'EVENT_ALREADY_CLOSED',
    );
    const stranger = await t.seller();
    await close(stranger, stranger.shopId, event.id).expect(404);
    await close(s, s.shopId, v4()).expect(404);

    for (let run = 0; run < 20; run++) {
      const fresh = await sale();
      const results = await Promise.all([
        close(s, s.shopId, fresh.id),
        close(s, s.shopId, fresh.id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await eventClosedRows(fresh.id)).toBe(1);
    }
  });
  const eventClosedRows = async (id: string) =>
    (await t.outbox(id)).filter((r) => r.type === 'launchevents.event_closed')
      .length;

  // ------------------------------------------------------------------------------------------------- AS-55

  it('S22 AS-55: sales open once at the sales time, whoever gets there first; a closed or sold-out event is left alone', async () => {
    const salesOpenAt = new Date(t.clock.nowMs() + 30 * MINUTE);
    const event = (
      await create(
        s,
        s.shopId,
        validBody({ ...FAST, salesOpenAt: salesOpenAt.toISOString() }),
      ).expect(201)
    ).body as EventView;
    await t.http().get(`/api/launch-events/${event.id}`).expect(200); // warm
    const buyer = await t.buyer();
    await t.setTime(new Date(salesOpenAt.getTime() - SECOND));
    const early = await t
      .hold(event, buyer, await mintFor(event, buyer), { seats: [1] })
      .expect(409);
    expect(early.body.code).toBe('EVENT_NOT_ON_SALE');
    await t.jobs.openSales({ eventId: event.id }); // early: nothing
    expect(await status(event.id)).toBe('SCHEDULED');

    await t.setTime(salesOpenAt);
    await Promise.all([
      t.jobs.openSales({ eventId: event.id }),
      t.jobs.openSales({ eventId: event.id }),
    ]);
    await t.jobs.openSales({ eventId: event.id });
    expect(await status(event.id)).toBe('ON_SALE');
    expect(
      await count(
        `SELECT count(*)::text AS n FROM "LaunchEventHistory" WHERE "launchEventId" = :id AND "toStatus" = 'ON_SALE'`,
        { id: event.id },
      ),
    ).toBe(1);
    expect(
      (await t.http().get(`/api/launch-events/${event.id}`).expect(200)).body
        .status,
    ).toBe('ON_SALE');

    // the job is late: the admitter makes the same conditional update
    const lateAt = new Date(t.clock.nowMs() + 90 * SECOND);
    const late = (
      await create(
        s,
        s.shopId,
        validBody({ ...FAST, salesOpenAt: lateAt.toISOString() }),
      ).expect(201)
    ).body as EventView;
    const waiting = await t.buyer();
    const ticket = (await t.join(late, waiting).expect(201)).body
      .ticket as string;
    await t.advance(60 * SECOND);
    // a ticket must be polled at least every two minutes, or the admitter treats it as abandoned
    await t.status(late, waiting, ticket).expect(200);
    await t.advance(31 * SECOND);
    expect(await t.admitter.admitEvent(late.id)).toBe(1);
    expect(await status(late.id)).toBe('ON_SALE');
    await t.jobs.openSales({ eventId: late.id });
    expect(
      await count(
        `SELECT count(*)::text AS n FROM "LaunchEventHistory" WHERE "launchEventId" = :id AND "toStatus" = 'ON_SALE'`,
        { id: late.id },
      ),
    ).toBe(1);

    // a closed event stays closed
    const doomed = await sale();
    await close(s, s.shopId, doomed.id).expect(200);
    await t.jobs.openSales({ eventId: doomed.id });
    expect(await status(doomed.id)).toBe('CLOSED');
  });

  // ------------------------------------------------------------------------------------------------- AS-57

  it("S22 AS-57: my-bookings lists exactly the caller's bookings, newest first", async () => {
    const event = await sale({ perUserLimit: 2 });
    const [a, b] = await t.buyers(2);
    const first = await t.held(event, a, [1]);
    await t.confirm(first.holdId, a).expect(201);
    await t.advance(SECOND);
    const second = await t.held(event, a, [2]);
    await t.confirm(second.holdId, a).expect(201);
    const other = await t.held(event, b, [3]);
    await t.confirm(other.holdId, b).expect(201);

    const mine = expectContract(
      myBookingsSchema,
      (
        await t
          .http()
          .get(`/api/launch-events/${event.id}/my-bookings`)
          .set(a.auth)
          .expect(200)
      ).body,
    );
    expect(mine.items.map((i) => i.seat)).toEqual([2, 1]);
    const theirs = (
      await t
        .http()
        .get(`/api/launch-events/${event.id}/my-bookings`)
        .set(b.auth)
        .expect(200)
    ).body;
    expect(theirs.items.map((i: { seat: number }) => i.seat)).toEqual([3]);
    await t
      .http()
      .get(`/api/launch-events/${v4()}/my-bookings`)
      .set(a.auth)
      .expect(404);
  });
});
