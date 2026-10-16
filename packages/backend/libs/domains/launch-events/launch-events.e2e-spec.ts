import { v4 } from 'uuid';
import { HOLD_LEDGER, type HoldLedger } from './domain/ports';
import { LaunchEventsModule } from './launch-events.module';
import {
  createLaunchApp,
  type LaunchTestApp,
  type Seller,
} from './testing/launch-events-test-kit';

jest.setTimeout(180_000);

/** Whole-journey smoke over the real module: admission, hold, confirm, release (the detail lives in the sibling specs). */
describe('Launch event booking (e2e)', () => {
  let t: LaunchTestApp;
  let s: Seller;
  beforeAll(async () => {
    t = await createLaunchApp();
    s = await t.seller();
  });
  afterAll(async () => {
    await t.close();
  });

  const ledger = () =>
    t.app.select(LaunchEventsModule).get<HoldLedger>(HOLD_LEDGER);
  const heldSeats = async (event: { id: string }) =>
    (await ledger().records(event.id))
      .filter((r) => r.state !== 'FREE')
      .map((r) => r.seat);
  const sale = (overrides: Record<string, unknown> = {}) =>
    t.onSale(s, { admissionRatePerSec: 100_000, ...overrides });

  it('S22 AS-16: 20 buyers click the same seat at once → exactly one hold, 19 × SEAT_TAKEN', async () => {
    const event = await sale();
    const people = await t.buyers(20);
    const tokens = await t.admitAll(event, people);
    const results = await Promise.all(
      people.map((who, i) => t.hold(event, who, tokens[i], { seats: [7] })),
    );
    const won = results.filter((r) => r.status === 201);
    const lost = results.filter((r) => r.status !== 201);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(19);
    expect(lost.every((r) => r.status === 409)).toBe(true);
    expect(lost.every((r) => r.body.code === 'SEAT_TAKEN')).toBe(true);
    expect(won[0].body.seats).toEqual([7]);
    expect(await heldSeats(event)).toEqual([7]);
  });

  it('S22 AS-17: a multi-seat hold is all-or-nothing: a conflict on one seat leaves the others free', async () => {
    const event = await sale();
    const first = await t.buyer();
    await t.held(event, first, [10]);
    const second = await t.buyer();
    const token = await t.admit(event, second);
    const res = await t.hold(event, second, token, { seats: [9, 10] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEAT_TAKEN');
    expect(await heldSeats(event)).toEqual([10]);
  });

  it('S22 AS-28: a released hold frees the seat for the next buyer', async () => {
    const event = await sale();
    const a = await t.buyer();
    const hold = await t.held(event, a, [20]);
    await t.release(hold.holdId, a).expect(204);
    expect(await heldSeats(event)).toEqual([]);
    const b = await t.buyer();
    const again = await t.held(event, b, [20]);
    expect(again.seats).toEqual([20]);
    expect(again.holdId).not.toBe(hold.holdId);
  });

  it('S22 AS-33: confirm turns the hold into bookings and a replay with the same key answers the same', async () => {
    const event = await sale();
    const who = await t.buyer();
    const hold = await t.held(event, who, [30, 31]);
    const key = `key-${v4()}`;
    const first = await t.confirm(hold.holdId, who, key).expect(201);
    expect(first.body.bookings.map((b: { seat: number }) => b.seat)).toEqual([
      30, 31,
    ]);
    const replay = await t.confirm(hold.holdId, who, key).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('S22 AS-21: the per-person limit refuses seats beyond it with 422 TICKET_LIMIT_EXCEEDED', async () => {
    const event = await sale({ perUserLimit: 2 });
    const who = await t.buyer();
    const token = await t.admit(event, who);
    await t.hold(event, who, token, { seats: [40, 41] }).expect(201);
    const over = await t.hold(event, who, token, { seats: [42] }).expect(422);
    expect(over.body).toMatchObject({
      code: 'TICKET_LIMIT_EXCEEDED',
      limit: 2,
      remaining: 0,
    });
    expect(await heldSeats(event)).toEqual([40, 41]);
  });

  it('S22 AS-18: holding without an admission token is 403 ADMISSION_REQUIRED and changes nothing', async () => {
    const event = await sale();
    const who = await t.buyer();
    const res = await t.hold(event, who, undefined, { seats: [50] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMISSION_REQUIRED');
    expect(await heldSeats(event)).toEqual([]);
  });
});
