import { v4 } from 'uuid';
import {
  launchEventSchema,
  reduceSeatMap,
  seatMapDeltaSchema,
  seatMapSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { hasSeat } from './domain/seat-bitmap';
import { LaunchEventsModule } from './launch-events.module';
import { SEAT_MAP_STORE, type SeatMapStore } from './domain/ports';
import {
  SECOND,
  createLaunchApp,
  expectContract,
  type LaunchTestApp,
  type Seller,
} from './testing/launch-events-test-kit';

const FAST = { admissionRatePerSec: 100_000 };

jest.setTimeout(180_000); // the suites create hundreds of people through the real stores

describe('Launch events: seat map, deltas and realtime topics', () => {
  let t: LaunchTestApp;
  let s: Seller;
  /** The limiter keeps its windows in Redis: a spec that exhausts an address must not leave it exhausted for the next run. */
  const forgetLimits = async () => {
    const client = t.app.get(RedisService).client;
    const keys = await client.keys('rl:{launch.seatmap.ip|*');
    if (keys.length > 0) await client.del(...keys);
  };
  beforeAll(async () => {
    t = await createLaunchApp();
    s = await t.seller();
    await forgetLimits();
  });
  afterAll(async () => {
    await forgetLimits();
    await t.close();
  });
  afterEach(() => {
    for (const store of Object.values(t.stores)) store.up();
    t.published.length = 0;
  });

  const sale = (overrides: Record<string, unknown> = {}) =>
    t.onSale(s, { ...FAST, ...overrides });
  const redis = () => t.app.get(RedisService).client;
  const map = async (event: { id: string }) => {
    const res = await t
      .http()
      .get(`/api/launch-events/${event.id}/seatmap`)
      .expect(200);
    const body = expectContract(seatMapSchema, res.body);
    return { ...body, bytes: Buffer.from(body.bitmap, 'base64'), res };
  };
  const deltas = (event: { id: string }) =>
    t.published
      .filter((p) => p.topic === `event:${event.id}:seatmap`)
      .map((p) => expectContract(seatMapDeltaSchema, p.data));

  // ------------------------------------------------------------------------------------------------- AS-45

  it('S22 AS-45: the public map is one bit per seat, base64, with a seq and a one-second cache', async () => {
    const event = await sale();
    const a = await t.buyer();
    const b = await t.buyer();
    await t.held(event, a, [1, 2]);
    const heldB = await t.held(event, b, [3]);
    await t.confirm(heldB.holdId, b).expect(201);

    const m = await map(event);
    expect(m).toMatchObject({
      eventId: event.id,
      seatCount: 800,
      seatsPerRow: 20,
    });
    expect(m.bytes).toHaveLength(100);
    expect(m.bytes[0]).toBe(0b01110000);
    expect([...m.bytes.subarray(1)].every((byte) => byte === 0)).toBe(true);
    expect(m.res.headers['cache-control']).toBe('public, s-maxage=1');
    const unknown = await t
      .http()
      .get(`/api/launch-events/${v4()}/seatmap`)
      .expect(404);
    expect(unknown.body.code).toBe('EVENT_NOT_FOUND');
  });

  // ------------------------------------------------------------------------------------------------- AS-46

  it('S22 AS-46: concurrent holds publish deltas with unique, totally ordered seq numbers that agree with the map (20 runs)', async () => {
    const event = await sale({ perUserLimit: 10, seatCount: 1000 });
    const people = await t.buyers(50);
    const tokens = await t.admitAll(event, people);
    await map(event); // the map exists: its changes are published
    for (let run = 0; run < 20; run++) {
      t.published.length = 0;
      const reads: { seq: number; bytes: Buffer }[] = [];
      // a reader taking 20 snapshots while the 50 holds land (the map is limited to 600 reads a minute per address)
      const reader = (async () => {
        for (let i = 0; i < 20; i++) {
          const m = await map(event);
          reads.push({ seq: m.seq, bytes: m.bytes });
        }
      })();
      const holds = Promise.all(
        people.map((p, i) =>
          t.hold(event, p, tokens[i], { seats: [run * 50 + i] }),
        ),
      );
      const [results] = await Promise.all([holds, reader]);
      results.forEach((r) => expect(r.status).toBe(201));

      const held = deltas(event).filter((d) => d.change === 'held');
      expect(held).toHaveLength(50);
      const seqs = held.map((d) => d.seq);
      expect(new Set(seqs).size).toBe(50);
      const final = await map(event);
      for (const d of held) {
        expect(hasSeat(final.bytes, d.seats[0])).toBe(true);
        expect(d.seq).toBeLessThanOrEqual(final.seq);
      }
      // a reader never sees a bit without a seq at least that of its change
      for (const read of reads)
        for (const d of held)
          if (hasSeat(read.bytes, d.seats[0]))
            expect(read.seq).toBeGreaterThanOrEqual(d.seq);
      // sorted by seq the deltas are a total order that reproduces the final map
      let client = {
        seq: Math.min(...seqs) - 1,
        bitmap: Buffer.alloc(100).toString('base64'),
        applied: [] as number[],
      };
      for (const d of [...held].sort((x, y) => x.seq - y.seq)) {
        const next = reduceSeatMap({ ...client, seq: d.seq - 1 }, d);
        expect(next.action).toBe('applied');
        client = next.state;
      }
      const expected = Buffer.alloc(100);
      for (const d of held)
        expected[Math.floor(d.seats[0] / 8)] |= 1 << (7 - (d.seats[0] % 8));
      expect(
        Buffer.from(client.bitmap, 'base64').subarray(0, 100).equals(expected),
      ).toBe(true);

      // let the people hold again next run
      await Promise.all(
        results.map((r, i) => t.release(r.body.holdId, people[i]).expect(204)),
      );
    }
  });

  // ------------------------------------------------------------------------------------------------- AS-48

  it('S22 AS-48: a lost map is rebuilt once behind a single flight, with an expiry; the reconciler clears stray bits', async () => {
    const event = await sale();
    const a = await t.buyer();
    await t.held(event, a, [5, 6]);
    await map(event);
    await redis().del(`sm:{${event.id}}`, `sm:{${event.id}}:seq`);
    t.stores.ledger.reset();

    const reads = await Promise.all(
      Array.from({ length: 20 }, () =>
        t.http().get(`/api/launch-events/${event.id}/seatmap`),
      ),
    );
    reads.forEach((r) => expect(r.status).toBe(200));
    const bitmaps = new Set(reads.map((r) => r.body.bitmap));
    expect(bitmaps.size).toBe(1);
    const rebuilt = Buffer.from([...bitmaps][0] as string, 'base64');
    expect(
      hasSeat(rebuilt, 5) && hasSeat(rebuilt, 6) && !hasSeat(rebuilt, 7),
    ).toBe(true);
    expect(t.stores.ledger.count('records')).toBe(1);
    expect(await redis().ttl(`sm:{${event.id}}`)).toBeGreaterThan(0);
    expect(await redis().ttl(`sm:{${event.id}}:seq`)).toBeGreaterThan(0);

    // a bit with no hold or booking behind it for more than 120 s
    await t.app
      .select(LaunchEventsModule)
      .get<SeatMapStore>(SEAT_MAP_STORE)
      .apply(event.id, [99], true);
    expect(hasSeat((await map(event)).bytes, 99)).toBe(true);
    await t.advance(121 * SECOND);
    t.published.length = 0;
    const before =
      MetricsRegistry.value('launch_reconcile_repairs_total', {
        kind: 'map_stray_bit',
      }) ?? 0;
    await t.reconciler.run();
    expect(hasSeat((await map(event)).bytes, 99)).toBe(false);
    expect(deltas(event).find((d) => d.change === 'released')).toMatchObject({
      seats: [99],
    });
    expect(
      MetricsRegistry.value('launch_reconcile_repairs_total', {
        kind: 'map_stray_bit',
      }),
    ).toBeGreaterThan(before);
  });

  // ------------------------------------------------------------------------------------------------- AS-49

  it('S22 AS-49: the 601st map read of an address in a minute is 429; with the limiter down reads still answer', async () => {
    const event = await sale();
    await t.advance(125 * SECOND); // a fresh minute for this address: the sliding window forgets the earlier reads
    for (let i = 0; i < 600; i++)
      await t.http().get(`/api/launch-events/${event.id}/seatmap`).expect(200);
    const limited = await t
      .http()
      .get(`/api/launch-events/${event.id}/seatmap`)
      .expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    t.stores.limiter.down();
    await t.http().get(`/api/launch-events/${event.id}/seatmap`).expect(200);
  });

  it('S22 AS-49: the event page is public, cacheable, free of internals and negatively cached when unknown', async () => {
    const event = await sale({ humanCheckRequired: true });
    const res = await t
      .http()
      .get(`/api/launch-events/${event.id}`)
      .expect(200);
    const body = expectContract(launchEventSchema, res.body);
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(body).sort());
    expect(res.body).not.toHaveProperty('admissionRatePerSec');
    expect(res.body).not.toHaveProperty('createdAt');
    expect(res.body.humanCheckRequired).toBe(true);
    expect(res.headers['cache-control']).toBe(
      'public, s-maxage=60, stale-while-revalidate=300',
    );

    const missing = v4();
    t.stores.events.reset();
    const first = await t
      .http()
      .get(`/api/launch-events/${missing}`)
      .expect(404);
    await t.http().get(`/api/launch-events/${missing}`).expect(404);
    expect(first.body.code).toBe('EVENT_NOT_FOUND');
    expect(t.stores.events.count('findById')).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------- AS-50

  it('S22 AS-50: the seat-map topic is public; a queue topic is subscribable only by the owner of the ticket', async () => {
    const event = await sale();
    const [owner, other] = await t.buyers(2);
    const ticket = (await t.join(event, owner).expect(201)).body
      .ticket as string;
    const topics = t.app.get(TopicRegistry, { strict: false });

    expect(await topics.canSubscribe({}, `event:${event.id}:seatmap`)).toBe(
      true,
    );
    expect(
      await topics.canSubscribe({ userId: owner.id }, `queue:${ticket}`),
    ).toBe(true);
    expect(
      await topics.canSubscribe({ userId: other.id }, `queue:${ticket}`),
    ).toBe(false);
    expect(await topics.canSubscribe({}, `queue:${ticket}`)).toBe(false);
    expect(
      await topics.canSubscribe({ userId: owner.id }, `queue:${v4()}`),
    ).toBe(false);

    await t.admitter.admitEvent(event.id);
    const push = t.published.find(
      (p) => p.topic === `queue:${ticket}` && p.type === 'admitted',
    )!;
    expect(push).toBeDefined();
    // the only topic the token travels on is the owner's
    expect(
      t.published
        .filter((p) => JSON.stringify(p.data).includes('admissionToken'))
        .every((p) => p.topic.startsWith('queue:')),
    ).toBe(true);
  });
});
