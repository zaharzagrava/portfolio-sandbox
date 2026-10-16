import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { v4 } from 'uuid';
import {
  LAUNCH_EVENT_ERROR_STATUS,
  eventEnvelopeSchema,
  launchEventEventSchemas,
} from '@marketplace-sandbox/contracts';
import { PurposeTokenService } from '@app/domains/identity';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { DistributedLock } from '@app/infrastructure/cache';
import { ownedBy, ownerOf } from '../../../db/ownership';
import * as barrel from './index';
import { SEAT_MAP_STORE, type SeatMapStore } from './domain/ports';
import { LaunchEventsModule } from './launch-events.module';
import { LAUNCH_EVENT_ERROR_CODES } from './domain/errors';
import {
  DAY,
  MINUTE,
  SECOND,
  createLaunchApp,
  expectProblem,
  type LaunchTestApp,
  type Seller,
} from './testing/launch-events-test-kit';

const FAST = { admissionRatePerSec: 100_000 };
const METRICS = [
  'launch_queue_joins_total',
  'launch_queue_length',
  'launch_admitted_total',
  'launch_admission_stale_leader_total',
  'launch_holds_total',
  'launch_hold_degraded_total',
  'launch_confirms_total',
  'launch_double_booking_detected_total',
  'launch_reconcile_repairs_total',
] as const;

jest.setTimeout(180_000); // the suites create hundreds of people through the real stores

describe('Launch events: jobs, events, metrics and domain isolation', () => {
  let t: LaunchTestApp;
  let s: Seller;
  beforeAll(async () => {
    t = await createLaunchApp({ captureLogs: true });
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
    t.settings.queueMaxLength = 2_000_000;
    t.human.mode = 'ok';
    t.published.length = 0;
  });

  const sale = (overrides: Record<string, unknown> = {}) =>
    t.onSale(s, { ...FAST, ...overrides });
  const metric = (name: string, labels: Record<string, string> = {}) =>
    MetricsRegistry.value(name, labels) ?? 0;
  const count = async (
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => Number((await t.rows<{ n: string }>(sql, replacements))[0].n);
  const mint = async (event: { id: string }, who: { id: string }) =>
    t.app.get(PurposeTokenService, { strict: false }).sign({
      subject: who.id,
      audience: `admission:${event.id}`,
      ttlSec: 600,
      claims: { purpose: 'admission' },
    });

  // ------------------------------------------------------------------------------------------------- AS-58

  it('S22 AS-58: the launch_* metrics exist and move, with bounded labels, and no secret reaches a log, label, body or event', async () => {
    const logStart = t.logLines().length;
    const secrets: string[] = [];
    const problems: string[] = []; // the error bodies of this flow: none may echo a secret
    const event = await sale({ seatCount: 4, seatsPerRow: 4, perUserLimit: 2 });
    const [a, b, c] = await t.buyers(3);

    const joined = await t.join(event, a).expect(201);
    secrets.push(joined.body.ticket);
    await t.admitter.admitEvent(event.id);
    const token = (await t.status(event, a, joined.body.ticket).expect(200))
      .body.admissionToken as string;
    secrets.push(token);
    const key = `secret-key-${v4()}`;
    secrets.push(key);
    const hold = await t
      .hold(event, a, token, { seats: [0, 1] }, key)
      .expect(201);
    const lost = await t.hold(event, a, token, { seats: [2] }).expect(422); // limit
    problems.push(JSON.stringify(lost.body));
    const refused = await t
      .hold(event, c, 'bogus.token.value', { seats: [1] })
      .expect(403); // admission refused
    problems.push(JSON.stringify(refused.body));
    const stolen = await t.hold(event, c, token, { seats: [1] }).expect(403); // somebody else's token
    problems.push(JSON.stringify(stolen.body));
    const second = await t.admit(event, b);
    secrets.push(second);
    await t.hold(event, b, second, { seats: [0] }).expect(409); // seat taken
    t.stores.ledger.down();
    await t.hold(event, b, second, { seats: [3] }).expect(503); // unavailable
    t.stores.ledger.up();
    t.stores.locks.down();
    await t.hold(event, b, second, { seats: [3] }).expect(201); // degraded
    t.stores.locks.up();
    await t.confirm(hold.body.holdId, a, `c-${key}`).expect(201);
    secrets.push(`c-${key}`);

    // a stale leader: a newer lease holder admits, then the paused one resumes with its old fence
    const slow = await sale({ admissionRatePerSec: 1 });
    await t
      .buyers(3)
      .then((people) =>
        Promise.all(people.map((p) => t.join(slow, p).expect(201))),
      );
    const old = (await t.app
      .get(DistributedLock)
      .tryAcquire(`launch-admit:${slow.id}`, { ttlMs: 3000 }))!;
    await old.release();
    expect(await t.admitter.admitEvent(slow.id)).toBe(1);
    await t.advance(SECOND);
    const gate = {
      eventId: slow.id,
      shopId: s.shopId,
      status: 'ON_SALE' as const,
      salesOpenAtMs: 0,
      startsAtMs: 0,
      seatCount: 800,
      seatsPerRow: 20,
      seatingMode: 'SEATED' as const,
      perUserLimit: 2,
      admissionRatePerSec: 1,
      humanCheckRequired: false,
    };
    expect(await t.admitter.admitWithFence(gate, old.fence)).toBe(0);

    // a repaired drift: a bit with nothing behind it
    await t.http().get(`/api/launch-events/${event.id}/seatmap`).expect(200);
    await t.app
      .select(LaunchEventsModule)
      .get<SeatMapStore>(SEAT_MAP_STORE)
      .apply(event.id, [3], true);
    await t.reconciler.run();

    for (const name of [
      'launch_queue_joins_total',
      'launch_admitted_total',
      'launch_holds_total',
      'launch_confirms_total',
      'launch_admission_stale_leader_total',
    ])
      expect(MetricsRegistry.labelSets(name).length).toBeGreaterThan(0);
    expect(
      metric('launch_queue_joins_total', { result: 'created' }),
    ).toBeGreaterThan(0);
    for (const outcome of [
      'created',
      'seat_taken',
      'limit',
      'admission_refused',
      'unavailable',
    ])
      expect(metric('launch_holds_total', { outcome })).toBeGreaterThan(0);
    expect(
      metric('launch_hold_degraded_total', { store: 'locks' }),
    ).toBeGreaterThan(0);
    expect(
      metric('launch_confirms_total', { outcome: 'confirmed' }),
    ).toBeGreaterThan(0);
    expect(metric('launch_double_booking_detected_total')).toBe(0);
    expect(
      MetricsRegistry.value('launch_queue_length', { event: event.id }),
    ).toBeDefined();

    // bounded labels: only the documented keys, no identifier except the queue-length gauge's event
    for (const name of METRICS)
      for (const labels of MetricsRegistry.labelSets(name))
        for (const [key, value] of Object.entries(labels)) {
          expect(['result', 'outcome', 'store', 'kind', 'event']).toContain(
            key,
          );
          if (key !== 'event')
            expect(String(value)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
        }
    // nothing sensitive in logs, bodies, labels or events
    const logs = t.logLines().slice(logStart);
    const events = JSON.stringify(await t.outbox(hold.body.holdId));
    for (const secret of secrets) {
      expect({
        secret: secret.slice(0, 8),
        inLogs: logs.includes(secret),
      }).toEqual({ secret: secret.slice(0, 8), inLogs: false });
      expect(problems.join('')).not.toContain(secret);
      expect(events).not.toContain(secret);
      for (const name of METRICS)
        expect(JSON.stringify(MetricsRegistry.labelSets(name))).not.toContain(
          secret,
        );
    }
    // every line written while serving a request carries its requestId
    const requestLines = logs
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.req !== undefined);
    expect(requestLines.length).toBeGreaterThan(0);
    requestLines.forEach((line) =>
      expect(typeof line.requestId).toBe('string'),
    );
  });

  // ------------------------------------------------------------------------------------------------- AS-59

  it('S22 AS-59: every error of the capability is a problem document with a stable code, and a 5xx is generic', async () => {
    const seen = new Map<string, number>();
    const check = (
      res: { status: number; body: unknown; headers: Record<string, string> },
      code: string,
    ) => {
      const p = expectProblem(res.body);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect({ code: p.code, status: res.status }).toEqual({
        code,
        status:
          LAUNCH_EVENT_ERROR_STATUS[
            code as keyof typeof LAUNCH_EVENT_ERROR_STATUS
          ],
      });
      expect(p.status).toBe(res.status);
      if (res.status >= 500)
        expect(p.detail).not.toMatch(/down|redis|dynamo|sql|stack/i);
      seen.set(code, res.status);
    };
    const event = await sale({
      perUserLimit: 2,
      seatCount: 20,
      seatsPerRow: 10,
    });
    const [a, b] = await t.buyers(2);
    const ta = await t.admit(event, a);
    const tb = await t.admit(event, b);

    check(
      await t.hold(event, a, undefined, { seats: [1] }),
      'ADMISSION_REQUIRED',
    );
    check(
      await t.http().post(`/api/launch-events/${v4()}/queue`).set(a.auth),
      'EVENT_NOT_FOUND',
    );
    check(await t.status(event, a, v4()), 'TICKET_NOT_FOUND');
    check(await t.confirm(v4(), a), 'HOLD_NOT_FOUND');
    const checked = await sale({ humanCheckRequired: true });
    check(await t.join(checked, a), 'HUMAN_CHECK_FAILED');
    const one = await t.hold(event, a, ta, { seats: [1] }).expect(201);
    check(await t.hold(event, b, tb, { seats: [1] }), 'SEAT_TAKEN');
    check(
      await t.hold(event, a, ta, { seats: [2, 3] }),
      'TICKET_LIMIT_EXCEEDED',
    );
    check(await t.hold(event, a, ta, { seats: [20] }), 'UNKNOWN_SEAT');
    check(await t.confirm(one.body.holdId, b), 'HOLD_NOT_FOUND');
    await t.release(one.body.holdId, a).expect(204);
    check(await t.confirm(one.body.holdId, a), 'HOLD_RELEASED');
    const two = await t.hold(event, a, ta, { seats: [4] }).expect(201);
    await t.confirm(two.body.holdId, a).expect(201);
    check(await t.release(two.body.holdId, a), 'HOLD_ALREADY_CONFIRMED');
    const three = await t.hold(event, b, tb, { seats: [5] }).expect(201);
    await t.advance(10 * MINUTE);
    check(await t.confirm(three.body.holdId, b), 'HOLD_EXPIRED');

    const general = await sale({
      seatingMode: 'GENERAL',
      seatCount: 2,
      seatsPerRow: 2,
      perUserLimit: 2,
    });
    const g = await t.buyer();
    const gt = await t.admit(general, g);
    check(await t.hold(general, g, gt, { seats: [0] }), 'SEATS_NOT_SELECTABLE');
    const g2 = await t.hold(general, g, gt, { quantity: 2 }).expect(201);
    const h = await t.buyer();
    check(
      await t.hold(general, h, await t.admit(general, h), { quantity: 1 }),
      'NO_SEATS_AVAILABLE',
    );
    await t.confirm(g2.body.holdId, g).expect(201);
    check(await t.join(general, await t.buyer()), 'EVENT_SOLD_OUT');

    const later = await t.createEvent(s, {
      ...FAST,
      salesOpenAt: new Date(t.clock.nowMs() + 30 * MINUTE).toISOString(),
    });
    const x = await t.buyer();
    check(
      await t.hold(later, x, await mint(later, x), { seats: [1] }),
      'EVENT_NOT_ON_SALE',
    );
    const closing = await sale();
    await t
      .http()
      .post(`/api/shops/${s.shopId}/launch-events/${closing.id}/close`)
      .set(s.auth)
      .expect(200);
    check(await t.join(closing, x), 'EVENT_CLOSED');
    check(
      await t
        .http()
        .post(`/api/shops/${s.shopId}/launch-events/${closing.id}/close`)
        .set(s.auth),
      'EVENT_ALREADY_CLOSED',
    );
    check(
      await t
        .http()
        .post(`/api/shops/${s.shopId}/launch-events`)
        .set(s.auth)
        .send({
          title: 'x',
          venue: 'y',
          startsAt: new Date(t.clock.nowMs() + DAY).toISOString(),
          salesOpenAt: new Date(t.clock.nowMs() + 2 * DAY).toISOString(),
          seatCount: 5,
        }),
      'invalid_schedule',
    );
    const small = await sale();
    t.settings.queueMaxLength = 1;
    await t.join(small, x).expect(201);
    check(await t.join(small, await t.buyer()), 'WAITING_ROOM_FULL');
    t.settings.queueMaxLength = 2_000_000;
    const y = await t.buyer();
    t.stores.queue.down();
    t.stores.gate.down();
    check(await t.join(small, y), 'WAITING_ROOM_UNAVAILABLE');
    t.stores.queue.up();
    t.stores.gate.up();
    const z = await t.buyer();
    const zt = await t.admit(small, z);
    t.stores.ledger.down();
    check(await t.hold(small, z, zt, { seats: [1] }), 'HOLDS_UNAVAILABLE');
    t.stores.ledger.up();
    for (const code of LAUNCH_EVENT_ERROR_CODES)
      expect({ code, seen: seen.has(code) }).toEqual({ code, seen: true });

    // a 5xx whose cause is internal
    const { who, hold } = await (async () => {
      const w = await t.buyer();
      return { who: w, hold: await t.held(small, w, [7]) };
    })();
    jest
      .spyOn(OutboxService.prototype, 'append')
      .mockRejectedValueOnce(new Error('kafka://secret-host:9092 refused'));
    const failed = await t.confirm(hold.holdId, who);
    expect(failed.status).toBe(500);
    expect(expectProblem(failed.body).detail).not.toMatch(
      /kafka|secret-host|9092/,
    );
  });

  // ------------------------------------------------------------------------------------------------- AS-60

  it('S22 AS-60: the four jobs act once when delivered twice or at once, and an invalid payload is refused without effect', async () => {
    const jobs = t.app.get(JobsService, { strict: false });
    const jobCount = () =>
      count(
        `SELECT count(*)::text AS n FROM "Job" WHERE type LIKE 'launch-events.%'`,
      );

    // expire-hold
    const event = await sale({ perUserLimit: 2 });
    const who = await t.buyer();
    const token = await t.admit(event, who);
    const hold = await t.hold(event, who, token, { seats: [1, 2] }).expect(201);
    await t.http().get(`/api/launch-events/${event.id}/seatmap`).expect(200);
    await t.advance(10 * MINUTE);
    t.published.length = 0;
    await Promise.all([
      t.jobs.expireHold({ holdId: hold.body.holdId }),
      t.jobs.expireHold({ holdId: hold.body.holdId }),
    ]);
    await t.jobs.expireHold({ holdId: hold.body.holdId });
    expect(
      t.published.filter(
        (p) => (p.data as { change?: string }).change === 'released',
      ),
    ).toHaveLength(1);
    const again = await t.admit(event, who);
    await t.hold(event, who, again, { seats: [3, 4] }).expect(201); // credited once: room for exactly two
    await t.hold(event, who, again, { seats: [5] }).expect(422);

    // open-sales and close-event
    const later = await t.createEvent(s, {
      ...FAST,
      salesOpenAt: new Date(t.clock.nowMs() + 10 * SECOND).toISOString(),
    });
    await t.advance(11 * SECOND);
    await Promise.all([
      t.jobs.openSales({ eventId: later.id }),
      t.jobs.openSales({ eventId: later.id }),
    ]);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM "LaunchEventHistory" WHERE "launchEventId" = :id AND "toStatus" = 'ON_SALE'`,
        { id: later.id },
      ),
    ).toBe(1);
    await Promise.all([
      t.jobs.closeEvent({ eventId: later.id, reason: 'started' }),
      t.jobs.closeEvent({ eventId: later.id, reason: 'started' }),
    ]);
    await t.jobs.closeEvent({ eventId: later.id, reason: 'started' });
    expect(
      await count(
        `SELECT count(*)::text AS n FROM "LaunchEventHistory" WHERE "launchEventId" = :id AND "toStatus" = 'CLOSED'`,
        { id: later.id },
      ),
    ).toBe(1);
    expect(
      (await t.outbox(later.id)).filter(
        (r) => r.type === 'launchevents.event_closed',
      ),
    ).toHaveLength(1);

    // reconcile-seats on two workers at once repairs each drift once
    const drift = await sale();
    await t.http().get(`/api/launch-events/${drift.id}/seatmap`).expect(200);
    const mapStore = t.app
      .select(LaunchEventsModule)
      .get<SeatMapStore>(SEAT_MAP_STORE);
    await mapStore.apply(drift.id, [9], true);
    const before = metric('launch_reconcile_repairs_total', {
      kind: 'map_stray_bit',
    });
    await Promise.all([t.reconciler.run(), t.reconciler.run()]);
    expect(
      metric('launch_reconcile_repairs_total', { kind: 'map_stray_bit' }),
    ).toBe(before + 1);
    await t.reconciler.run();
    expect(
      metric('launch_reconcile_repairs_total', { kind: 'map_stray_bit' }),
    ).toBe(before + 1);

    // invalid payloads never become jobs
    const queued = await jobCount();
    for (const [type, payload] of [
      ['launch-events.expire-hold', { holdId: 'nope' }],
      ['launch-events.open-sales', { eventId: 42 }],
      ['launch-events.close-event', { eventId: v4(), reason: 'because' }],
      ['launch-events.reconcile-seats', { extra: true }],
    ] as const)
      await expect(jobs.enqueue(type, payload as never)).rejects.toBeDefined();
    expect(await jobCount()).toBe(queued);
  });

  // ------------------------------------------------------------------------------------------------- AS-61

  it('S22 AS-61: the capability reads and writes only its own tables, has no foreign key or foreign model, and exports modules only', async () => {
    const statements: string[] = [];
    const settings = (t.db as unknown as { options: { logging: unknown } })
      .options;
    const previous = settings.logging;
    settings.logging = (sql: string) => {
      statements.push(sql);
    };
    try {
      const event = await sale();
      const people = await t.buyers(2);
      const held = await t.held(event, people[0], [1]);
      await t.confirm(held.holdId, people[0]).expect(201);
      await t
        .http()
        .get(`/api/shops/${s.shopId}/launch-events/${event.id}/bookings`)
        .set(s.auth)
        .expect(200);
      await t
        .http()
        .get(`/api/launch-events/${event.id}/my-bookings`)
        .set(people[0].auth)
        .expect(200);
      await t
        .http()
        .post(`/api/shops/${s.shopId}/launch-events/${event.id}/close`)
        .set(s.auth)
        .expect(200);
      await t.jobs.closeEvent({ eventId: event.id, reason: 'organizer' });
      await t.reconciler.run();
    } finally {
      settings.logging = previous;
    }
    const owned = new Set<string>(ownedBy('domain:launch-events'));
    // tables of the toolkits S22 stands on (outbox, jobs, idempotency) and of the guards in front of it (tenancy, identity)
    const guards = new Set([
      'Shop',
      'ShopMembership',
      'ShopDirectory',
      'User',
      'SigningKey',
    ]);
    const tables = new Set<string>();
    for (const sql of statements)
      for (const m of sql.matchAll(
        /(?:FROM|JOIN|INTO|UPDATE)\s+"([A-Za-z]+)"/g,
      ))
        tables.add(m[1]);
    const foreign = [...tables].filter(
      (name) =>
        !owned.has(name) &&
        !guards.has(name) &&
        !ownerOf(name)?.startsWith('infrastructure:'),
    );
    expect(foreign).toEqual([]);
    expect([...tables].some((name) => owned.has(name))).toBe(true);
    expect(owned.has('BookingEvent') && owned.has('LaunchEventHistory')).toBe(
      true,
    );

    // the code of the booking half names no foreign table, model or foreign key
    const root = __dirname;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          if (!['testing', 'node_modules'].includes(entry)) walk(path);
        } else if (
          path.endsWith('.ts') &&
          !path.endsWith('.spec.ts') &&
          !path.includes('e2e-spec') &&
          !/\/(live|reservoir|moderation)/.test(path) &&
          !/live-/.test(path)
        )
          files.push(path);
      }
    };
    walk(root);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect({
        file,
        imports:
          /ShopMembership|ShopModel|UserModel|@InjectModel\((?!(LaunchEvent|LaunchEventHistory|Booking|BookingEvent)\b)/.test(
            text,
          ),
      }).toEqual({ file, imports: false });
      expect({ file, fk: /REFERENCES\s+"Shop"/.test(text) }).toEqual({
        file,
        fk: false,
      });
    }

    // the barrel exports the three modules and types; nothing of the booking half besides
    const exported = Object.keys(barrel).sort();
    for (const name of [
      'LaunchEventsModule',
      'LaunchEventsWorkerModule',
      'LaunchEventTopicsModule',
    ])
      expect(exported).toContain(name);
    for (const name of [
      'BookingModel',
      'LaunchEventModel',
      'WaitingRoomService',
      'SeatHoldService',
      'HoldService',
      'Admitter',
      'AdmissionTicker',
    ])
      expect(exported).not.toContain(name);
  });

  // ------------------------------------------------------------------------------------------------- AS-62

  it('S22 AS-62: each event carries the envelope and its documented payload, and is absent when its transaction rolls back', async () => {
    const event = await sale({ seatCount: 2, seatsPerRow: 2 });
    const who = await t.buyer();
    const held = await t.held(event, who, [0, 1]);
    await t.confirm(held.holdId, who).expect(201); // books the last seats: sold out
    await t
      .http()
      .post(`/api/shops/${s.shopId}/launch-events/${event.id}/close`)
      .set(s.auth)
      .expect(200);

    const parse = (row: { payload: unknown }) =>
      eventEnvelopeSchema.parse(row.payload);
    const rows = [
      ...(await t.outbox(event.id)),
      ...(await t.outbox(held.holdId)),
    ].filter((r) => r.kind === 'event');
    const byType: Record<string, (typeof rows)[number]> = Object.fromEntries(
      rows.map((r) => [r.type, r]),
    );
    expect(Object.keys(byType).sort()).toEqual([
      'launchevents.booking_confirmed',
      'launchevents.event_closed',
      'launchevents.event_created',
      'launchevents.event_sold_out',
    ]);
    const expectedKey: Record<string, string> = {
      'launchevents.event_created': event.id,
      'launchevents.booking_confirmed': held.holdId,
      'launchevents.event_sold_out': event.id,
      'launchevents.event_closed': event.id,
    };
    for (const [type, row] of Object.entries(byType)) {
      const envelope = parse(row!);
      expect(envelope).toMatchObject({
        type,
        version: 1,
        aggregateType: 'launch_events',
        aggregateId: expectedKey[type],
      });
      expect(row!.topic).toBe('launch_events.events');
      expect(Date.parse(envelope.occurredAt)).not.toBeNaN();
      expect(envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
      launchEventEventSchemas[
        type as keyof typeof launchEventEventSchemas
      ].parse(envelope.payload);
    }

    // a rolled-back transaction leaves no event behind
    const rolledBack = await sale();
    jest
      .spyOn(OutboxService.prototype, 'append')
      .mockRejectedValueOnce(new Error('refused'));
    await t
      .http()
      .post(`/api/shops/${s.shopId}/launch-events/${rolledBack.id}/close`)
      .set(s.auth)
      .expect(500);
    expect(
      (
        await t.rows<{ status: string }>(
          `SELECT "status" FROM "LaunchEvent" WHERE "id" = :id`,
          { id: rolledBack.id },
        )
      )[0].status,
    ).toBe('ON_SALE');
    expect(
      (await t.outbox(rolledBack.id)).filter(
        (r) => r.type === 'launchevents.event_closed',
      ),
    ).toHaveLength(0);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM "LaunchEventHistory" WHERE "launchEventId" = :id AND "toStatus" = 'CLOSED'`,
        { id: rolledBack.id },
      ),
    ).toBe(0);
  });
});
