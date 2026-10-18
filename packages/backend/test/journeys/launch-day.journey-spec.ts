import { randomUUID } from 'node:crypto';
import {
  auctionMemberSchema,
  auctionPublicSchema,
  bidResultSchema,
  flashSaleMemberSchema,
  flashSalePublicSchema,
  orderPageSchema,
  productSearchResponseSchema,
  voucherPageSchema,
  type AuctionMember,
  type AuctionPublic,
  type BidResult,
  type FlashSaleMember,
  type FlashSalePublic,
  type Voucher,
} from '@marketplace-sandbox/contracts';
import { ControlSurface, adminClient } from './support/control-surface';
import { API_URL, JourneyClient, problemCode } from './support/journey-client';
import {
  createSeller,
  inviteAndAccept,
  stockOf,
  subscribe,
  type FixtureProduct,
  type SellerFixture,
} from './support/seller-fixture';
import { getOrder, payOrder, waitOrderStatus } from './support/purchase';
import { LaunchFixture } from './support/launch-fixture';
import { countExactlyOnce, eventTap, tapUntil } from './support/event-tap';
import { expectEvent, sseClient, topics } from './support/sse-client';
import {
  admit,
  confirmHold,
  getEvent,
  holdSeats,
  mustConfirm,
  mustHold,
  myBookings,
  seatMap,
  type Admitted,
} from './support/launch-actions';
import {
  inbox,
  itemsOf,
  staysExactly,
  unreadCount,
  waitForItems,
} from './support/inbox';
import { staysTrue, waitForContract } from './support/wait-for-contract';
import { waitFor } from '../utils/async-helpers';

/**
 * Journey J03: launch day. Black box: public HTTP, SSE, the control surface and the read-only event tap; every test creates
 * its own users, shops, events, drops, streams and auctions (L-005, L-006); every wait is a contract hop `J03.H1`..`J03.H30`,
 * never a sleep (L-007). Scenario titles carry the test-plan id `AS-nn` (L-017). The stories run in the order US1..US6;
 * the clock and the consumer pauses are global, so this file never runs beside another journey (L-029) and `afterAll`
 * always puts both back.
 */
describe('Journey J03: launch day', () => {
  let admin: JourneyClient;
  let control: ControlSurface;
  let fixture: LaunchFixture;

  beforeAll(async () => {
    admin = await adminClient();
    control = new ControlSurface(admin);
    await control.restoreAll(); // a known stack: consumers running, clock real
    fixture = new LaunchFixture(control);
  });

  afterAll(async () => {
    await control?.restoreAll({ endAdminSessions: true });
  });

  /** The booking vouchers of `buyer` for an event (`GET /orders/vouchers?launchEventId=`). */
  const vouchersOf = async (
    buyer: JourneyClient,
    launchEventId: string,
  ): Promise<Voucher[]> => {
    const reply = await buyer.get('/api/orders/vouchers', {
      query: { launchEventId },
      schema: voucherPageSchema,
    });
    if (reply.status !== 200)
      throw new Error(`vouchers: ${reply.status} ${JSON.stringify(reply.body)}`);
    return reply.body.items;
  };

  /**
   * Moves the stack clock by `seconds` in steps of 90 s, polling every waiting ticket between the steps, as a browser's
   * heartbeat does: a ticket nobody asks about for 120 s of the stack clock lapses (S22 AS-07), and a one-hour jump would
   * lapse the whole room.
   */
  const advanceKeepingQueue = async (
    seconds: number,
    waiting: { buyer: JourneyClient; eventId: string; ticket: string }[],
  ) => {
    for (let moved = 0; moved < seconds; moved += 90) {
      await control.advance(Math.min(90, seconds - moved));
      for (const w of waiting) {
        const reply = await w.buyer.get(
          `/api/launch-events/${w.eventId}/queue/${w.ticket}`,
        );
        if (reply.status !== 200)
          throw new Error(`heartbeat ${w.buyer.label}: ${reply.status}`);
      }
    }
  };

  interface SearchHit {
    id: string;
    title: string;
    inStock: boolean;
  }
  /** Public product search by exact title. */
  const searchByTitle = async (title: string): Promise<SearchHit[]> => {
    const reply = await new JourneyClient('anon@example.com').get(
      '/api/products/search',
      { query: { q: title, limit: 20 }, schema: productSearchResponseSchema },
    );
    if (reply.status !== 200)
      throw new Error(`search: ${reply.status} ${JSON.stringify(reply.body)}`);
    return (reply.body as { items: SearchHit[] }).items.filter(
      (hit) => hit.title === title,
    );
  };
  /** Sets a product's stock through the member route (reads the version first). */
  const setStock = async (
    seller: SellerFixture,
    productId: string,
    quantity: number,
  ) => {
    const base = `/api/shops/${seller.shopId}/products/${productId}`;
    const current = await seller.owner.get<{ version: number }>(base);
    const patched = await seller.owner.call('PATCH', base, {
      body: { expectedVersion: current.body.version, quantity },
    });
    if (patched.status !== 200)
      throw new Error(`set stock: ${patched.status} ${JSON.stringify(patched.body)}`);
  };

  const newBuyers = async (n: number, label = 'buyer') => {
    const buyers: JourneyClient[] = [];
    for (let i = 0; i < n; i++) buyers.push(await JourneyClient.signUp(label));
    return buyers;
  };

  describe('US1: a buyer waits fairly, books seats, and is told once', () => {
    let seller: SellerFixture;
    let eventId: string;
    let salesOpenAt: number;
    let buyers: JourneyClient[];
    let b1: Admitted;
    let b1Hold: { holdId: string; seats: number[] };
    /** Every buyer of AS-01 with their ticket and admission token, by index. */
    const admittedAll: Admitted[] = [];

    it('J03 AS-01: buyers queue before sales open, are admitted at the rate, hold seats and confirm', async () => {
      seller = await createSeller(admin, { products: [], staff: true });
      const event = await fixture.createEvent(seller, {
        seatCount: 40,
        admissionRatePerSec: 5,
        salesOpensInSec: 400,
      });
      eventId = event.id;
      salesOpenAt = Date.parse(event.salesOpenAt);
      expect(event.status).toBe('SCHEDULED');

      buyers = await newBuyers(12);
      const tickets: string[] = [];
      for (const buyer of buyers) {
        const joined = await fixture.joinQueue(buyer, eventId);
        expect(joined.admitted).toBe(false);
        expect(joined.position).toBeGreaterThanOrEqual(1);
        tickets.push(joined.ticket);
      }
      const queuePush = await sseClient(
        buyers[0],
        topics.queue(tickets[0]),
      );

      // sales open: the clock passes salesOpenAt and the scheduled job opens the event
      await advanceKeepingQueue(
        401,
        buyers.map((buyer, i) => ({ buyer, eventId, ticket: tickets[i] })),
      );
      await waitForContract(
        'J03.H1',
        async () =>
          (await getEvent(buyers[0], eventId)).status === 'ON_SALE'
            ? true
            : null,
        'event ON_SALE',
      );

      // everyone is admitted, at most 5 per second of the stack clock
      const admittedAt: number[] = [];
      let first: { admissionToken?: string } | undefined;
      const all12 = admittedAll;
      await waitFor(
        async () => {
          admittedAt.length = 0;
          let all = true;
          for (const [i, buyer] of buyers.entries()) {
            const s = await fixture.ticketStatus(buyer, eventId, tickets[i]);
            if (!s.admitted) all = false;
            else {
              expect(s.admittedAt).toBeDefined();
              admittedAt.push(Date.parse(s.admittedAt!));
              if (i === 0) first = s;
              all12[i] = {
                buyer,
                ticket: tickets[i],
                token: s.admissionToken!,
              };
            }
          }
          return all;
        },
        {
          timeoutMs: 20_000,
          intervalMs: 500,
          description: 'all 12 tickets admitted',
        },
      );
      const perSecond = new Map<number, number>();
      for (const at of admittedAt) {
        const second = Math.floor(at / 1000);
        perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
      }
      for (const [second, count] of perSecond)
        expect({ second, count: Math.min(count, 5) }).toEqual({
          second,
          count,
        });
      const pushed = await queuePush.next(
        (e) => e.event === 'admitted',
        10_000,
        'admitted push',
      );
      expect(pushed.data.admissionToken).toBe(first?.admissionToken);
      expect(queuePush.events.filter((e) => e.event === 'admitted')).toHaveLength(
        1,
      );
      queuePush.close();

      b1 = { buyer: buyers[0], ticket: tickets[0], token: first!.admissionToken! };
      const key = 'k-j03-0001-' + randomUUID();
      // the map is built by the first read; a delta is published only for a map that exists
      await seatMap(buyers[1], eventId);
      const seatStream = await sseClient(buyers[1], topics.seatMap(eventId));
      const hold = await mustHold(b1, eventId, [3, 4], key);
      expect(hold.seats).toEqual([3, 4]);
      b1Hold = { holdId: hold.holdId, seats: hold.seats };
      await waitForContract(
        'J03.H3',
        async () => {
          const map = await seatMap(buyers[1], eventId);
          return map.taken.includes(3) && map.taken.includes(4) ? map : null;
        },
        'seat map shows 3 and 4',
      );
      await seatStream.next(
        (e) => e.event === 'seats' && e.data.change === 'held',
        5_000,
        'held delta',
      );

      const confirmed = await mustConfirm(b1.buyer, hold.holdId);
      expect(confirmed.bookings.map((b) => b.seat).sort()).toEqual([3, 4]);
      const mine = await myBookings(b1.buyer, eventId);
      expect(mine.map((b) => b.seat).sort()).toEqual([3, 4]);
      const map = await seatMap(buyers[1], eventId);
      expect(map.taken).toEqual(expect.arrayContaining([3, 4]));
      await seatStream.next(
        (e) => e.event === 'seats' && e.data.change === 'booked',
        5_000,
        'booked delta',
      );
      seatStream.close();
    });

    it('J03 AS-02: one booking, one notice, one voucher', async () => {
      const [owner] = [seller.owner];
      const notices = await waitForItems(
        'J03.H4',
        b1.buyer,
        'booking.confirmed',
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        category: 'bookings',
        read: false,
      });
      expect(notices[0].link).toContain(eventId);
      expect(notices[0].body).toContain('2');
      await expectUnreadMatchesInbox(b1.buyer);

      const vouchers = await waitForContract(
        'J03.H5',
        async () => {
          const found = await vouchersOf(b1.buyer, eventId);
          return found.length >= 1 ? found : null;
        },
        'voucher of B1',
      );
      expect(vouchers).toHaveLength(1);
      expect(vouchers[0]).toMatchObject({
        holdId: b1Hold.holdId,
        seatCount: 2,
        status: 'ISSUED',
        launchEventId: eventId,
      });

      // B2 booked nothing; the owner is not told about bookings
      expect(await itemsOf(buyers[1], 'booking.confirmed')).toHaveLength(0);
      expect(await vouchersOf(buyers[1], eventId)).toEqual([]);
      expect(await itemsOf(owner, 'booking.confirmed')).toHaveLength(0);
      await staysExactly('J03.H4', b1.buyer, 'booking.confirmed', 1);
    });

    /** A small event that is already on sale (the clock is moved past its opening, nobody is queued meanwhile). */
    const onSaleEvent = async (
      options: Parameters<LaunchFixture['createEvent']>[1] = {},
    ) => {
      const event = await fixture.createEvent(seller, {
        salesOpensInSec: 130,
        ...options,
      });
      await control.advance(131);
      await waitForContract(
        'J03.H1',
        async () =>
          (await getEvent(admin, event.id)).status === 'ON_SALE' ? true : null,
        'event ON_SALE',
      );
      return event;
    };
    /** A new buyer, admitted to `eventId`. */
    const admittedBuyer = async (id: string, label = 'buyer') =>
      admit(fixture, await JourneyClient.signUp(label), id);
    /** The problem body of a refusal; the launch codes are upper case (`EVENT_SOLD_OUT`), so the generic schema does not apply. */
    const problem = (body: unknown) => ({ code: problemCode(body) });
    /** Unread items are exactly the unread items of the inbox (the buyer's welcome notice is one of them). */
    const expectUnreadMatchesInbox = async (client: JourneyClient) => {
      const items = await inbox(client);
      expect(await unreadCount(client)).toBe(items.filter((i) => !i.read).length);
    };

    it('J03 AS-03: a retried confirm, with the same key and with ten others at once, books once', async () => {
      const b2 = await admittedBuyer(eventId, 'b2');
      const hold = await mustHold(b2, eventId, [7]);
      const key = randomUUID();
      const same = await Promise.all(
        Array.from({ length: 5 }, () => confirmHold(b2.buyer, hold.holdId, key)),
      );
      const others = await Promise.all(
        Array.from({ length: 10 }, () => confirmHold(b2.buyer, hold.holdId)),
      );
      const after = await confirmHold(b2.buyer, hold.holdId, key);
      const ok = [...same, ...others, after].filter(
        (r) => r.status === 200 || r.status === 201,
      );
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const r of [...same, ...others, after].filter((r) => !ok.includes(r)))
        expect(problem(r.body).code).toBe('idempotency_in_flight'); // a copy that met the first one running
      expect(after.status).toBe(201);
      const ids = new Set(
        ok.map((r) =>
          JSON.stringify(
            (r.body as { bookings: { bookingId: string }[] }).bookings
              .map((b) => b.bookingId)
              .sort(),
          ),
        ),
      );
      expect(ids.size).toBe(1);
      const bookings = await myBookings(b2.buyer, eventId);
      expect(bookings.map((b) => b.seat)).toEqual([7]);

      await waitForItems('J03.H4', b2.buyer, 'booking.confirmed');
      await staysExactly('J03.H4', b2.buyer, 'booking.confirmed', 1);
      await expectUnreadMatchesInbox(b2.buyer);
      await waitForContract(
        'J03.H5',
        async () => ((await vouchersOf(b2.buyer, eventId)).length ? true : null),
        'voucher of B2',
      );
      expect(await vouchersOf(b2.buyer, eventId)).toHaveLength(1);

      // the key of one hold cannot confirm another; a confirm needs a key
      const second = await mustHold(b2, eventId, [8]);
      const reuse = await confirmHold(b2.buyer, second.holdId, key);
      expect(reuse.status).toBe(422);
      expect(problem(reuse.body).code).toBe('idempotency_key_reuse');
      const missing = await confirmHold(b2.buyer, second.holdId, '');
      expect(missing.status).toBe(422);
      expect(problem(missing.body).code).toBe('idempotency_key_required');
      expect(
        (await b2.buyer.call('DELETE', `/api/launch-holds/${second.holdId}`))
          .status,
      ).toBe(204);
    });

    it('J03 AS-04: the last seat sells out the event exactly once', async () => {
      const event = await onSaleEvent({ seatCount: 5, perUserLimit: 4 });
      const bulk = await admittedBuyer(event.id, 'bulk');
      const last = await admittedBuyer(event.id, 'last');
      const other = await admittedBuyer(event.id, 'late');
      await mustConfirm(
        bulk.buyer,
        (await mustHold(bulk, event.id, [0, 1, 2, 3])).holdId,
      );
      const hold = await mustHold(last, event.id, [4]);
      const confirms = await Promise.all(
        Array.from({ length: 5 }, () => confirmHold(last.buyer, hold.holdId)),
      );
      expect(confirms.some((r) => r.status === 201)).toBe(true);

      await waitForContract(
        'J03.H6',
        async () =>
          (await getEvent(admin, event.id)).status === 'SOLD_OUT' ? true : null,
        'event SOLD_OUT',
      );
      const refusedHold = await holdSeats(other, event.id, [0]);
      expect(refusedHold.status).toBe(409);
      expect(problem(refusedHold.body).code).toBe('EVENT_SOLD_OUT');
      const refusedJoin = await other.buyer.post(
        `/api/launch-events/${event.id}/queue`,
        { body: {} },
      );
      expect(refusedJoin.status).toBe(409);
      expect(problem(refusedJoin.body).code).toBe('EVENT_SOLD_OUT');
      expect((await seatMap(admin, event.id)).taken).toEqual([0, 1, 2, 3, 4]);

      const soldOut = await tapUntil('J03.H8', 'launch_events.events', {
        type: 'launchevents.event_sold_out',
        key: event.id,
      });
      expect(soldOut).toHaveLength(1);
      await staysTrue(
        'J03.H8',
        async () =>
          expect(
            await eventTap('launch_events.events', {
              type: 'launchevents.event_sold_out',
              key: event.id,
            }),
          ).toHaveLength(1),
        'one event_sold_out',
      );
    });

    it('J03 AS-05: an unconfirmed hold expires, frees its seat, and is refused at confirm', async () => {
      const event = await onSaleEvent({ seatCount: 20 });
      const b4 = await admittedBuyer(event.id, 'b4');
      const hold = await mustHold(b4, event.id, [11]);
      expect((await seatMap(admin, event.id)).taken).toContain(11);

      await control.advance(601);
      await waitForContract(
        'J03.H7',
        async () =>
          (await seatMap(admin, event.id)).taken.includes(11) ? null : true,
        'seat 11 free',
      );
      const late = await confirmHold(b4.buyer, hold.holdId);
      expect(late.status).toBe(409);
      expect(problem(late.body).code).toBe('HOLD_EXPIRED');
      expect(await myBookings(b4.buyer, event.id)).toEqual([]);
      await control.waitCaughtUp('notification-router');
      await staysExactly('J03.H4', b4.buyer, 'booking.confirmed', 0);
      expect(await vouchersOf(b4.buyer, event.id)).toEqual([]);
      const confirmedHolds = (
        await eventTap('launch_events.events', {
          type: 'launchevents.booking_confirmed',
          key: event.id,
        })
      ).filter((m) => (m.payload as { holdId?: string }).holdId === hold.holdId);
      expect(confirmedHolds).toEqual([]);

      const b5 = await admittedBuyer(event.id, 'b5');
      const second = await mustHold(b5, event.id, [11]);
      // a late sweep (the reconcile job through the control surface) leaves the live hold alone
      await control.runJob('launch-events.reconcile-seats');
      expect((await seatMap(admin, event.id)).taken).toContain(11);
      await mustConfirm(b5.buyer, second.holdId);
    });

    it('J03 AS-06: with the notification consumer down the booking stands, the notice comes after the resume, once', async () => {
      const b6 = await admittedBuyer(eventId, 'b6');
      try {
        await control.pause('notification-router');
        const hold = await mustHold(b6, eventId, [20]);
        await mustConfirm(b6.buyer, hold.holdId);
        expect((await myBookings(b6.buyer, eventId)).map((b) => b.seat)).toEqual([
          20,
        ]);
        await staysTrue(
          'J03.H4',
          async () =>
            expect(await itemsOf(b6.buyer, 'booking.confirmed')).toHaveLength(0),
          'no notice while the group is paused',
        );
        await waitForContract(
          'J03.H29',
          async () =>
            (await control.lag('notification-router')) >= 1 ? true : null,
          'notification-router lag >= 1',
        );
      } finally {
        await control.resume('notification-router');
      }
      await waitForItems('J03.H29', b6.buyer, 'booking.confirmed');
      await staysExactly('J03.H4', b6.buyer, 'booking.confirmed', 1);
      await expectUnreadMatchesInbox(b6.buyer);
    });

    it('J03 AS-07: with the voucher consumer down the booking and its notice do not wait; one voucher after the resume, even redelivered', async () => {
      const b7 = await admittedBuyer(eventId, 'b7');
      try {
        await control.pause('orders-booking-voucher');
        const hold = await mustHold(b7, eventId, [21]);
        await mustConfirm(b7.buyer, hold.holdId);
        await waitForItems('J03.H4', b7.buyer, 'booking.confirmed');
        await staysTrue(
          'J03.H5',
          async () => expect(await vouchersOf(b7.buyer, eventId)).toEqual([]),
          'no voucher while the group is paused',
        );
        await waitForContract(
          'J03.H29',
          async () =>
            (await control.lag('orders-booking-voucher')) >= 1 ? true : null,
          'orders-booking-voucher lag >= 1',
        );
      } finally {
        await control.resume('orders-booking-voucher');
      }
      await waitForContract(
        'J03.H29',
        async () => ((await vouchersOf(b7.buyer, eventId)).length ? true : null),
        'voucher after the resume',
      );
      // pause and resume again: a message the queue delivers a second time makes no second voucher
      await control.pause('orders-booking-voucher');
      await control.resume('orders-booking-voucher');
      await control.waitCaughtUp('orders-booking-voucher');
      await staysTrue(
        'J03.H5',
        async () => expect(await vouchersOf(b7.buyer, eventId)).toHaveLength(1),
        'still one voucher',
      );
    });

    it('J03 AS-09: the admission token belongs to its flow: only the buyer, the event and the hold route accept it', async () => {
      const b8 = await admittedBuyer(eventId, 'b8');
      const otherEvent = await onSaleEvent({ seatCount: 10 });
      const elsewhere = await admittedBuyer(otherEvent.id, 'x');
      const b1again = await admittedBuyer(eventId, 'b1');
      const before = await seatMap(admin, eventId);

      for (const token of [
        b8.buyer.token!, // (a) their ordinary access token
        elsewhere.token, // (b) the admission token of another event
        b1again.token, // (c) the admission token of another buyer
      ]) {
        const reply = await holdSeats(b8, eventId, [30], randomUUID(), token);
        expect(reply.status).toBe(403);
        expect(problem(reply.body).code).toBe('ADMISSION_REQUIRED');
      }
      expect((await seatMap(admin, eventId)).taken).toEqual(before.taken);

      // purpose isolation: the admission token is no session
      const me = await fetch(`${API_URL}/api/auth/me`, {
        headers: { authorization: `Bearer ${b8.token}` },
      });
      expect(me.status).toBe(401);
    });

    it('J03 AS-08: replays change nothing; closing the event stops holds and frees the active ones', async () => {
      const since = new Date((await fixture.nowMs()) - 6 * 3_600_000);
      const inboxBefore = (await itemsOf(b1.buyer, 'booking.confirmed')).map(
        (i) => i.id,
      );
      const unreadBefore = await unreadCount(b1.buyer);
      const vouchersBefore = await vouchersOf(b1.buyer, eventId);

      await control.replay('notification-router', since);
      await control.waitCaughtUp('notification-router');
      await staysExactly('J03.H4', b1.buyer, 'booking.confirmed', 1);
      expect(
        (await itemsOf(b1.buyer, 'booking.confirmed')).map((i) => i.id),
      ).toEqual(inboxBefore);
      expect(await unreadCount(b1.buyer)).toBe(unreadBefore);
      expect(await vouchersOf(b1.buyer, eventId)).toEqual(vouchersBefore);

      // close with an active hold
      const holder = await admittedBuyer(eventId, 'holder');
      const active = await mustHold(holder, eventId, [35]);
      const waiting = await admittedBuyer(eventId, 'waiting');
      const closed = await seller.owner.post(
        `/api/shops/${seller.shopId}/launch-events/${eventId}/close`,
      );
      expect(closed.status).toBe(200);
      await waitForContract(
        'J03.H8',
        async () =>
          (await getEvent(admin, eventId)).status === 'CLOSED' ? true : null,
        'event CLOSED',
      );
      const refusedHold = await holdSeats(waiting, eventId, [36]);
      expect(refusedHold.status).toBe(409);
      expect(problem(refusedHold.body).code).toBe('EVENT_CLOSED');
      const refusedJoin = await waiting.buyer.post(
        `/api/launch-events/${eventId}/queue`,
        { body: {} },
      );
      expect(refusedJoin.status).toBe(409);
      expect(problem(refusedJoin.body).code).toBe('EVENT_CLOSED');
      const refusedConfirm = await confirmHold(holder.buyer, active.holdId);
      expect(refusedConfirm.status).toBe(409);
      expect(problem(refusedConfirm.body).code).toBe('EVENT_CLOSED');
      await waitFor(
        async () => !(await seatMap(admin, eventId)).taken.includes(35),
        { timeoutMs: 60_000, intervalMs: 1_000, description: 'active holds freed' },
      );
      const closedEvents = await tapUntil('J03.H8', 'launch_events.events', {
        type: 'launchevents.event_closed',
        key: eventId,
      });
      expect(closedEvents).toHaveLength(1);

      // a replay now sees older booking_confirmed after the newer event_closed: no inbox changes
      await control.replay('notification-router', since);
      await control.waitCaughtUp('notification-router');
      await staysExactly('J03.H4', b1.buyer, 'booking.confirmed', 1);
      expect(await unreadCount(b1.buyer)).toBe(unreadBefore);
    });
  });

  describe('US2: a limited drop sells exactly its units, and everyone who pays or fails is told', () => {
    interface Drop {
      seller: SellerFixture;
      product: FixtureProduct;
      sale: FlashSaleMember;
    }
    const DROP_PRICE = 2_500;
    const REGULAR_PRICE = 5_000;

    const saleOf = async (seller: SellerFixture, saleId: string) => {
      const reply = await seller.owner.get(
        `/api/shops/${seller.shopId}/flash-sales/${saleId}`,
        { schema: flashSaleMemberSchema },
      );
      if (reply.status !== 200)
        throw new Error(`sale: ${reply.status} ${JSON.stringify(reply.body)}`);
      return reply.body as FlashSaleMember;
    };
    const publicSale = async (client: JourneyClient, saleId: string) => {
      const reply = await client.get(`/api/flash-sales/${saleId}`, {
        schema: flashSalePublicSchema,
      });
      if (reply.status !== 200)
        throw new Error(`public sale: ${reply.status} ${JSON.stringify(reply.body)}`);
      return reply.body as FlashSalePublic;
    };
    const stockNow = (seller: SellerFixture, productId: string) =>
      stockOf(seller, productId);
    const waitSale = (
      hop: 'J03.H9' | 'J03.H15',
      seller: SellerFixture,
      saleId: string,
      status: FlashSaleMember['status'],
    ) =>
      waitForContract(
        hop,
        async () => {
          const sale = await saleOf(seller, saleId);
          return sale.status === status ? sale : null;
        },
        `sale ${status}`,
      );
    /** Signs up `n` buyers, ten at a time. */
    const manyBuyers = async (n: number, label = 'racer') => {
      const out: JourneyClient[] = [];
      while (out.length < n)
        out.push(
          ...(await Promise.all(
            Array.from({ length: Math.min(10, n - out.length) }, () =>
              JourneyClient.signUp(label),
            ),
          )),
        );
      return out;
    };
    const cartWith = async (buyer: JourneyClient, product: FixtureProduct) => {
      const put = await buyer.put(`/api/cart/items/${product.id}`, {
        body: { quantity: 1 },
      });
      if (put.status >= 300)
        throw new Error(`cart: ${put.status} ${JSON.stringify(put.body)}`);
    };
    const rawCheckout = (buyer: JourneyClient, key = randomUUID()) =>
      buyer.post('/api/checkout', { body: {}, key });
    /** Schedules a drop and moves the clock until it is open (loaded at `startsAt - 60 s`). */
    const openDrop = async (
      units: number,
      options: { stock?: number; durationSec?: number } = {},
    ): Promise<Drop> => {
      const seller = await createSeller(admin, {
        products: [
          { priceMinor: REGULAR_PRICE, quantity: options.stock ?? 50 },
        ],
        staff: true,
      });
      const product = seller.products[0];
      const sale = await fixture.createDrop(seller, product, {
        units,
        priceMinor: DROP_PRICE,
        perUserLimit: 1,
        startsInSec: 300,
        durationSec: options.durationSec ?? 3_600,
      });
      await control.advance(240); // startsAt - 60 s: the load job is due
      await waitSale('J03.H9', seller, sale.id, 'LOADED');
      await control.advance(65); // the window is open
      return { seller, product, sale };
    };

    let main: Drop;
    let racers: JourneyClient[];
    let winners: { buyer: JourneyClient; orderId: string }[] = [];
    let losers: JourneyClient[] = [];

    it('J03 AS-10: scheduling moves nothing; the load lowers the stock once and search follows', async () => {
      const seller = await createSeller(admin, {
        products: [{ priceMinor: REGULAR_PRICE, quantity: 50 }],
        staff: true,
      });
      const product = seller.products[0];
      const sale = await fixture.createDrop(seller, product, {
        units: 20,
        priceMinor: DROP_PRICE,
        perUserLimit: 1,
        startsInSec: 300,
      });
      expect(sale.status).toBe('SCHEDULED');
      expect(sale.stats).toBeNull();
      expect(await stockNow(seller, product.id)).toBe(50);

      await control.advance(240); // startsAt - 60 s
      const loaded = await waitSale('J03.H9', seller, sale.id, 'LOADED');
      expect(loaded.stats?.unitsLoaded).toBe(20);
      expect(await stockNow(seller, product.id)).toBe(30);
      const hits = await waitForContract(
        'J03.H10',
        async () => {
          const found = await searchByTitle(product.title);
          return found.length ? found : null;
        },
        'search shows the product',
      );
      expect(hits[0].inStock).toBe(true);

      // the job delivered again (the verify sweep through the control surface) changes nothing
      await control.runJob('flash-sale.verify');
      await control.runJob('flash-sale.verify');
      expect(await stockNow(seller, product.id)).toBe(30);
      expect((await saleOf(seller, sale.id)).stats?.unitsLoaded).toBe(20);

      // before startsAt a checkout is a regular purchase from the regular stock
      const early = await JourneyClient.signUp('early');
      await cartWith(early, product);
      const purchase = await rawCheckout(early);
      expect(purchase.status).toBe(202);
      expect((purchase.body as { totalMinor: number }).totalMinor).toBe(
        REGULAR_PRICE,
      );
      expect(await stockNow(seller, product.id)).toBe(29);
      const cancelled = await early.post(
        `/api/orders/${(purchase.body as { orderId: string }).orderId}/cancel`,
      );
      expect(cancelled.status).toBe(200);
      await waitForContract(
        'J03.H14',
        async () => ((await stockNow(seller, product.id)) === 30 ? true : null),
        'regular stock back',
      );
      main = { seller, product, sale };
    });

    it('J03 AS-11: sixty racers, exactly the units', async () => {
      await control.advance(65); // startsAt reached
      racers = await manyBuyers(60);
      await Promise.all(racers.map((r) => cartWith(r, main.product)));
      const replies = await Promise.all(racers.map((r) => rawCheckout(r)));
      const accepted = replies
        .map((reply, i) => ({ reply, buyer: racers[i] }))
        .filter((x) => x.reply.status === 202);
      const refused = replies
        .map((reply, i) => ({ reply, buyer: racers[i] }))
        .filter((x) => x.reply.status !== 202);
      expect(accepted).toHaveLength(20);
      expect(refused).toHaveLength(40);
      for (const a of accepted)
        expect(a.reply.body).toMatchObject({
          status: 'RESERVED',
          totalMinor: DROP_PRICE,
        });
      for (const r of refused) {
        expect(r.reply.status).toBe(422);
        expect(problemCode(r.reply.body)).toBe('out_of_stock');
      }
      winners = accepted.map((a) => ({
        buyer: a.buyer,
        orderId: (a.reply.body as { orderId: string }).orderId,
      }));
      losers = refused.map((r) => r.buyer);

      const pub = await publicSale(racers[0], main.sale.id);
      expect(pub.remainingApprox).toBe(0);
      expect(pub.state).toBe('SOLD_OUT');
      expect(await stockNow(main.seller, main.product.id)).toBe(30);
      for (const loser of losers.slice(0, 5)) {
        const orders = await loser.get<{ items: unknown[] }>('/api/orders');
        expect(orders.body.items).toEqual([]);
        const cart = await loser.get<{ lines: { productId: string }[] }>(
          '/api/cart',
        );
        expect(cart.body.lines.map((i) => i.productId)).toContain(
          main.product.id,
        );
      }
    });

    it('J03 AS-12: paid drop orders are notified; the stock stays sold', async () => {
      const payers = winners.slice(0, 5);
      for (const p of payers) {
        const accepted = await payOrder(p.buyer, p.orderId);
        expect(accepted.status).toBe(202);
      }
      for (const p of payers)
        await waitOrderStatus(p.buyer, p.orderId, 'PAID', 'H3');
      for (const p of payers) {
        const items = await waitForItems('J03.H12', p.buyer, 'order.confirmed');
        expect(items).toHaveLength(1);
      }
      const ownerItems = await waitForItems(
        'J03.H12',
        main.seller.owner,
        'shop.order_received',
        5,
      );
      expect(ownerItems).toHaveLength(5);
      const stats = (await saleOf(main.seller, main.sale.id)).stats!;
      expect(stats.unitsSold).toBe(5);
      expect(stats.unitsHeld).toBe(15);
      expect(await stockNow(main.seller, main.product.id)).toBe(30);
      // the 15 who did not pay have no notice yet
      for (const w of winners.slice(5, 8))
        expect(await itemsOf(w.buyer, 'order.confirmed')).toHaveLength(0);
    });

    it('J03 AS-14: unpaid holds lapse, the units return once, a late buyer gets one', async () => {
      await control.advance(901); // the 15-minute hold
      for (const w of winners.slice(5)) {
        await waitOrderStatus(w.buyer, w.orderId, 'CANCELLED', 'H11');
        const items = await waitForItems('J03.H14', w.buyer, 'order.cancelled');
        expect(items).toHaveLength(1);
      }
      await waitForContract(
        'J03.H14',
        async () =>
          (await publicSale(racers[0], main.sale.id)).remainingApprox === 15
            ? true
            : null,
        'remainingApprox 15',
      );
      expect((await publicSale(racers[0], main.sale.id)).state).toBe('LIVE');

      const late = (await manyBuyers(1, 'late'))[0];
      await cartWith(late, main.product);
      lateBuyer = late;
      const got = await rawCheckout(late);
      expect(got.status).toBe(202);
      lateOrder = (got.body as { orderId: string }).orderId;

      // the claim shows in the public count, and nothing returns twice
      await waitForContract(
        'J03.H14',
        async () =>
          (await publicSale(racers[0], main.sale.id)).remainingApprox === 14
            ? true
            : null,
        'remainingApprox 14',
      );
      await staysTrue(
        'J03.H14',
        async () =>
          expect(
            (await publicSale(racers[0], main.sale.id)).remainingApprox,
          ).toBe(14),
        'units return once',
      );
    });

    it('J03 AS-16: the brand hears the drop sell out once; staff and replays add none', async () => {
      const owners = await waitForItems(
        'J03.H13',
        main.seller.owner,
        'shop.flash_sale_sold_out',
      );
      expect(owners).toHaveLength(1);
      expect(
        await itemsOf(main.seller.staff!, 'shop.flash_sale_sold_out'),
      ).toHaveLength(0);
      // the late buyer sold the sale out a second time (AS-14): still one item
      await control.replay('notification-router', new Date((await fixture.nowMs()) - 6 * 3_600_000));
      await control.waitCaughtUp('notification-router');
      await staysExactly(
        'J03.H13',
        main.seller.owner,
        'shop.flash_sale_sold_out',
        1,
      );
    });

    it('J03 AS-15: at the end the leftovers return once and the accounts add up', async () => {
      // the late buyer's hold lapses, the window ends, the reconcile follows
      await control.advance(3_600 + 1_200);
      await waitOrderStatus(lateBuyer, lateOrder, 'CANCELLED', 'H11');
      const reconciled = await waitSale('J03.H15', main.seller, main.sale.id, 'RECONCILED');
      expect(reconciled.stats).toBeTruthy();
      await waitForContract(
        'J03.H15',
        async () =>
          (await stockNow(main.seller, main.product.id)) === 45 ? true : null,
        'stock 45',
      );
      const hits = await waitForContract(
        'J03.H10',
        async () => {
          const found = await searchByTitle(main.product.title);
          return found.length && found[0].inStock ? found : null;
        },
        'search inStock',
      );
      expect(hits).toHaveLength(1);
      const events = await tapUntil('J03.H8', 'orders.events', {
        type: 'flashsale.reconciled',
        key: main.sale.id,
      });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        unitsSold: 5,
        unitsReturned: 15,
        driftUnits: 0,
      });
      await control.runJob('flash-sale.verify');
      expect(await stockNow(main.seller, main.product.id)).toBe(45);
      expect(
        await eventTap('orders.events', {
          type: 'flashsale.reconciled',
          key: main.sale.id,
        }),
      ).toHaveLength(1);
    });

    it('J03 AS-13: a retried checkout with one key holds one unit, and the quota is spent', async () => {
      const drop = await openDrop(21);
      const [buyer] = await manyBuyers(1, 'b81');
      await cartWith(buyer, drop.product);
      const key = randomUUID();
      const replies = await Promise.all(
        Array.from({ length: 5 }, () => rawCheckout(buyer, key)),
      );
      const again = await rawCheckout(buyer, key);
      const answered = [...replies, again].filter((r) => r.status === 202);
      expect(answered.length).toBeGreaterThanOrEqual(1);
      for (const r of [...replies, again].filter((r) => r.status !== 202))
        expect(problemCode(r.body)).toBe('idempotency_in_flight');
      const orderIds = new Set(
        answered.map((r) => (r.body as { orderId: string }).orderId),
      );
      expect(orderIds.size).toBe(1);
      const orders = await buyer.get<{ items: unknown[] }>('/api/orders');
      expect(orders.body.items).toHaveLength(1);
      expect(
        (await saleOf(drop.seller, drop.sale.id)).stats?.unitsHeld,
      ).toBe(1);
      await cartWith(buyer, drop.product);
      const second = await rawCheckout(buyer);
      expect(second.status).toBe(422);
      expect(problemCode(second.body)).toBe('flash_sale_limit_exceeded');
    });

    it('J03 AS-17: a drop that cannot load is START_FAILED; nothing is sold from elsewhere', async () => {
      const seller = await createSeller(admin, {
        products: [{ priceMinor: REGULAR_PRICE, quantity: 10 }],
        staff: true,
      });
      const product = seller.products[0];
      const sale = await fixture.createDrop(seller, product, {
        units: 10,
        priceMinor: DROP_PRICE,
        perUserLimit: 1,
        startsInSec: 300,
      });
      await setStock(seller, product.id, 4);
      await control.advance(240);
      const failed = await waitSale('J03.H9', seller, sale.id, 'START_FAILED');
      expect(failed.statusReason).toBe('insufficient_stock');
      expect(await stockNow(seller, product.id)).toBe(4);

      await control.advance(65);
      const buyer = await JourneyClient.signUp('regular');
      await cartWith(buyer, product);
      const purchase = await rawCheckout(buyer);
      expect(purchase.status).toBe(202);
      expect((purchase.body as { totalMinor: number }).totalMinor).toBe(
        REGULAR_PRICE,
      );
      expect(await stockNow(seller, product.id)).toBe(3);

      const failures = await tapUntil('J03.H13', 'orders.events', {
        type: 'flashsale.start_failed',
        key: sale.id,
      });
      expect(failures).toHaveLength(1);
      expect(
        await waitForItems('J03.H13', seller.owner, 'shop.flash_sale_start_failed'),
      ).toHaveLength(1);
      expect(
        await itemsOf(seller.staff!, 'shop.flash_sale_start_failed'),
      ).toHaveLength(0);
    });

    it('J03 AS-18: with the notification consumer down the drop sells right; the notices come after the resume, once, even replayed', async () => {
      const drop = await openDrop(5);
      const buyers = await manyBuyers(3, 'payer');
      const orders: string[] = [];
      for (const b of buyers) {
        await cartWith(b, drop.product);
        const r = await rawCheckout(b);
        expect(r.status).toBe(202);
        orders.push((r.body as { orderId: string }).orderId);
      }
      try {
        await control.pause('notification-router');
        for (const [i, b] of buyers.entries()) {
          expect((await payOrder(b, orders[i])).status).toBe(202);
          await waitOrderStatus(b, orders[i], 'PAID', 'H3');
        }
        const stats = (await saleOf(drop.seller, drop.sale.id)).stats!;
        expect(stats.unitsSold).toBe(3);
        await staysTrue(
          'J03.H12',
          async () => {
            for (const b of buyers)
              expect(await itemsOf(b, 'order.confirmed')).toHaveLength(0);
          },
          'inboxes empty while the group is paused',
        );
        expect(await control.lag('notification-router')).toBeGreaterThanOrEqual(1);
      } finally {
        await control.resume('notification-router');
      }
      for (const b of buyers)
        await waitForItems('J03.H29', b, 'order.confirmed');
      await waitForItems('J03.H12', drop.seller.owner, 'shop.order_received', 3);
      await control.replay('notification-router', new Date((await fixture.nowMs()) - 6 * 3_600_000));
      await control.waitCaughtUp('notification-router');
      for (const b of buyers)
        await staysExactly('J03.H12', b, 'order.confirmed', 1);
      await staysExactly('J03.H12', drop.seller.owner, 'shop.order_received', 3);
    });

    let lateBuyer: JourneyClient;
    let lateOrder: string;
  });

  describe('US4: an auction closes once, and its winner is settled', () => {
    interface Auction {
      seller: SellerFixture;
      product: FixtureProduct;
      auction: AuctionMember;
    }
    const INCREMENT = 500;

    const publicAuction = async (id: string): Promise<AuctionPublic> => {
      const reply = await new JourneyClient('anon@example.com').get(
        `/api/auctions/${id}`,
        { schema: auctionPublicSchema },
      );
      if (reply.status !== 200)
        throw new Error(`auction: ${reply.status} ${JSON.stringify(reply.body)}`);
      return reply.body as AuctionPublic;
    };
    const memberAuction = async (seller: SellerFixture, id: string) => {
      const reply = await seller.owner.get(
        `/api/shops/${seller.shopId}/auctions/${id}`,
        { schema: auctionMemberSchema },
      );
      if (reply.status !== 200)
        throw new Error(`member auction: ${reply.status} ${JSON.stringify(reply.body)}`);
      return reply.body as AuctionMember;
    };
    const waitAuction = (
      hop: 'J03.H23' | 'J03.H26' | 'J03.H27' | 'J03.H28',
      id: string,
      status: AuctionPublic['status'],
    ) =>
      waitForContract(
        hop,
        async () => {
          const a = await publicAuction(id);
          return a.status === status ? a : null;
        },
        `auction ${id} ${status}`,
      );
    const bid = (
      buyer: JourneyClient,
      id: string,
      maxAmountMinor: number,
      key: string = randomUUID(),
    ) =>
      buyer.post(`/api/auctions/${id}/bids`, {
        body: { maxAmountMinor },
        key,
        schema: bidResultSchema,
      });
    const mustBid = async (
      buyer: JourneyClient,
      id: string,
      maxAmountMinor: number,
    ) => {
      const reply = await bid(buyer, id, maxAmountMinor);
      if (reply.status !== 200)
        throw new Error(`bid: ${reply.status} ${JSON.stringify(reply.body)}`);
      return reply.body as BidResult;
    };
    const ordersOf = async (buyer: JourneyClient) => {
      const reply = await buyer.get('/api/orders', { schema: orderPageSchema });
      if (reply.status !== 200)
        throw new Error(`orders: ${reply.status} ${JSON.stringify(reply.body)}`);
      return (reply.body as { items: { id: string; status: string; totalMinor: number }[] }).items;
    };
    const advanceTo = async (isoOrMs: string | number, afterSec = 1) => {
      const target = typeof isoOrMs === 'string' ? Date.parse(isoOrMs) : isoOrMs;
      const seconds = Math.ceil((target - (await fixture.nowMs())) / 1000) + afterSec;
      if (seconds > 0) await control.advance(seconds);
    };
    /** A shop on the plan that carries the `auctions` entitlement, with one product of `stock` units. */
    const auctionSeller = async (stock = 3): Promise<{ seller: SellerFixture; product: FixtureProduct }> => {
      const seller = await createSeller(admin, {
        products: [{ priceMinor: 5_000, quantity: stock }],
        staff: true,
      });
      const accepted = await subscribe(
        { owner: seller.owner, shopId: seller.shopId, slug: seller.slug },
        'pm_test_visa',
      );
      expect(accepted.status).toBe(201);
      return { seller, product: seller.products[0] };
    };
    /** Creates an auction; the entitlement reaches the shop with the billing event, so a `403` is retried. */
    const createEntitled = (
      seller: SellerFixture,
      product: FixtureProduct,
      options: Parameters<LaunchFixture['createAuction']>[2] = {},
    ) =>
      waitFor(
        async () => {
          try {
            return await fixture.createAuction(seller, product, {
              minIncrementMinor: INCREMENT,
              ...options,
            });
          } catch (error) {
            if (/entitlement_required|: 403/.test(String(error))) return null;
            throw error;
          }
        },
        { timeoutMs: 20_000, intervalMs: 500, description: 'auctions entitlement' },
      );
    const newAuction = async (
      options: {
        stock?: number;
        reservePriceMinor?: number;
        durationSec?: number;
        startsInSec?: number;
      } = {},
    ): Promise<Auction> => {
      const { seller, product } = await auctionSeller(options.stock ?? 3);
      const auction = await createEntitled(seller, product, options);
      return { seller, product, auction };
    };
    const openAuction = async (a: Auction) => {
      await advanceTo(a.auction.startsAt);
      return waitForContract(
        'J03.H23',
        async () => {
          const view = await publicAuction(a.auction.id);
          return view.status === 'OPEN' ? view : null;
        },
        'auction OPEN',
      );
    };
    /** An auction already past its end with `winner` leading above the reserve and `runnerUp` below. */
    const closedAuction = async (
      winnerMax: number,
      runnerUpMax: number | null,
      options: { reservePriceMinor?: number } = {},
    ) => {
      const a = await newAuction({ reservePriceMinor: options.reservePriceMinor ?? 1_000 });
      await openAuction(a);
      const winner = await JourneyClient.signUp('winner');
      const runnerUp = runnerUpMax ? await JourneyClient.signUp('runnerup') : undefined;
      if (runnerUp) await mustBid(runnerUp, a.auction.id, runnerUpMax!);
      await mustBid(winner, a.auction.id, winnerMax);
      await advanceTo(a.auction.endsAt);
      await waitAuction('J03.H23', a.auction.id, 'CLOSED');
      return { ...a, winner, runnerUp };
    };
    const winnerOrder = async (buyer: JourneyClient) =>
      waitForContract(
        'J03.H24',
        async () => (await ordersOf(buyer))[0] ?? null,
        'winner order',
      );

    let main: Auction;
    let b1: JourneyClient;
    let b2: JourneyClient;
    let b3: JourneyClient;
    let mainEnd: string;

    it('J03 AS-27: the unit leaves the shelf once; the auction opens at its start', async () => {
      const { seller, product } = await auctionSeller(3);
      const key = randomUUID();
      const first = await createEntitled(seller, product, {
        reservePriceMinor: 1_000,
        key,
      });
      const body = {
        productId: product.id,
        title: first.title,
        startingPriceMinor: first.startingPriceMinor,
        minIncrementMinor: INCREMENT,
        reservePriceMinor: 1_000,
        startsAt: first.startsAt,
        endsAt: first.endsAt,
      };
      const again = await Promise.all(
        Array.from({ length: 5 }, () =>
          seller.owner.post(`/api/shops/${seller.shopId}/auctions`, { body, key }),
        ),
      );
      for (const r of again) {
        expect([200, 201]).toContain(r.status);
        expect((r.body as { id: string }).id).toBe(first.id);
      }
      await waitForContract(
        'J03.H28',
        async () => ((await stockOf(seller, product.id)) === 2 ? true : null),
        'stock lowered once',
      );
      const second = await seller.owner.post(`/api/shops/${seller.shopId}/auctions`, {
        body: { ...body, title: `${first.title} again` },
        key: randomUUID(),
      });
      expect(second.status).toBe(409);
      expect(problemCode(second.body)).toBe('auction_exists_for_product');
      expect(await stockOf(seller, product.id)).toBe(2);

      const plain = await createSeller(admin, {
        products: [{ priceMinor: 5_000, quantity: 1 }],
      });
      const refused = await plain.owner.post(`/api/shops/${plain.shopId}/auctions`, {
        body: { ...body, productId: plain.products[0].id },
        key: randomUUID(),
      });
      expect(refused.status).toBe(403);
      expect(problemCode(refused.body)).toBe('entitlement_required');

      main = { seller, product, auction: first };
      expect((await publicAuction(first.id)).status).toBe('SCHEDULED');
      const open = await openAuction(main);
      expect(open.priceMinor).toBe(first.startingPriceMinor);
    });

    it('J03 AS-28: bids move the proxy price; the outbid leader is told once', async () => {
      [b1, b2, b3] = await newBuyers(3);
      const viewer = await sseClient(b2, topics.auction(main.auction.id));
      const r1 = await mustBid(b1, main.auction.id, 10_000);
      expect(r1.outcome).toBe('leading');
      expect(r1.priceMinor).toBe(1_000);
      const r2 = await mustBid(b2, main.auction.id, 5_000);
      expect(r2.outcome).toBe('outbid');
      expect(r2.priceMinor).toBe(5_000 + INCREMENT);
      const key = randomUUID();
      const racers = await Promise.all(
        Array.from({ length: 5 }, () => bid(b3, main.auction.id, 12_000, key)),
      );
      // a duplicate that arrives while the first is still running is refused with 409 (idempotency in progress)
      for (const r of racers) expect([200, 409]).toContain(r.status);
      expect(racers.some((r) => r.status === 200)).toBe(true);
      const replay = await bid(b3, main.auction.id, 12_000, key);
      expect(replay.status).toBe(200);
      expect((replay.body as BidResult).priceMinor).toBe(10_500);
      const view = await waitForContract(
        'J03.H21',
        async () => {
          const a = await publicAuction(main.auction.id);
          return a.bidCount >= 3 ? a : null;
        },
        'three bids',
      );
      expect(view.priceMinor).toBe(10_500);
      expect(view.bidCount).toBe(3);
      expect(view.leaderAlias).toBeTruthy();
      expect(JSON.stringify(view)).not.toMatch(/12000|userId/);
      await expectEvent(viewer, 'J03.H21', 'price', (d) => d.priceMinor === 10_500);
      viewer.close();
      await waitForItems('J03.H22', b1, 'auction.outbid');
      await staysExactly('J03.H22', b1, 'auction.outbid', 1);
      for (const quiet of [b2, b3])
        expect(await itemsOf(quiet, 'auction.outbid')).toHaveLength(0);
      await mustBid(b1, main.auction.id, 11_000); // B1 raises the own maximum: still not the leader
      await staysExactly('J03.H22', b3, 'auction.outbid', 0);
    });

    it('J03 AS-30: anti-sniping moves the end; the original close job is a no-op', async () => {
      const original = (await publicAuction(main.auction.id)).endsAt;
      await advanceTo(Date.parse(original) - 90_000, 0);
      const sniped = await bid(b2, main.auction.id, 13_000);
      expect({ status: sniped.status, body: sniped.body }).toMatchObject({ status: 200 });
      const moved = (sniped.body as BidResult).endsAt;
      expect(Date.parse(moved)).toBeGreaterThan(Date.parse(original));
      expect((await publicAuction(main.auction.id)).endsAt).toBe(moved);
      await advanceTo(original, 5);
      expect((await publicAuction(main.auction.id)).status).toBe('OPEN');
      await staysTrue(
        'J03.H23',
        async () => {
          expect(
            await eventTap('auctions.events', { type: 'auction.closed', key: main.auction.id }),
          ).toHaveLength(0);
        },
        'no auction.closed at the original end',
      );
      mainEnd = moved;
    });

    it('J03 AS-31: the close gives one result, one order, one notice', async () => {
      await advanceTo(mainEnd);
      const closed = await waitAuction('J03.H23', main.auction.id, 'CLOSED');
      expect(closed.priceMinor).toBeGreaterThanOrEqual(5_000);
      expect(closed.priceMinor).toBeLessThanOrEqual(13_000);
      const order = await winnerOrder(b2);
      expect(order.status).toBe('RESERVED');
      const full = await getOrder(b2, order.id);
      expect(full.totalMinor).toBe(closed.priceMinor);
      expect(full.items).toHaveLength(1);
      expect(full.items[0].discountMinor).toBe(0);
      expect(Date.parse(full.reservedUntil!) - (await fixture.nowMs())).toBeGreaterThan(47 * 3_600_000);
      expect((await memberAuction(main.seller, main.auction.id)).winnerOrderId).toBe(order.id);
      await waitForItems('J03.H25', b2, 'auction.won');
      await staysExactly('J03.H25', b2, 'auction.won', 1);
      for (const other of [b1, b3])
        expect(await itemsOf(other, 'auction.won')).toHaveLength(0);
      expect(await stockOf(main.seller, main.product.id)).toBe(2);
    });

    it('J03 AS-32: a close delivered many times closes once', async () => {
      const a = await newAuction({ reservePriceMinor: 1_000 });
      await openAuction(a);
      const winner = await JourneyClient.signUp('winner');
      await mustBid(winner, a.auction.id, 4_000);
      await advanceTo(a.auction.endsAt);
      await Promise.all([
        control.runJob('auctions.sweep-due'),
        control.runJob('auctions.sweep-due'),
        control.runJob('auctions.sweep-due'),
      ]);
      await waitAuction('J03.H23', a.auction.id, 'CLOSED');
      await control.runJob('auctions.sweep-due');
      await waitForItems('J03.H25', winner, 'auction.won');
      await staysExactly('J03.H25', winner, 'auction.won', 1);
      expect(await ordersOf(winner)).toHaveLength(1);
      const closed = await countExactlyOnce(control, 'auctions.events', 'auction.closed', a.auction.id);
      expect(closed).toHaveLength(1);
      expect(await stockOf(a.seller, a.product.id)).toBe(2);
    });

    it('J03 AS-33: the winner pays; the auction is sold and everyone is told', async () => {
      const order = await winnerOrder(b2);
      expect((await payOrder(b2, order.id)).status).toBe(202);
      const sold = await waitAuction('J03.H26', main.auction.id, 'SOLD');
      expect(sold.status).toBe('SOLD');
      expect((await memberAuction(main.seller, main.auction.id)).winnerOrderId).toBe(order.id);
      await waitForItems('J03.H26', main.seller.owner, 'auction.sold');
      await waitForItems('J03.H26', main.seller.owner, 'shop.order_received');
      await waitForItems('J03.H26', b2, 'order.confirmed');
      await staysExactly('J03.H26', main.seller.owner, 'auction.sold', 1);
      await staysExactly('J03.H26', main.seller.owner, 'shop.order_received', 1);
      await staysExactly('J03.H26', b2, 'order.confirmed', 1);
      expect(await stockOf(main.seller, main.product.id)).toBe(2);
      const again = await payOrder(b2, order.id);
      expect(again.status).toBeLessThan(500);
      await staysExactly('J03.H26', main.seller.owner, 'auction.sold', 1);
      expect((await publicAuction(main.auction.id)).status).toBe('SOLD');
    });

    // AS-29 uses its own auction and moves the stack clock past the end of AU, so it runs after AU is sold (AS-33).
    it('J03 AS-29: the seller team cannot bid; a leader who joins the team before the end is not awarded', async () => {
      const a = await newAuction({ reservePriceMinor: 1_000 });
      await openAuction(a);
      const leader = await JourneyClient.signUp('leader');
      await mustBid(leader, a.auction.id, 6_000);
      const before = await publicAuction(a.auction.id);
      const refused = await bid(a.seller.staff!, a.auction.id, 9_000);
      expect(refused.status).toBe(403);
      expect(problemCode(refused.body)).toBe('shill_bid_forbidden');
      expect((await publicAuction(a.auction.id)).priceMinor).toBe(before.priceMinor);
      await inviteAndAccept(a.seller.owner, a.seller.shopId, leader);
      await advanceTo(a.auction.endsAt);
      await waitAuction('J03.H23', a.auction.id, 'UNSOLD');
      expect((await memberAuction(a.seller, a.auction.id)).statusReason).toBe('leader_ineligible');
      await waitForContract(
        'J03.H28',
        async () => ((await stockOf(a.seller, a.product.id)) === 3 ? true : null),
        'unit returned',
      );
      expect(await ordersOf(leader)).toHaveLength(0);
      await staysExactly('J03.H25', leader, 'auction.won', 0);
      expect(await stockOf(a.seller, a.product.id)).toBe(3);
    });

    it('J03 AS-34: a winner who does not pay loses the unit to the runner-up, who pays; or the unit returns', async () => {
      const a = await closedAuction(10_000, 5_000);
      const order = await winnerOrder(a.winner);
      expect(order.status).toBe('RESERVED');
      await control.advance(48 * 3_600 + 120);
      await waitAuction('J03.H27', a.auction.id, 'SECOND_CHANCE');
      const offer = await waitForContract(
        'J03.H27',
        async () => (await ordersOf(a.runnerUp!))[0] ?? null,
        'runner-up order',
      );
      expect(offer.totalMinor).toBe(5_000);
      const full = await getOrder(a.runnerUp!, offer.id);
      expect(Date.parse(full.reservedUntil!) - (await fixture.nowMs())).toBeGreaterThan(23 * 3_600_000);
      await waitForItems('J03.H27', a.runnerUp!, 'auction.second_chance');
      await waitForItems('J03.H27', a.winner, 'order.cancelled');
      expect(await ordersOf(a.runnerUp!)).toHaveLength(1);
      expect((await payOrder(a.runnerUp!, offer.id)).status).toBe(202);
      await waitAuction('J03.H26', a.auction.id, 'SOLD');
      await waitForItems('J03.H26', a.seller.owner, 'auction.sold');
      await control.replay('auctions-order-results', new Date((await fixture.nowMs()) - 6 * 3_600_000));
      await control.waitCaughtUp('auctions-order-results');
      expect((await publicAuction(a.auction.id)).status).toBe('SOLD');

      const u = await closedAuction(10_000, 5_000);
      await winnerOrder(u.winner);
      await control.advance(48 * 3_600 + 120);
      await waitAuction('J03.H27', u.auction.id, 'SECOND_CHANCE');
      await control.advance(24 * 3_600 + 120);
      await waitAuction('J03.H28', u.auction.id, 'UNSOLD');
      expect((await memberAuction(u.seller, u.auction.id)).statusReason).toBe('second_chance_unpaid');
      await waitForContract(
        'J03.H28',
        async () => ((await stockOf(u.seller, u.product.id)) === 3 ? true : null),
        'unit returned once',
      );
      expect(await ordersOf(u.runnerUp!)).toHaveLength(1);
      await staysTrue(
        'J03.H28',
        async () => expect(await stockOf(u.seller, u.product.id)).toBe(3),
        'stock stays returned once',
      );
    });

    it('J03 AS-35: a reserve not met leaves no winner, no order, no notice, and the unit returns', async () => {
      const a = await newAuction({ reservePriceMinor: 3_000 });
      await openAuction(a);
      const bidder = await JourneyClient.signUp('bidder');
      await mustBid(bidder, a.auction.id, 2_900);
      await advanceTo(a.auction.endsAt);
      await waitAuction('J03.H23', a.auction.id, 'UNSOLD');
      expect((await memberAuction(a.seller, a.auction.id)).statusReason).toBe('reserve_not_met');
      expect(await ordersOf(bidder)).toHaveLength(0);
      await staysExactly('J03.H25', bidder, 'auction.won', 0);
      await waitForContract(
        'J03.H28',
        async () => ((await stockOf(a.seller, a.product.id)) === 3 ? true : null),
        'unit returned',
      );
      const closed = await tapUntil('J03.H23', 'auctions.events', { type: 'auction.closed', key: a.auction.id });
      expect(closed).toHaveLength(1);
      expect(closed[0].payload).toMatchObject({ status: 'UNSOLD', reason: 'reserve_not_met' });
    });

    it('J03 AS-36: with the settlement consumer down the sale waits; replays and duplicates change nothing', async () => {
      const a = await closedAuction(8_000, null);
      const order = await winnerOrder(a.winner);
      try {
        await control.pause('auctions-order-results');
        expect((await payOrder(a.winner, order.id)).status).toBe(202);
        await waitOrderStatus(a.winner, order.id, 'PAID', 'H3');
        expect((await publicAuction(a.auction.id)).status).toBe('CLOSED');
        await waitForContract(
          'J03.H29',
          async () => ((await control.lag('auctions-order-results')) >= 1 ? true : null),
          'lag of the paused settlement consumer',
        );
        expect((await publicAuction(a.auction.id)).status).toBe('CLOSED');
      } finally {
        await control.resume('auctions-order-results');
      }
      await waitAuction('J03.H26', a.auction.id, 'SOLD');
      await control.replay('auctions-order-results', new Date((await fixture.nowMs()) - 6 * 3_600_000));
      await control.waitCaughtUp('auctions-order-results');
      const view = await memberAuction(a.seller, a.auction.id);
      expect(view.status).toBe('SOLD');
      expect(view.winnerOrderId).toBe(order.id);
      await tapUntil('J03.H26', 'auctions.events', { type: 'auction.sold', key: a.auction.id });
      await staysTrue(
        'J03.H26',
        async () => {
          expect(
            await eventTap('auctions.events', { type: 'auction.sold', key: a.auction.id }),
          ).toHaveLength(1);
        },
        'one auction.sold after the replay',
      );
    });
  });
});
