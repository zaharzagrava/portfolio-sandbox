import * as jwt from 'jsonwebtoken';
import { v4 } from 'uuid';
import { queueStatusSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { DistributedLock } from '@app/infrastructure/cache';
import { QUEUE_STORE, type QueueStore } from './domain/ports';
import {
  SECOND,
  createLaunchApp,
  expectContract,
  expectProblem,
  type EventView,
  type LaunchTestApp,
} from './testing/launch-events-test-kit';

jest.setTimeout(180_000); // the suites create hundreds of people through the real stores

describe('Launch events: waiting room, admission rate and load shedding', () => {
  let t: LaunchTestApp;
  beforeAll(async () => {
    t = await createLaunchApp();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(() => {
    for (const store of Object.values(t.stores)) store.up();
    t.human.mode = 'ok';
    t.human.valid.clear();
    t.human.calls.length = 0;
    t.settings.queueMaxLength = 2_000_000;
    t.published.length = 0;
  });

  const queue = () => t.app.get<QueueStore>(QUEUE_STORE);
  const length = (eventId: string) => queue().length(eventId);
  const problem = expectProblem;
  /** Joins with a clock tick between buyers so the join order is the score order. */
  const joinInOrder = async (event: { id: string }, n: number) => {
    const people = await t.buyers(n);
    const tickets: string[] = [];
    for (const person of people) {
      const res = await t.join(event, person).expect(201);
      tickets.push(res.body.ticket);
      t.clock.advance(1);
    }
    return { people, tickets };
  };
  const rowCount = async (table: string) =>
    Number(
      (
        await t.rows<{ n: string }>(
          `SELECT count(*)::text AS n FROM "${table}"`,
        )
      )[0].n,
    );

  // ------------------------------------------------------------------------------------------------- AS-01

  it('S22 AS-01: a join answers 201 with the position, estimate and heartbeat, and touches only the queue store', async () => {
    const s = await t.seller();
    const event = await t.onSale(s);
    const buyer = await t.buyer();
    const before = {
      events: await rowCount('LaunchEvent'),
      bookings: await rowCount('Booking'),
      history: await rowCount('LaunchEventHistory'),
    };
    for (const store of Object.values(t.stores)) store.reset();

    const res = await t.join(event, buyer).expect(201);
    const body = expectContract(queueStatusSchema, res.body);
    expect(body).toMatchObject({
      admitted: false,
      position: 1,
      queueLength: 1,
      etaSeconds: 1,
      heartbeatSeconds: 120,
    });
    expect(body.expiresAt).toBe(
      new Date(t.clock.nowMs() + 120_000).toISOString(),
    );
    expect(res.headers.location).toBe(
      `/api/launch-events/${event.id}/queue/${body.ticket}`,
    );
    expect(await length(event.id)).toBe(1);
    expect(await rowCount('LaunchEvent')).toBe(before.events);
    expect(await rowCount('Booking')).toBe(before.bookings);
    expect(await rowCount('LaunchEventHistory')).toBe(before.history);
    for (const name of [
      'events',
      'bookings',
      'ledger',
      'locks',
      'map',
      'quota',
    ] as const)
      expect(t.stores[name].count()).toBe(0);
    expect(t.stores.queue.count()).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------------------------------------- AS-02

  it('S22 AS-02: a repeat join returns the same ticket and position', async () => {
    const s = await t.seller();
    const event = await t.onSale(s);
    const [a, b] = await t.buyers(2);
    const first = await t.join(event, a).expect(201);
    await t.join(event, b).expect(201);
    const again = await t.join(event, a).expect(200);
    expect(again.body.ticket).toBe(first.body.ticket);
    expect(again.body.position).toBe(first.body.position);
    expect(await length(event.id)).toBe(2);
  });

  it('S22 AS-02: 20 joins at once by one buyer make one ticket (20 runs)', async () => {
    const s = await t.seller();
    const event = await t.onSale(s);
    for (let run = 0; run < 20; run++) {
      const buyer = await t.buyer();
      const before = await length(event.id);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => t.join(event, buyer)),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 200)).toHaveLength(19);
      expect(new Set(results.map((r) => r.body.ticket)).size).toBe(1);
      expect(await length(event.id)).toBe(before + 1);
    }
  });

  // ------------------------------------------------------------------------------------------------- AS-04

  it('S22 AS-04: admits exactly the rate per second, in order, and never more in one second', async () => {
    const s = await t.seller();
    const event = await t.onSale(s, { admissionRatePerSec: 10 });
    await t.advance(2 * SECOND); // past the pre-sale second: later joins follow join order
    const { people, tickets } = await joinInOrder(event, 100);

    expect(await t.admitter.admitEvent(event.id)).toBe(10);
    expect(await t.admitter.admitEvent(event.id)).toBe(0); // the same second: never 11
    const admitted: boolean[] = [];
    for (let i = 0; i < people.length; i++)
      admitted.push(
        (await t.status(event, people[i], tickets[i]).expect(200)).body
          .admitted,
      );
    expect(admitted.slice(0, 10).every(Boolean)).toBe(true);
    expect(admitted.slice(10).some(Boolean)).toBe(false);

    await t.advance(SECOND);
    expect(await t.admitter.admitEvent(event.id)).toBe(10);
  });

  it('S22 AS-04: fewer waiting than the rate admits all of them', async () => {
    const s = await t.seller();
    const event = await t.onSale(s, { admissionRatePerSec: 10 });
    await joinInOrder(event, 4);
    expect(await t.admitter.admitEvent(event.id)).toBe(4);
  });

  it('S22 AS-04: after 5 s of downtime the next second admits at most the rate (no catch-up burst)', async () => {
    const s = await t.seller();
    const event = await t.onSale(s, { admissionRatePerSec: 10 });
    await joinInOrder(event, 60);
    expect(await t.admitter.admitEvent(event.id)).toBe(10);
    await t.advance(5 * SECOND);
    expect(await t.admitter.admitEvent(event.id)).toBe(10);
    expect(await t.admitter.admitEvent(event.id)).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------- AS-05

  it('S22 AS-05: the admission token has the pinned profile, is delivered by status and pushed once', async () => {
    const s = await t.seller();
    const event = await t.onSale(s);
    const buyer = await t.buyer();
    const joined = await t.join(event, buyer).expect(201);
    await t.admitter.admitEvent(event.id);

    const status = expectContract(
      queueStatusSchema,
      (await t.status(event, buyer, joined.body.ticket).expect(200)).body,
    );
    expect(status.admitted).toBe(true);
    const decoded = jwt.decode(status.admissionToken!, { complete: true })!;
    expect(decoded.header).toMatchObject({ alg: 'ES256' });
    const claims = decoded.payload as Record<string, unknown>;
    expect(claims).toMatchObject({
      iss: 'marketplace',
      aud: `admission:${event.id}`,
      sub: buyer.id,
      jti: joined.body.ticket,
      purpose: 'admission',
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(600);
    expect(status.tokenExpiresAt).toBe(
      new Date((claims.exp as number) * 1000).toISOString(),
    );

    const pushes = t.published.filter(
      (p) => p.topic === `queue:${joined.body.ticket}`,
    );
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      type: 'admitted',
      data: {
        eventId: event.id,
        admissionToken: status.admissionToken,
        tokenExpiresAt: status.tokenExpiresAt,
      },
    });
  });

  it('S22 AS-05: after the token lifetime the hold is refused and a new join takes a new ticket at the back', async () => {
    const s = await t.seller();
    const event = await t.onSale(s);
    const buyer = await t.buyer();
    const token = await t.admit(event, buyer);
    const old = (await t.join(event, buyer).expect(200)).body.ticket;
    await t.advance(606 * SECOND); // 10 minutes plus the 5 s clock tolerance every token check has
    const res = await t.hold(event, buyer, token, { seats: [1] }).expect(403);
    expect(res.body.code).toBe('ADMISSION_REQUIRED');
    const fresh = await t.join(event, buyer).expect(201);
    expect(fresh.body.ticket).not.toBe(old);
  });

  // ------------------------------------------------------------------------------------------------- AS-06

  it('S22 AS-06: positions are within 16 of the true rank, never increase after opening, and the estimate is ceil(position / rate)', async () => {
    const s = await t.seller();
    const event = await t.onSale(s, { admissionRatePerSec: 7 });
    await t.advance(2 * SECOND);
    const { people, tickets } = await joinInOrder(event, 200);

    const poll = async () =>
      Promise.all(
        people.map(async (p, i) => {
          const res = await t.status(event, p, tickets[i]).expect(200);
          return res.body as {
            admitted: boolean;
            position?: number;
            etaSeconds?: number;
          };
        }),
      );
    const first = await poll();
    first.forEach((st, i) => {
      expect(Math.abs(st.position! - (i + 1))).toBeLessThanOrEqual(16);
      expect(st.etaSeconds).toBe(Math.ceil(st.position! / 7));
    });
    await t.advance(SECOND);
    await t.admitter.admitEvent(event.id);
    const second = await poll();
    second.forEach((st, i) => {
      if (st.admitted) return;
      expect(st.position!).toBeLessThanOrEqual(first[i].position!);
    });
    expect(second.filter((st) => st.admitted)).toHaveLength(7);
  });

  // ------------------------------------------------------------------------------------------------- AS-07

  it('S22 AS-07: a silent ticket is skipped without using capacity; polling keeps one; a returning owner gets 404 then a fresh ticket', async () => {
    const s = await t.seller();
    const event = await t.onSale(s, { admissionRatePerSec: 1 });
    await t.advance(2 * SECOND);
    const { people, tickets } = await joinInOrder(event, 2);
    await t.advance(100 * SECOND);
    await t.status(event, people[1], tickets[1]).expect(200); // the second one keeps polling
    await t.advance(21 * SECOND);

    expect(await t.admitter.admitEvent(event.id)).toBe(1); // the silent first is skipped, the second takes its place
    const second = await t.status(event, people[1], tickets[1]).expect(200);
    expect(second.body.admitted).toBe(true);
    const gone = await t.status(event, people[0], tickets[0]).expect(404);
    expect(gone.body.code).toBe('TICKET_NOT_FOUND');
    const again = await t.join(event, people[0]).expect(201);
    expect(again.body.ticket).not.toBe(tickets[0]);
  });

  // ------------------------------------------------------------------------------------------------- AS-08

  it('S22 AS-08: racing admitters admit at most the rate each second and no ticket twice (20 runs, then 10 seconds)', async () => {
    const s = await t.seller();
    for (let run = 0; run < 20; run++) {
      const event = await t.onSale(s, { admissionRatePerSec: 5 });
      await joinInOrder(event, 12);
      const counts = await Promise.all([
        t.admitter.admitEvent(event.id),
        t.admitter.admitEvent(event.id),
        t.admitter.admitEvent(event.id),
      ]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
    }
    const event = await t.onSale(s, { admissionRatePerSec: 4 });
    await t.advance(2 * SECOND);
    const { people, tickets } = await joinInOrder(event, 80);
    let total = 0;
    for (let second = 0; second < 10; second++) {
      const counts = await Promise.all([
        t.admitter.admitEvent(event.id),
        t.admitter.admitEvent(event.id),
      ]);
      total += counts.reduce((a, b) => a + b, 0);
      await t.advance(SECOND);
    }
    expect(total).toBeLessThanOrEqual(10 * 4);
    const admittedNow = (
      await Promise.all(
        people.map(
          async (p, i) => (await t.status(event, p, tickets[i])).body.admitted,
        ),
      )
    ).filter(Boolean).length;
    expect(admittedNow).toBe(total);
  });

  it('S22 AS-08: a paused admitter whose lease lapsed is refused with its old fence and admits nothing', async () => {
    const s = await t.seller();
    const event = await t.onSale(s, { admissionRatePerSec: 5 });
    await joinInOrder(event, 20);
    const locks = t.app.get(DistributedLock);
    const stale = (await locks.tryAcquire(`launch-admit:${event.id}`, {
      ttlMs: 5_000,
    }))!;
    await stale.release(); // its lease lapsed while it was paused

    expect(await t.admitter.admitEvent(event.id)).toBe(5); // another instance took over with a newer fence
    const staleBefore =
      MetricsRegistry.value('launch_admission_stale_leader_total') ?? 0;
    await t.advance(SECOND);
    const gate = await t.app.get(QUEUE_STORE).length(event.id);
    expect(gate).toBe(15);
    const resumed = await t.admitter.admitWithFence(
      {
        eventId: event.id,
        shopId: s.shopId,
        status: 'ON_SALE',
        salesOpenAtMs: 0,
        startsAtMs: 0,
        seatCount: 800,
        seatsPerRow: 20,
        seatingMode: 'SEATED',
        perUserLimit: 2,
        admissionRatePerSec: 5,
        humanCheckRequired: false,
      },
      stale.fence,
    );
    expect(resumed).toBe(0);
    expect(await length(event.id)).toBe(15);
    expect(MetricsRegistry.value('launch_admission_stale_leader_total')).toBe(
      staleBefore + 1,
    );
  });

  // ------------------------------------------------------------------------------------------------- AS-09

  it('S22 AS-09: bad ids, unknown events, missing credentials and closed or sold-out events are refused with nothing queued', async () => {
    const s = await t.seller();
    const buyer = await t.buyer();
    const bad = await t
      .http()
      .post('/api/launch-events/not-a-uuid/queue')
      .set(buyer.auth)
      .expect(400);
    expect(bad.body.code).toBe('validation_failed');
    const unknown = await t
      .http()
      .post(`/api/launch-events/${v4()}/queue`)
      .set(buyer.auth)
      .expect(404);
    expect(unknown.body.code).toBe('EVENT_NOT_FOUND');
    const event = await t.onSale(s);
    await t.http().post(`/api/launch-events/${event.id}/queue`).expect(401);

    await t
      .http()
      .post(`/api/shops/${s.shopId}/launch-events/${event.id}/close`)
      .set(s.auth)
      .expect(200);
    const closed = await t.join(event, buyer).expect(409);
    expect(closed.body.code).toBe('EVENT_CLOSED');
    expect(await length(event.id)).toBe(0);

    const small = await t.onSale(s, {
      seatCount: 2,
      perUserLimit: 2,
      seatsPerRow: 2,
    });
    const token = await t.admit(small, buyer);
    const hold = await t
      .hold(small, buyer, token, { seats: [0, 1] })
      .expect(201);
    await t.confirm(hold.body.holdId, buyer).expect(201);
    const other = await t.buyer();
    const soldOut = await t.join(small, other).expect(409);
    expect(soldOut.body.code).toBe('EVENT_SOLD_OUT');
    expect(await length(small.id)).toBeLessThanOrEqual(1); // only the buyer's own earlier ticket
  });

  // ------------------------------------------------------------------------------------------------- AS-10

  it('S22 AS-10: a ticket is visible to its owner only; every other case is the same 404', async () => {
    const s = await t.seller();
    const event = await t.onSale(s);
    const other = await t.onSale(s);
    const [a, b] = await t.buyers(2);
    const mine = (await t.join(event, a).expect(201)).body.ticket;

    const stranger = await t.status(event, b, mine).expect(404);
    const unknown = await t.status(event, b, v4()).expect(404);
    const wrongEvent = await t.status(other, a, mine).expect(404);
    for (const res of [stranger, unknown, wrongEvent]) {
      const p = problem(res.body);
      expect(p.code).toBe('TICKET_NOT_FOUND');
      expect({ status: p.status, title: p.title, detail: p.detail }).toEqual({
        status: 404,
        title: 'Not found',
        detail: 'Ticket not found.',
      });
    }
    await t
      .http()
      .get(`/api/launch-events/${event.id}/queue/${mine}`)
      .expect(401);
    await t.status(event, a, mine).expect(200);
  });

  // ------------------------------------------------------------------------------------------------- AS-11

  it('S22 AS-11: a full room sheds new joins with 503 and Retry-After, serves ticket holders, touches no other store', async () => {
    const s = await t.seller();
    const event = await t.onSale(s);
    t.settings.queueMaxLength = 3;
    const people = await t.buyers(4);
    for (const p of people.slice(0, 3)) await t.join(event, p).expect(201);
    for (const store of Object.values(t.stores)) store.reset();

    const shed = await t.join(event, people[3]).expect(503);
    expect(shed.body.code).toBe('WAITING_ROOM_FULL');
    expect(shed.headers['retry-after']).toBe('5');
    expect(await length(event.id)).toBe(3);
    for (const name of [
      'events',
      'bookings',
      'ledger',
      'locks',
      'map',
      'quota',
    ] as const)
      expect(t.stores[name].count()).toBe(0);
    await t.join(event, people[0]).expect(200); // an existing ticket still works
  });

  it('S22 AS-11: with the queue store down the answer is 503 WAITING_ROOM_UNAVAILABLE, generic, and nothing else is queried', async () => {
    const s = await t.seller();
    const event = await t.onSale(s);
    const buyer = await t.buyer();
    t.stores.queue.down();
    t.stores.gate.down();
    for (const store of Object.values(t.stores)) store.reset();

    const res = await t.join(event, buyer).expect(503);
    expect(res.body.code).toBe('WAITING_ROOM_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('2');
    expect(JSON.stringify(res.body)).not.toMatch(/is down|redis|econn/i);
    for (const name of [
      'events',
      'bookings',
      'ledger',
      'locks',
      'map',
      'quota',
    ] as const)
      expect(t.stores[name].count()).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------- AS-12

  it('S22 AS-12: the 11th join of one buyer within a minute is 429 with Retry-After', async () => {
    const s = await t.seller();
    const buyer = await t.buyer();
    const events: EventView[] = [];
    for (let i = 0; i < 11; i++) events.push(await t.onSale(s));
    for (const event of events.slice(0, 10))
      await t.join(event, buyer).expect(201);
    const res = await t.join(events[10], buyer).expect(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(problem(res.body).status).toBe(429);
    expect(await length(events[10].id)).toBe(0);
  });

  it('S22 AS-12: with the limiter down joins go on (fail open) and the failure is counted', async () => {
    const s = await t.seller();
    const event = await t.onSale(s);
    const buyer = await t.buyer();
    const before =
      MetricsRegistry.value('launch_limiter_failures_total', {
        policy: 'launch.queue.join.user',
      }) ?? 0;
    t.stores.limiter.down();
    await t.join(event, buyer).expect(201);
    t.stores.limiter.up();
    expect(
      MetricsRegistry.value('launch_limiter_failures_total', {
        policy: 'launch.queue.join.user',
      }),
    ).toBe(before + 1);
  });

  // ------------------------------------------------------------------------------------------------- AS-13

  it('S22 AS-13: a bot-check result is required, verified, and accepted once; an event without the flag ignores the header', async () => {
    const s = await t.seller();
    const checked = await t.onSale(s, { humanCheckRequired: true });
    const plain = await t.onSale(s);
    const [a, b, c] = await t.buyers(3);

    const refused: Record<string, string>[] = [
      {},
      { 'X-Human-Check': 'rejected-result' },
      { 'X-Human-Check': 'x'.repeat(5000) },
    ];
    for (const headers of refused) {
      const res = await t.join(checked, a, headers).expect(403);
      expect(res.body.code).toBe('HUMAN_CHECK_FAILED');
    }
    expect(await length(checked.id)).toBe(0);
    const good = `good-${v4()}`; // results are remembered for an hour: a fixed text would collide with an earlier run
    t.human.valid.add(good);
    await t.join(checked, a, { 'X-Human-Check': good }).expect(201);
    const reused = await t
      .join(checked, b, { 'X-Human-Check': good })
      .expect(403);
    expect(reused.body.code).toBe('HUMAN_CHECK_FAILED');

    t.human.calls.length = 0;
    await t.join(plain, c, { 'X-Human-Check': 'whatever' }).expect(201);
    expect(t.human.calls).toHaveLength(0);
  });

  // ------------------------------------------------------------------------------------------------- AS-14

  it('S22 AS-14: a bot-check provider outage fails closed with 503, one attempt, nothing queued', async () => {
    const s = await t.seller();
    const event = await t.onSale(s, { humanCheckRequired: true });
    const buyer = await t.buyer();
    t.human.mode = 'down';
    const res = await t
      .join(event, buyer, { 'X-Human-Check': 'result-abc' })
      .expect(503);
    expect(res.body.code).toBe('WAITING_ROOM_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('2');
    expect(t.human.calls).toHaveLength(1);
    expect(await length(event.id)).toBe(0);
  });
});
