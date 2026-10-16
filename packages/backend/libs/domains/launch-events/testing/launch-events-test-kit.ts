import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import supertest from 'supertest';
import { v4 } from 'uuid';
import type { z } from 'zod';
import { Logger as PinoLogger } from 'nestjs-pino';
import { LoggingModule } from '@app/common/logging/logging.module';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { outboxRowsFor } from '@app/common/testing';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { JobsTestProbe } from '@app/infrastructure/jobs';
import type { JobContext } from '@app/infrastructure/jobs';
import { TransactionRunner } from '@app/infrastructure/context';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  ManualTimeSource,
  TimeSource,
} from '@app/infrastructure/rate-limit/time-source';
import { Role } from '@app/domains/identity';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { issueSession } from '@app/test/seeds/session.fixture';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { createUser } from '@app/test/utils/user-fixtures';
import { LaunchEventsModule } from '../launch-events.module';
import { LaunchEventsWorkerModule } from '../launch-events-worker.module';
import { LaunchEventTopicsModule } from '../realtime-topics.module';
import { Admitter, LAUNCH_ADMITTER_OPTIONS } from '../infra/admitter';
import { LaunchEventJobs } from '../infra/jobs/launch-event.jobs';
import { ReconcileService } from '../application/reconcile.service';
import { LaunchEventService } from '../application/launch-event.service';
import {
  ADMISSION_TOKEN_PORT,
  BOOKING_REPOSITORY,
  EVENT_GATE,
  EVENT_REPOSITORY,
  HOLD_LEDGER,
  HUMAN_VERIFIER,
  LAUNCH_EVENTS_CONFIG,
  LAUNCH_RANDOM,
  QUEUE_STORE,
  QUOTA_STORE,
  SEAT_LOCK_STORE,
  SEAT_MAP_STORE,
  type HumanVerifier,
  type LaunchEventsSettings,
} from '../domain/ports';

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const DAY = 24 * 60 * MINUTE;

export interface Actor {
  id: string;
  auth: Record<string, string>;
}
export interface Seller extends Actor {
  shopId: string;
}

/** A store port instrumented in place: every call is recorded and the whole port can be switched off (fault injection). */
export interface StoreSwitch {
  readonly name: string;
  calls: string[];
  isDown: boolean;
  /** Method names that throw while `isDown` is false (a fault at one step only). */
  failing: Set<string>;
  down(): void;
  up(): void;
  reset(): void;
  /** Number of recorded calls (all, or of one method). */
  count(method?: string): number;
}

/** One switch over every instance of a port: the core and the worker module each build their own adapters. */
function instrument(ports: object[], name: string, log: string[]): StoreSwitch {
  const first = instrumentOne(ports[0], name, log);
  for (const port of ports.slice(1)) instrumentOne(port, name, log, first);
  return first;
}

function instrumentOne<T extends object>(
  port: T,
  name: string,
  log: string[],
  shared?: StoreSwitch,
): StoreSwitch {
  const control: StoreSwitch = shared ?? {
    name,
    calls: [],
    isDown: false,
    failing: new Set(),
    down() {
      control.isDown = true;
    },
    up() {
      control.isDown = false;
      control.failing.clear();
    },
    reset() {
      control.calls.length = 0;
    },
    count(method) {
      return method
        ? control.calls.filter((c) => c === method).length
        : control.calls.length;
    },
  };
  const names = new Set<string>();
  // Methods of the class only: instance fields (an injected model class is a function too) stay as they are.
  const ownFields = new Set(Object.getOwnPropertyNames(port));
  for (
    let proto: object | null = Object.getPrototypeOf(port);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  )
    for (const key of Object.getOwnPropertyNames(proto))
      if (
        key !== 'constructor' &&
        !ownFields.has(key) &&
        typeof (port as Record<string, unknown>)[key] === 'function'
      )
        names.add(key);
  for (const key of names) {
    const original = (port as Record<string, (...a: unknown[]) => unknown>)[
      key
    ];
    (port as Record<string, unknown>)[key] = (...args: unknown[]) => {
      control.calls.push(key);
      log.push(`${name}.${key}`);
      if (control.isDown || control.failing.has(key))
        return Promise.reject(new Error(`${name} is down`));
      return original.apply(port, args);
    };
  }
  return control;
}

/** The bot-check provider, faked at the system edge. */
export class FakeHumanVerifier implements HumanVerifier {
  valid = new Set<string>();
  mode: 'ok' | 'down' = 'ok';
  calls: string[] = [];
  verify(result: string): Promise<boolean> {
    this.calls.push(result);
    if (this.mode === 'down') return Promise.reject(new Error('timeout'));
    return Promise.resolve(this.valid.has(result));
  }
}

export interface Published {
  topic: string;
  type: string;
  data: Record<string, unknown>;
}

export interface LaunchTestApp {
  app: INestApplication;
  clock: FakeClock;
  db: Sequelize;
  settings: LaunchEventsSettings;
  human: FakeHumanVerifier;
  stores: Record<
    | 'events'
    | 'bookings'
    | 'ledger'
    | 'locks'
    | 'map'
    | 'quota'
    | 'gate'
    | 'queue'
    | 'tokens'
    | 'limiter',
    StoreSwitch
  >;
  /** Every realtime publish since the app started (or since `published.length = 0`). */
  published: Published[];
  /** Every store call and transaction mark in order (`ledger.transition`, `tx:begin`, `tx:end`, …). */
  callLog: string[];
  /** Makes the next realtime publishes fail (the transport is forced to fail). */
  failPublish(on: boolean): void;
  limiterTime: ManualTimeSource;
  admitter: Admitter;
  jobs: LaunchEventJobs;
  reconciler: ReconcileService;
  events: LaunchEventService;
  probe: JobsTestProbe;
  http: () => ReturnType<typeof supertest>;
  advance(ms: number): Promise<void>;
  setTime(date: Date): Promise<void>;
  seller(options?: {
    status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
  }): Promise<Seller>;
  member(shopId: string, role: 'ADMIN' | 'STAFF' | 'VIEWER'): Promise<Actor>;
  buyer(): Promise<Actor>;
  buyers(n: number): Promise<Actor[]>;
  rows<T extends object>(
    sql: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  outbox(aggregateId: string): ReturnType<typeof outboxRowsFor>;
  jobContext(overrides?: Partial<JobContext>): JobContext;
  logLines(): string;
  // --- scenario helpers ---
  /** Creates an event through the organizer route (sale opens now, starts in a day). */
  createEvent(
    s: Seller,
    overrides?: Record<string, unknown>,
  ): Promise<EventView>;
  /** Creates an event and opens the sale (the `open-sales` job). */
  onSale(s: Seller, overrides?: Record<string, unknown>): Promise<EventView>;
  join(
    event: { id: string },
    who: Actor,
    headers?: Record<string, string>,
  ): supertest.Test;
  status(event: { id: string }, who: Actor, ticket: string): supertest.Test;
  /** Joins, runs the admitter once for the event and returns the admission token. */
  admit(event: { id: string }, who: Actor): Promise<string>;
  /** Joins everybody, runs the admitter once (the event's rate must cover them) and returns their tokens in order. */
  admitAll(event: { id: string }, people: Actor[]): Promise<string[]>;
  hold(
    event: { id: string },
    who: Actor,
    token: string | undefined,
    body: object,
    key?: string,
  ): supertest.Test;
  confirm(holdId: string, who: Actor, key?: string): supertest.Test;
  release(holdId: string, who: Actor): supertest.Test;
  /** Admit + hold in one go, expecting 201. */
  held(event: { id: string }, who: Actor, seats: number[]): Promise<HoldView>;
  /** Waits (real time) until `check` returns true. */
  eventually(
    check: () => Promise<boolean> | boolean,
    ms?: number,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface EventView {
  id: string;
  shopId: string;
  status: string;
  seatCount: number;
  seatsPerRow: number;
  seatingMode: string;
  perUserLimit: number;
  startsAt: string;
  salesOpenAt: string;
  humanCheckRequired: boolean;
}
export interface HoldView {
  holdId: string;
  eventId: string;
  seats: number[];
  expiresAt: string;
  serverTime: string;
  limit: { perUser: number; remaining: number };
}

export function expectContract<S extends z.ZodType>(
  schema: S,
  body: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new Error(
      `response does not match its contract: ${JSON.stringify(
        parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
        })),
      )}`,
    );
  return parsed.data;
}

/**
 * The problem document every error carries (S54 FR-001). Not `problemDetailsSchema`: that schema wants a snake_case
 * `code`, while this capability's vocabulary (FR-051) is upper case; see gaps.md "Sibling-spec follow-ups" (S54).
 */
export function expectProblem(body: unknown): {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId: string;
} {
  const p = body as Record<string, unknown>;
  for (const key of [
    'type',
    'title',
    'detail',
    'instance',
    'code',
    'requestId',
  ])
    if (typeof p?.[key] !== 'string' || (p[key] as string).length === 0)
      throw new Error(
        `problem document lacks "${key}": ${JSON.stringify(body)}`,
      );
  if (typeof p.status !== 'number' || p.status < 400)
    throw new Error(`problem document has no status: ${JSON.stringify(body)}`);
  for (const internal of ['area', 'data', 'causes'])
    if (internal in p)
      throw new Error(`problem document exposes "${internal}"`);
  return p as never;
}

export interface LaunchAppOptions {
  captureLogs?: boolean;
  /** Seeded random source for the pre-sale shuffle and best-available (default `Math.random`). */
  random?: () => number;
  queueMaxLength?: number;
}

export async function createLaunchApp(
  options: LaunchAppOptions = {},
): Promise<LaunchTestApp> {
  const clock = new FakeClock(new Date());
  const logs: string[] = [];
  const writeSpy = options.captureLogs
    ? jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          logs.push(String(chunk));
          return true;
        })
    : null;
  const limiterTime = new ManualTimeSource(clock.nowMs());
  const settings: LaunchEventsSettings = {
    queueMaxLength: options.queueMaxLength ?? 2_000_000,
  };
  const human = new FakeHumanVerifier();
  const moduleRef = await generateTestingModule(
    [
      LaunchEventsModule,
      LaunchEventsWorkerModule,
      LaunchEventTopicsModule,
      SeedsModule,
      ...(options.captureLogs ? [LoggingModule] : []),
    ],
    {
      stores: ['redis', 'dynamo'],
      customize: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(TimeSource)
          .useValue(limiterTime)
          .overrideProvider(HUMAN_VERIFIER)
          .useValue(human)
          .overrideProvider(LAUNCH_EVENTS_CONFIG)
          .useValue(settings)
          .overrideProvider(LAUNCH_ADMITTER_OPTIONS)
          .useValue({ autoStart: false })
          .overrideProvider(LAUNCH_RANDOM)
          .useValue(options.random ?? Math.random),
    },
  );
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  configureHttpApp(app, {
    useStructuredLogger: options.captureLogs === true,
    processHandlers: false,
  });
  await app.listen(0, '127.0.0.1');
  if (options.captureLogs) app.useLogger(app.get(PinoLogger));

  const db: Sequelize = app.get(getConnectionToken());
  const http = () => supertest(app.getHttpServer());

  // The limiter keeps its windows in Redis, and every spec calls from the same address: a run must not inherit the
  // exhausted public-read budget of the run before it (L-006).
  const limiterKeys = await app
    .get(RedisService)
    .client.keys('rl:{launch.seatmap.ip|*');
  if (limiterKeys.length > 0)
    await app.get(RedisService).client.del(...limiterKeys);

  const pick = (token: symbol): object[] =>
    [LaunchEventsModule, LaunchEventsWorkerModule].map((module) =>
      app.select(module).get<object>(token, { strict: true }),
    );
  const callLog: string[] = [];
  const stores = {
    events: instrument(pick(EVENT_REPOSITORY), 'events', callLog),
    bookings: instrument(pick(BOOKING_REPOSITORY), 'bookings', callLog),
    ledger: instrument(pick(HOLD_LEDGER), 'ledger', callLog),
    locks: instrument(pick(SEAT_LOCK_STORE), 'locks', callLog),
    map: instrument(pick(SEAT_MAP_STORE), 'map', callLog),
    quota: instrument(pick(QUOTA_STORE), 'quota', callLog),
    gate: instrument(pick(EVENT_GATE), 'gate', callLog),
    queue: instrument(pick(QUEUE_STORE), 'queue', callLog),
    tokens: instrument(pick(ADMISSION_TOKEN_PORT), 'tokens', callLog),
    limiter: instrument([app.get(RateLimiterService)], 'limiter', callLog),
  };
  // Marks where every transaction starts and ends in the same ordered log (no store call may sit between the marks).
  const runner = app.get(TransactionRunner, { strict: false });
  const runTransaction = runner.run.bind(runner);
  runner.run = (async (fn: never, options: never) => {
    callLog.push('tx:begin');
    try {
      return await runTransaction(fn, options);
    } finally {
      callLog.push('tx:end');
    }
  }) as typeof runner.run;

  const published: Published[] = [];
  let publishFails = false;
  const publisher = app.get(RealtimePublisher);
  const realPublish = publisher.publish.bind(publisher);
  // Wrapped in place (not a jest spy), so a spec's `jest.restoreAllMocks()` does not switch the recording off.
  publisher.publish = ((topic: string, type: string, data: unknown) => {
    if (publishFails) return Promise.reject(new Error('realtime down'));
    published.push({ topic, type, data: data as Record<string, unknown> });
    return realPublish(topic as never, type, data);
  }) as typeof publisher.publish;

  // An access token lives 300 s of the (fake) clock. Only tokens close to their end are signed again when time moves, so
  // a small step costs nothing however many people the spec has created.
  const actors: { actor: Actor; role: Role; issuedAtMs: number }[] = [];
  const user = async (role = Role.USER): Promise<Actor> => {
    const created = await createUser(app, {
      email: `l-${v4()}@mail.com`,
      role,
    });
    const { bearer } = await issueSession(app, created);
    const actor = { id: created.id, auth: { Authorization: bearer } };
    actors.push({ actor, role, issuedAtMs: clock.nowMs() });
    return actor;
  };
  const resign = async () => {
    const stale = actors.filter((a) => clock.nowMs() - a.issuedAtMs > 150_000);
    for (let i = 0; i < stale.length; i += 25)
      await Promise.all(
        stale.slice(i, i + 25).map(async (entry) => {
          const session = await issueSession(app, {
            id: entry.actor.id,
            role: entry.role,
          });
          entry.actor.auth.Authorization = session.bearer;
          entry.issuedAtMs = clock.nowMs();
        }),
      );
  };
  const seller = async (
    options: { status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED' } = {},
  ): Promise<Seller> => {
    const owner = await user();
    const shop = await createShop(app, owner, {
      name: 'Launch Shop',
      slug: `shop-${v4().slice(0, 8)}`,
      ...(options.status ? { status: options.status } : {}),
    });
    return { ...owner, shopId: shop.id as string };
  };
  const buyers = async (n: number) =>
    Promise.all(Array.from({ length: n }, () => user()));

  const admitter = app.get(Admitter, { strict: false });
  const t: LaunchTestApp = {
    app,
    clock,
    db,
    settings,
    human,
    stores,
    published,
    callLog,
    failPublish: (on) => {
      publishFails = on;
    },
    limiterTime,
    admitter,
    jobs: app.get(LaunchEventJobs, { strict: false }),
    reconciler: app.get(ReconcileService, { strict: false }),
    events: app.get(LaunchEventService, { strict: false }),
    probe: new JobsTestProbe(db),
    http,
    advance: async (ms) => {
      clock.advance(ms);
      limiterTime.advance(ms);
      await resign();
    },
    setTime: async (date) => {
      clock.set(date);
      limiterTime.set(date.getTime());
      await resign();
    },
    seller,
    member: async (shopId, role) => {
      const created = await user();
      await addMember(app, shopId, created.id, role);
      return created;
    },
    buyer: () => user(),
    buyers,
    rows: (sql, replacements = {}) =>
      db.query(sql, {
        type: QueryTypes.SELECT,
        replacements,
      }) as Promise<never>,
    outbox: (aggregateId) => outboxRowsFor(app, aggregateId),
    jobContext: (overrides = {}) => ({
      jobId: v4(),
      attempt: 1,
      maxAttempts: 5,
      isLastAttempt: false,
      heartbeat: () => Promise.resolve(),
      signal: new AbortController().signal,
      ...overrides,
    }),
    logLines: () => logs.join(''),
    createEvent: async (s, overrides = {}) => {
      const now = clock.nowMs();
      const res = await http()
        .post(`/api/shops/${s.shopId}/launch-events`)
        .set(s.auth)
        .send({
          title: 'iPhone Keynote',
          venue: 'Berlin',
          startsAt: new Date(now + DAY).toISOString(),
          salesOpenAt: new Date(now).toISOString(),
          seatCount: 800,
          seatsPerRow: 20,
          perUserLimit: 2,
          admissionRatePerSec: 10,
          ...overrides,
        });
      if (res.status !== 201)
        throw new Error(
          `create event: ${res.status} ${JSON.stringify(res.body)}`,
        );
      return res.body as EventView;
    },
    onSale: async (s, overrides = {}) => {
      const event = await t.createEvent(s, overrides);
      await t.jobs.openSales({ eventId: event.id });
      return { ...event, status: 'ON_SALE' };
    },
    join: (event, who, headers = {}) =>
      http()
        .post(`/api/launch-events/${event.id}/queue`)
        .set(who.auth)
        .set(headers),
    status: (event, who, ticket) =>
      http()
        .get(`/api/launch-events/${event.id}/queue/${ticket}`)
        .set(who.auth),
    admit: async (event, who) => {
      const joined = await t.join(event, who).expect((r) => {
        if (![200, 201].includes(r.status))
          throw new Error(`join: ${r.status} ${JSON.stringify(r.body)}`);
      });
      await admitter.admitEvent(event.id);
      const status = await t.status(event, who, joined.body.ticket).expect(200);
      if (!status.body.admitted)
        throw new Error(`not admitted: ${JSON.stringify(status.body)}`);
      return status.body.admissionToken as string;
    },
    admitAll: async (event, people) => {
      const joined = await Promise.all(people.map((p) => t.join(event, p)));
      joined.forEach((res) => {
        if (![200, 201].includes(res.status))
          throw new Error(`join: ${res.status} ${JSON.stringify(res.body)}`);
      });
      await admitter.admitEvent(event.id);
      return Promise.all(
        people.map(async (p, i) => {
          const res = await t.status(event, p, joined[i].body.ticket);
          if (!res.body.admitted)
            throw new Error(`not admitted: ${JSON.stringify(res.body)}`);
          return res.body.admissionToken as string;
        }),
      );
    },
    hold: (event, who, token, body, key = `k-${v4()}`) =>
      http()
        .post(`/api/launch-events/${event.id}/holds`)
        .set(who.auth)
        .set(token ? { 'X-Admission-Token': token } : {})
        .set('Idempotency-Key', key)
        .send(body),
    confirm: (holdId, who, key = `k-${v4()}`) =>
      http()
        .post(`/api/launch-holds/${holdId}/confirm`)
        .set(who.auth)
        .set('Idempotency-Key', key)
        .send({}),
    release: (holdId, who) =>
      http().delete(`/api/launch-holds/${holdId}`).set(who.auth),
    held: async (event, who, seats) => {
      const token = await t.admit(event, who);
      const res = await t.hold(event, who, token, { seats }).expect(201);
      return res.body as HoldView;
    },
    eventually: async (check, ms = 5_000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('condition not reached in time');
    },
    close: async () => {
      writeSpy?.mockRestore();
      jest.restoreAllMocks();
      await app.close();
    },
  };
  return t;
}
