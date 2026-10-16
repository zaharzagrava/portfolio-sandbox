import * as jwt from 'jsonwebtoken';
import { v4 } from 'uuid';
import { PurposeTokenService } from '@app/domains/identity';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { holdSchema, seatMapDeltaSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { hasSeat } from './domain/seat-bitmap';
import { LaunchEventsModule } from './launch-events.module';
import { HOLD_LEDGER, type HoldLedger } from './domain/ports';
import {
  MINUTE,
  SECOND,
  createLaunchApp,
  expectContract,
  expectProblem,
  type LaunchTestApp,
  type Seller,
} from './testing/launch-events-test-kit';

const FAST = { admissionRatePerSec: 100_000 };

jest.setTimeout(180_000); // the suites create hundreds of people through the real stores

describe('Launch events: admission token, seat holds and ticket limits', () => {
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
    t.published.length = 0;
  });

  const ledger = () =>
    t.app.select(LaunchEventsModule).get<HoldLedger>(HOLD_LEDGER);
  const redis = () => t.app.get(RedisService).client;
  const mapOf = async (event: { id: string }) => {
    const body = (
      await t.http().get(`/api/launch-events/${event.id}/seatmap`).expect(200)
    ).body;
    return {
      seq: body.seq as number,
      bitmap: Buffer.from(body.bitmap, 'base64'),
    };
  };
  const shown = async (event: { id: string }, seat: number) =>
    hasSeat((await mapOf(event)).bitmap, seat);
  const sale = (overrides: Record<string, unknown> = {}) =>
    t.onSale(s, { ...FAST, ...overrides });
  /** A buyer with a token for the event. */
  const admitted = async (event: { id: string }) => {
    const who = await t.buyer();
    return { who, token: await t.admit(event, who) };
  };
  const records = async (event: { id: string }) =>
    (await ledger().records(event.id)).filter((r) => r.state !== 'FREE');
  const SERVICE_STORES = [
    'events',
    'bookings',
    'ledger',
    'locks',
    'map',
    'quota',
    'gate',
    'queue',
  ] as const;
  const untouched = () =>
    SERVICE_STORES.every((name) => t.stores[name].count() === 0);

  // ------------------------------------------------------------------------------------------------- AS-15

  it('S22 AS-15: holding specific seats answers 201, writes the ledger, shows the seats on the map and queues the expiry', async () => {
    const event = await sale();
    const { who, token } = await admitted(event);
    const before = (await mapOf(event)).seq;
    const res = await t
      .hold(event, who, token, { seats: [42, 43] })
      .expect(201);
    const hold = expectContract(holdSchema, res.body);
    expect(hold).toMatchObject({
      eventId: event.id,
      seats: [42, 43],
      limit: { perUser: 2, remaining: 0 },
    });
    expect(hold.expiresAt).toBe(
      new Date(t.clock.nowMs() + 10 * MINUTE).toISOString(),
    );
    expect(hold.serverTime).toBe(new Date(t.clock.nowMs()).toISOString());

    const stored = await ledger().get(hold.holdId);
    expect(stored).toMatchObject({
      state: 'HELD',
      userId: who.id,
      seats: [42, 43],
    });
    expect(
      (await records(event)).map((r) => [r.seat, r.holdId, r.fence]),
    ).toEqual([
      [42, hold.holdId, 1],
      [43, hold.holdId, 1],
    ]);
    expect(await shown(event, 42)).toBe(true);
    expect(await shown(event, 43)).toBe(true);
    expect(await shown(event, 44)).toBe(false);
    const delta = t.published.find(
      (p) => p.topic === `event:${event.id}:seatmap`,
    )!;
    expect(delta.type).toBe('seats');
    expect(expectContract(seatMapDeltaSchema, delta.data)).toMatchObject({
      change: 'held',
      seats: [42, 43],
    });
    expect((delta.data as { seq: number }).seq).toBeGreaterThan(before);
    expect(
      await t.probe.find('launch-events.expire-hold', { holdId: hold.holdId }),
    ).toHaveLength(1);
    expect(
      Number(
        (
          await t.rows<{ n: string }>(
            `SELECT count(*)::text AS n FROM "Booking" WHERE "holdId" = :id`,
            { id: hold.holdId },
          )
        )[0].n,
      ),
    ).toBe(0);
  });

  // ------------------------------------------------------------------------------------------------- AS-16

  it('S22 AS-16: 100 buyers click one seat: exactly one wins, 99 are told SEAT_TAKEN, quota untouched (20 runs)', async () => {
    const event = await sale({ perUserLimit: 2 });
    const people = await t.buyers(100);
    const tokens = await t.admitAll(event, people);
    for (let run = 0; run < 20; run++) {
      const seat = 100 + run;
      const results = await Promise.all(
        people.map((p, i) => t.hold(event, p, tokens[i], { seats: [seat] })),
      );
      const won = results.filter((r) => r.status === 201);
      const lost = results.filter((r) => r.status === 409);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(99);
      lost.forEach((r) =>
        expect(r.body).toMatchObject({ code: 'SEAT_TAKEN', seat }),
      );
      expect(
        (await records(event)).filter((r) => r.seat === seat),
      ).toHaveLength(1);
      const winner = people[results.findIndex((r) => r.status === 201)];
      await t.release(won[0].body.holdId, winner).expect(204);
    }
    // Every loser still has its whole quota: two further seats each.
    const loser = people[1];
    await t.hold(event, loser, tokens[1], { seats: [300, 301] }).expect(201);
  });

  // ------------------------------------------------------------------------------------------------- AS-17

  it('S22 AS-17: a multi-seat hold is all-or-nothing and leaves nothing of the loser behind', async () => {
    const event = await sale();
    const a = await admitted(event);
    const b = await admitted(event);
    await t.hold(event, a.who, a.token, { seats: [10] }).expect(201);

    const lost = await t
      .hold(event, b.who, b.token, { seats: [9, 10] })
      .expect(409);
    expect(lost.body).toMatchObject({ code: 'SEAT_TAKEN', seat: 10 });
    expect((await records(event)).map((r) => r.seat)).toEqual([10]);
    expect(await shown(event, 9)).toBe(false);
    expect(await shown(event, 10)).toBe(true);
    // seat 9 is free again, and B's quota is whole
    await t.hold(event, a.who, a.token, { seats: [9] }).expect(201);
    await t.hold(event, b.who, b.token, { seats: [20, 21] }).expect(201);
  });

  it('S22 AS-17: a late rollback removes only what its own hold wrote', async () => {
    const event = await sale();
    const l = ledger();
    const now = t.clock.nowMs();
    const early = await l.create({
      holdId: v4(),
      eventId: event.id,
      userId: v4(),
      seats: [9],
      createdAtMs: now,
      expiresAtMs: now + 600_000,
    });
    // the first hold lapsed and another buyer holds the seat with the next fence
    const later = await l.create({
      holdId: v4(),
      eventId: event.id,
      userId: v4(),
      seats: [9],
      createdAtMs: now + 600_001,
      expiresAtMs: now + 1_200_001,
    });
    expect(later.fences['9']).toBe(early.fences['9'] + 1);
    expect(await l.freeSeats(early)).toEqual({ freed: [], failed: [] });
    expect((await l.records(event.id)).find((r) => r.seat === 9)).toMatchObject(
      {
        holdId: later.holdId,
        state: 'HELD',
        fence: 2,
      },
    );
  });

  // ------------------------------------------------------------------------------------------------- AS-18

  it('S22 AS-18: every wrong admission token is 403 ADMISSION_REQUIRED before any store is touched', async () => {
    const event = await sale();
    const other = await sale();
    const { who, token } = await admitted(event);
    const stranger = await admitted(event);
    const otherEventToken = await t.admit(other, who);
    const mint = t.app.get(PurposeTokenService, { strict: false });
    const sign = (over: Record<string, unknown> = {}) =>
      mint.sign({
        subject: who.id,
        audience: `admission:${event.id}`,
        ttlSec: 600,
        claims: { purpose: 'admission' },
        ...over,
      } as never);
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'purpose+jwt' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({
        iss: 'marketplace',
        sub: who.id,
        aud: `admission:${event.id}`,
        exp: 9_999_999_999,
        purpose: 'admission',
      }),
    ).toString('base64url')}.`;
    const hs256 = jwt.sign(
      {
        iss: 'marketplace',
        sub: who.id,
        aud: `admission:${event.id}`,
        purpose: 'admission',
      },
      'a-shared-secret',
      { algorithm: 'HS256', expiresIn: 600 },
    );
    const bad: [string, string | undefined][] = [
      ['no token', undefined],
      ['malformed', 'not.a.token'],
      ['another event', otherEventToken],
      ['another buyer', stranger.token],
      ['another audience', await sign({ audience: 'admission:someone-else' })],
      ['another purpose', await sign({ claims: { purpose: 'newsletter' } })],
      ['alg none', none],
      ['HS256', hs256],
      ['an access token', who.auth.Authorization.replace('Bearer ', '')],
    ];
    for (const [name, value] of bad) {
      for (const store of Object.values(t.stores)) store.reset();
      const res = await t.hold(event, who, value, { seats: [1] }).expect(403);
      expect({ name, code: res.body.code }).toEqual({
        name,
        code: 'ADMISSION_REQUIRED',
      });
      expect(JSON.stringify(res.body)).not.toContain(token);
      expect({ name, touched: untouched() }).toEqual({ name, touched: true });
    }

    // An expired token is refused as well
    const expired = await sign({ ttlSec: 5 });
    await t.advance(20 * SECOND);
    for (const store of Object.values(t.stores)) store.reset();
    await t.hold(event, who, expired, { seats: [1] }).expect(403);
    expect(untouched()).toBe(true);

    // A valid token serves several holds until it expires
    const fresh = await t.admit(event, who);
    await t.hold(event, who, fresh, { seats: [1] }).expect(201);
    await t.hold(event, who, fresh, { seats: [2] }).expect(201);
  });

  // ------------------------------------------------------------------------------------------------- AS-19

  it('S22 AS-19: hold requests are validated, duplicates collapse, unknown or unselectable seats are 422, nothing changes', async () => {
    const event = await sale();
    const general = await sale({ seatingMode: 'GENERAL' });
    const { who, token } = await admitted(event);
    const gen = await admitted(general);

    const invalid: [string, object][] = [
      ['empty list', { seats: [] }],
      ['eleven seats', { seats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
      ['a non-integer', { seats: [1.5] }],
      ['a string', { seats: ['1'] }],
      ['a negative seat', { seats: [-1] }],
      ['both', { seats: [1], quantity: 1 }],
      ['neither', {}],
      ['an unknown property', { seats: [1], note: 'x' }],
      ['quantity zero', { quantity: 0 }],
    ];
    for (const [name, body] of invalid) {
      const res = await t.hold(event, who, token, body).expect(400);
      expect({ name, code: res.body.code }).toEqual({
        name,
        code: 'validation_failed',
      });
      expectProblem(res.body);
      expect(Array.isArray(res.body.errors)).toBe(true);
    }
    const tooHigh = await t
      .hold(event, who, token, { seats: [800] })
      .expect(422);
    expect(tooHigh.body).toMatchObject({ code: 'UNKNOWN_SEAT', seat: 800 });
    const notSelectable = await t
      .hold(general, gen.who, gen.token, { seats: [1] })
      .expect(422);
    expect(notSelectable.body.code).toBe('SEATS_NOT_SELECTABLE');
    expect(await records(event)).toHaveLength(0);
    expect(await records(general)).toHaveLength(0);

    const collapsed = await t
      .hold(event, who, token, { seats: [5, 5] })
      .expect(201);
    expect(collapsed.body.seats).toEqual([5]);
    expect(collapsed.body.limit.remaining).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------- AS-20

  it('S22 AS-20: the authoritative event status gates the hold', async () => {
    // SCHEDULED: sales open in an hour. Nobody can be admitted yet, so the token is minted for this one case.
    const later = await t.createEvent(s, {
      ...FAST,
      salesOpenAt: new Date(t.clock.nowMs() + 30 * MINUTE).toISOString(),
    });
    const buyer = await t.buyer();
    const mint = t.app.get(PurposeTokenService, { strict: false });
    const minted = await mint.sign({
      subject: buyer.id,
      audience: `admission:${later.id}`,
      ttlSec: 600,
      claims: { purpose: 'admission' },
    });
    const early = await t
      .hold(later, buyer, minted, { seats: [1] })
      .expect(409);
    expect(early.body.code).toBe('EVENT_NOT_ON_SALE');

    const unknownId = v4();
    const unknownToken = await mint.sign({
      subject: buyer.id,
      audience: `admission:${unknownId}`,
      ttlSec: 600,
      claims: { purpose: 'admission' },
    });
    const unknown = await t
      .hold({ id: unknownId }, buyer, unknownToken, { seats: [1] })
      .expect(404);
    expect(unknown.body.code).toBe('EVENT_NOT_FOUND');

    // CLOSED, with the cached page warm: the page does not decide
    const event = await sale();
    const a = await admitted(event);
    await t.http().get(`/api/launch-events/${event.id}`).expect(200);
    await t
      .http()
      .post(`/api/shops/${s.shopId}/launch-events/${event.id}/close`)
      .set(s.auth)
      .expect(200);
    const closed = await t
      .hold(event, a.who, a.token, { seats: [1] })
      .expect(409);
    expect(closed.body.code).toBe('EVENT_CLOSED');

    // SOLD_OUT
    const small = await sale({ seatCount: 2, seatsPerRow: 2 });
    const x = await admitted(small);
    const y = await admitted(small);
    const hold = await t
      .hold(small, x.who, x.token, { seats: [0, 1] })
      .expect(201);
    await t.confirm(hold.body.holdId, x.who).expect(201);
    const soldOut = await t
      .hold(small, y.who, y.token, { seats: [0] })
      .expect(409);
    expect(soldOut.body.code).toBe('EVENT_SOLD_OUT');
  });

  // ------------------------------------------------------------------------------------------------- AS-21

  it('S22 AS-21: the per-person limit counts held seats, reports the room left, and a refusal changes nothing', async () => {
    const event = await sale({ perUserLimit: 2 });
    const { who, token } = await admitted(event);
    const over = await t
      .hold(event, who, token, { seats: [1, 2, 3] })
      .expect(422);
    expect(over.body).toMatchObject({
      code: 'TICKET_LIMIT_EXCEEDED',
      limit: 2,
      remaining: 2,
    });
    expect(
      (await t.hold(event, who, token, { seats: [1] }).expect(201)).body.limit
        .remaining,
    ).toBe(1);
    expect(
      (await t.hold(event, who, token, { seats: [2] }).expect(201)).body.limit
        .remaining,
    ).toBe(0);
    const third = await t.hold(event, who, token, { seats: [3] }).expect(422);
    expect(third.body).toMatchObject({
      code: 'TICKET_LIMIT_EXCEEDED',
      limit: 2,
      remaining: 0,
    });
    expect((await records(event)).map((r) => r.seat)).toEqual([1, 2]);
  });

  // ------------------------------------------------------------------------------------------------- AS-22

  it('S22 AS-22: five parallel single-seat holds against a limit of two give two holds and three refusals (20 runs)', async () => {
    const event = await sale({ perUserLimit: 2 });
    for (let run = 0; run < 20; run++) {
      const { who, token } = await admitted(event);
      const base = run * 5;
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((i) =>
          t.hold(event, who, token, { seats: [base + i] }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      const refused = results.filter((r) => r.status === 422);
      expect(refused).toHaveLength(3);
      refused.forEach((r) => expect(r.body.code).toBe('TICKET_LIMIT_EXCEEDED'));
      expect(
        (await records(event)).filter((r) => r.userId === who.id),
      ).toHaveLength(2);
    }
  });

  // ------------------------------------------------------------------------------------------------- AS-23

  it('S22 AS-23: a hold released while its expiry job runs credits the buyer once (20 runs)', async () => {
    const event = await sale({ perUserLimit: 2 });
    for (let run = 0; run < 20; run++) {
      const { who, token } = await admitted(event);
      const booked = await t
        .hold(event, who, token, { seats: [run * 3] })
        .expect(201);
      await t.confirm(booked.body.holdId, who).expect(201);
      const active = await t
        .hold(event, who, token, { seats: [run * 3 + 1] })
        .expect(201);
      await t.hold(event, who, token, { seats: [run * 3 + 2] }).expect(422); // booking + hold = the limit

      await t.advance(10 * MINUTE); // the hold lapses; the job is late
      await Promise.all([
        t.release(active.body.holdId, who),
        t.jobs.expireHold({ holdId: active.body.holdId }),
      ]);
      const token2 = await t.admit(event, who);
      const again = await t
        .hold(event, who, token2, { seats: [run * 3 + 2] })
        .expect(201);
      expect(again.body.limit.remaining).toBe(0); // one booking + this hold: credited once, not twice
      await t.hold(event, who, token2, { seats: [run * 3 + 100] }).expect(422);
    }
  });

  // ------------------------------------------------------------------------------------------------- AS-24

  it('S22 AS-24: a wiped quota counter is rebuilt from the bookings and the holds, and it expires', async () => {
    const event = await sale({ perUserLimit: 2 });
    const { who, token } = await admitted(event);
    const first = await t
      .hold(event, who, token, { seats: [1, 2] })
      .expect(201);
    await t.confirm(first.body.holdId, who).expect(201);
    const key = `qt:{${event.id}}:${who.id}`;
    await redis().del(key);
    const res = await t.hold(event, who, token, { seats: [3] }).expect(422);
    expect(res.body).toMatchObject({
      code: 'TICKET_LIMIT_EXCEEDED',
      limit: 2,
      remaining: 0,
    });
    expect(await redis().ttl(key)).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------------------------------------- AS-25

  it('S22 AS-25: a replayed hold returns the stored answer; concurrent duplicates make one hold; reuse and bad keys are refused', async () => {
    const event = await sale();
    const { who, token } = await admitted(event);
    const key = `key-${v4()}`;
    const first = await t
      .hold(event, who, token, { seats: [7] }, key)
      .expect(201);
    const replay = await t
      .hold(event, who, token, { seats: [7] }, key)
      .expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.holdId).toBe(first.body.holdId);
    expect(
      (await records(event)).filter((r) => r.userId === who.id),
    ).toHaveLength(1);

    const reuse = await t
      .hold(event, who, token, { seats: [8] }, key)
      .expect(422);
    expect(reuse.body.code).toBe('idempotency_key_reuse');
    const noKey = await t
      .http()
      .post(`/api/launch-events/${event.id}/holds`)
      .set(who.auth)
      .set('X-Admission-Token', token)
      .send({ seats: [9] })
      .expect(422);
    expect(noKey.body.code).toBe('idempotency_key_required');
    const badKey = await t
      .hold(event, who, token, { seats: [9] }, 'short')
      .expect(422);
    expect(badKey.body.code).toBe('idempotency_key_invalid');

    const racer = await admitted(event);
    const raceKey = `key-${v4()}`;
    const race = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.hold(event, racer.who, racer.token, { seats: [20] }, raceKey),
      ),
    );
    const created = race.filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((r) => r.body.holdId)).size).toBe(1);
    race
      .filter((r) => r.status !== 201)
      .forEach((r) => expect(r.body.code).toBe('idempotency_in_flight'));
    expect(
      (await records(event)).filter((r) => r.userId === racer.who.id),
    ).toHaveLength(1);
  });

  it('S22 AS-25: a hold that lost the seat replays the same 409; a 5xx releases the key', async () => {
    const event = await sale();
    const a = await admitted(event);
    const b = await admitted(event);
    const held = await t
      .hold(event, a.who, a.token, { seats: [1] })
      .expect(201);
    const key = `key-${v4()}`;
    const lost = await t
      .hold(event, b.who, b.token, { seats: [1] }, key)
      .expect(409);
    await t.release(held.body.holdId, a.who).expect(204);
    const replay = await t
      .hold(event, b.who, b.token, { seats: [1] }, key)
      .expect(409);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toMatchObject({
      code: 'SEAT_TAKEN',
      seat: lost.body.seat,
    });

    const retryKey = `key-${v4()}`;
    t.stores.ledger.down();
    await t.hold(event, b.who, b.token, { seats: [2] }, retryKey).expect(503);
    t.stores.ledger.up();
    const ok = await t
      .hold(event, b.who, b.token, { seats: [2] }, retryKey)
      .expect(201);
    expect(ok.headers['idempotent-replayed']).toBeUndefined();
  });

  // ------------------------------------------------------------------------------------------------- AS-26

  it('S22 AS-26: best-available gives adjacent seats, disjoint under concurrency, and fails whole when there is not enough', async () => {
    const event = await sale({
      seatingMode: 'GENERAL',
      seatCount: 100,
      seatsPerRow: 10,
      perUserLimit: 2,
    });
    // sequentially an adjacent pair of one row is always found while one exists
    const first = await admitted(event);
    const one = await t
      .hold(event, first.who, first.token, { quantity: 2 })
      .expect(201);
    const [a, b] = one.body.seats as number[];
    expect(b).toBe(a + 1);
    expect(Math.floor(a / 10)).toBe(Math.floor(b / 10));
    await t.release(one.body.holdId, first.who).expect(204);

    const people = await t.buyers(50);
    const tokens = await t.admitAll(event, people);
    const results = await Promise.all(
      people.map((p, i) => t.hold(event, p, tokens[i], { quantity: 2 })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(50).fill(201));
    const seats = results.flatMap((r) => r.body.seats as number[]);
    expect(seats).toHaveLength(100);
    expect(new Set(seats).size).toBe(100);

    const late = await admitted(event);
    const none = await t
      .hold(event, late.who, late.token, { quantity: 1 })
      .expect(409);
    expect(none.body.code).toBe('NO_SEATS_AVAILABLE');
    expect(
      (await records(event)).filter((r) => r.userId === late.who.id),
    ).toHaveLength(0);
  });

  it('S22 AS-26: a quantity larger than the free seats holds nothing', async () => {
    const event = await sale({
      seatingMode: 'GENERAL',
      seatCount: 10,
      seatsPerRow: 10,
      perUserLimit: 10,
    });
    const x = await admitted(event);
    const y = await admitted(event);
    await t.hold(event, x.who, x.token, { quantity: 6 }).expect(201);
    const res = await t
      .hold(event, y.who, y.token, { quantity: 5 })
      .expect(409);
    expect(res.body.code).toBe('NO_SEATS_AVAILABLE');
    expect(await records(event)).toHaveLength(6);
    await t.hold(event, y.who, y.token, { quantity: 4 }).expect(201); // quota was given back
  });

  // ------------------------------------------------------------------------------------------------- AS-27

  it('S22 AS-27: a stale holder cannot touch a seat another buyer holds now', async () => {
    const event = await sale();
    const a = await admitted(event);
    const heldByA = await t
      .hold(event, a.who, a.token, { seats: [5] })
      .expect(201);
    await t.advance(10 * MINUTE + 1);
    const b = await admitted(event);
    const heldByB = await t
      .hold(event, b.who, b.token, { seats: [5] })
      .expect(201);
    const fence = (await records(event)).find((r) => r.seat === 5)!.fence;
    expect(fence).toBe(2);

    const confirm = await t.confirm(heldByA.body.holdId, a.who).expect(409);
    expect(confirm.body.code).toBe('HOLD_EXPIRED');
    await t.release(heldByA.body.holdId, a.who).expect(204);
    await ledger().freeSeats((await ledger().get(heldByA.body.holdId))!); // A's delayed rollback

    expect((await records(event)).find((r) => r.seat === 5)).toMatchObject({
      holdId: heldByB.body.holdId,
      state: 'HELD',
      fence: 2,
    });
    expect(await shown(event, 5)).toBe(true);
    await t.confirm(heldByB.body.holdId, b.who).expect(201);
  });

  // ------------------------------------------------------------------------------------------------- AS-28

  it('S22 AS-28: expiry frees the seats, the quota and the map, even when the job is an hour late, and twice is the same as once', async () => {
    const event = await sale();
    const a = await admitted(event);
    await mapOf(event); // a client has loaded the map, so its deltas are published
    const hold = await t
      .hold(event, a.who, a.token, { seats: [5, 6] })
      .expect(201);
    t.published.length = 0;
    await t.advance(10 * MINUTE);
    await t.jobs.expireHold({ holdId: hold.body.holdId });
    expect((await ledger().get(hold.body.holdId))!.state).toBe('EXPIRED');
    expect(await records(event)).toHaveLength(0);
    expect(await shown(event, 5)).toBe(false);
    expect(
      t.published.find(
        (p) => (p.data as { change?: string }).change === 'released',
      ),
    ).toMatchObject({
      data: { change: 'released', seats: [5, 6] },
    });
    await t
      .hold(event, a.who, await t.admit(event, a.who), { seats: [10, 11] })
      .expect(201); // quota is back
    const before = t.published.length;
    await t.jobs.expireHold({ holdId: hold.body.holdId });
    expect(t.published.length).toBe(before);

    // The job an hour late: another buyer already holds the seat one millisecond after the end.
    const second = await admitted(event);
    const heldTwo = await t
      .hold(event, second.who, second.token, { seats: [30] })
      .expect(201);
    await t.advance(10 * MINUTE + 1);
    const third = await admitted(event);
    const takeover = await t
      .hold(event, third.who, third.token, { seats: [30] })
      .expect(201);
    await t.advance(50 * MINUTE);
    await t.jobs.expireHold({ holdId: heldTwo.body.holdId });
    await t.jobs.expireHold({ holdId: heldTwo.body.holdId });
    expect((await records(event)).find((r) => r.seat === 30)).toMatchObject({
      holdId: takeover.body.holdId,
    });
    expect((await ledger().get(takeover.body.holdId))!.state).toBe('HELD'); // not lapsed by its own end only once the clock passed it
  });

  // ------------------------------------------------------------------------------------------------- AS-29

  it('S22 AS-29: with the fast lock store down the ledger alone keeps it correct, and the degradation is counted', async () => {
    const event = await sale();
    const people = await t.buyers(20);
    const tokens = await t.admitAll(event, people);
    const before =
      MetricsRegistry.value('launch_hold_degraded_total', { store: 'locks' }) ??
      0;
    t.stores.locks.down();
    const results = await Promise.all(
      people.map((p, i) => t.hold(event, p, tokens[i], { seats: [42] })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(
      results.find((r) => r.status === 201)!.body.serverTime,
    ).toBeDefined();
    expect(
      MetricsRegistry.value('launch_hold_degraded_total', { store: 'locks' }),
    ).toBeGreaterThan(before);
  });

  // ------------------------------------------------------------------------------------------------- AS-30

  it('S22 AS-30: with the ledger down a hold is 503 with nothing left behind, and the reads keep answering', async () => {
    const event = await sale();
    const a = await admitted(event);
    const b = await admitted(event);
    await mapOf(event); // the map exists
    t.stores.ledger.down();
    const res = await t.hold(event, a.who, a.token, { seats: [3] }).expect(503);
    expect(res.body.code).toBe('HOLDS_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('2');
    expect(JSON.stringify(res.body)).not.toMatch(/is down|dynamo/i);
    await t.http().get(`/api/launch-events/${event.id}/seatmap`).expect(200);
    await t
      .status(event, a.who, (await t.join(event, a.who)).body.ticket)
      .expect(200);
    t.stores.ledger.up();

    expect(await records(event)).toHaveLength(0);
    expect(await shown(event, 3)).toBe(false);
    await t.hold(event, b.who, b.token, { seats: [3] }).expect(201); // no ghost lock
    await t.hold(event, a.who, a.token, { seats: [4, 5] }).expect(201); // quota was given back
  });

  // ------------------------------------------------------------------------------------------------- AS-31

  it('S22 AS-31: the 31st hold attempt in a minute is 429 with no store effect; with the limiter down holds fail closed', async () => {
    const event = await sale({ perUserLimit: 2 });
    const { who, token } = await admitted(event);
    for (let i = 0; i < 30; i++)
      await t.hold(event, who, token, { seats: [i] });
    for (const store of Object.values(t.stores)) store.reset();
    const res = await t.hold(event, who, token, { seats: [200] }).expect(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(untouched()).toBe(true);

    const other = await admitted(event);
    t.stores.limiter.down();
    const closed = await t
      .hold(event, other.who, other.token, { seats: [300] })
      .expect(503);
    expect(closed.body.code).toBe('HOLDS_UNAVAILABLE');
    t.stores.limiter.up();
    expect(
      (await records(event)).filter((r) => r.userId === other.who.id),
    ).toHaveLength(0);
  });

  // ------------------------------------------------------------------------------------------------- AS-32

  it('S22 AS-32: booking routes need a session; the public reads do not', async () => {
    const event = await sale();
    const id = v4();
    await t
      .http()
      .post(`/api/launch-events/${event.id}/holds`)
      .send({ seats: [1] })
      .expect(401);
    await t.http().post(`/api/launch-holds/${id}/confirm`).send({}).expect(401);
    await t.http().delete(`/api/launch-holds/${id}`).expect(401);
    await t.http().post(`/api/launch-events/${event.id}/queue`).expect(401);
    await t
      .http()
      .get(`/api/launch-events/${event.id}/queue/${id}`)
      .expect(401);
    await t
      .http()
      .get(`/api/launch-events/${event.id}/my-bookings`)
      .expect(401);
    await t.http().get(`/api/launch-events/${event.id}`).expect(200);
    await t.http().get(`/api/launch-events/${event.id}/seatmap`).expect(200);
  });
});
