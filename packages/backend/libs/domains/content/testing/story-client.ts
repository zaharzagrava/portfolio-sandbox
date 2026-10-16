import { Module, type INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import supertest from 'supertest';
import { v4, v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { Logger as PinoLogger } from 'nestjs-pino';
import { LoggingModule } from '@app/common/logging/logging.module';
import { ApiConfigService } from '@app/common/config';
import type { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { outboxRowsFor } from '@app/common/testing';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import {
  ManualTimeSource,
  TimeSource,
} from '@app/infrastructure/rate-limit/time-source';
import { JobsTestProbe } from '@app/infrastructure/jobs';
import type { JobContext } from '@app/infrastructure/jobs';
import { Role } from '@app/domains/identity';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { issueSession } from '@app/test/seeds/session.fixture';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { createUser } from '@app/test/utils/user-fixtures';
import { STORY_CONFIG } from '../application/story-config.token';
import { ScheduleService } from '../application/schedule.service';
import { STORY_DEFAULTS, type StoryConfig } from '../domain/limits';
import { StoryInvalidationConsumer } from '../infra/invalidation.consumer';
import { StoryShopCopyConsumer } from '../infra/shop-copy.consumer';
import { StoriesJobs } from '../infra/stories.jobs';
import {
  StoriesModule,
  StoriesProjectorModule,
  StoriesWorkerModule,
} from '../stories.module';
import { shopCreatedEvent, deliver } from './events';
import { FakeEdge } from './fake-edge';

export const REVALIDATE_SECRET = 'revalidate-secret-for-specs-0123456789';
export const PREVIEW_SECRET = 'preview-secret-for-specs-0123456789abcdef';
export const FRONT_HOST = 'https://shop.example.test';
export const BACKEND_HOST = 'https://api.example.test';

@Module({
  imports: [StoriesModule, StoriesWorkerModule, StoriesProjectorModule],
  // the projection framework builds these in the projector app; the specs deliver to the same classes
  providers: [StoryShopCopyConsumer, StoryInvalidationConsumer],
})
class SpecModule {}

/** Parses a response body with its contracts schema (VII.6): fails with the issue list, never the values. */
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

export interface Actor {
  id: string;
  auth: Record<string, string>;
  sessionId: string;
}
export interface Seller extends Actor {
  shopId: string;
  shopSlug: string;
}

export interface StoryAppOptions {
  config?: Partial<StoryConfig>;
  /** Do not point the CDN and front end at the fake servers (logging adapters are chosen instead). */
  noEdges?: boolean;
  /** Installs the structured logger and captures everything written to stdout (`logLines()`). */
  captureLogs?: boolean;
}

export interface StoryTestApp {
  app: INestApplication;
  clock: FakeClock;
  db: Sequelize;
  config: StoryConfig;
  settings: MockApiConfigService;
  /** The CDN's API and the front end's revalidation route. */
  cdn: FakeEdge;
  front: FakeEdge;
  http: () => ReturnType<typeof supertest>;
  /** The rate limiter's time: moved together with the clock by `advance` and `setTime`. */
  limiterTime: ManualTimeSource;
  advance(ms: number): Promise<void>;
  setTime(date: Date): Promise<void>;
  user(role?: Role): Promise<Actor>;
  /** A shop whose OWNER is the returned user; `status` seeds a closed shop (the access cache holds a status for 15 s). */
  seller(options?: {
    slug?: string;
    status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
  }): Promise<Seller>;
  member(shopId: string, role: 'ADMIN' | 'STAFF' | 'VIEWER'): Promise<Actor>;
  rows<T extends object>(
    sql: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  outbox(aggregateId: string): ReturnType<typeof outboxRowsFor>;
  shopCopy: StoryShopCopyConsumer;
  invalidation: StoryInvalidationConsumer;
  jobs: StoriesJobs;
  schedules: ScheduleService;
  probe: JobsTestProbe;
  /** Delivers `tenancy.shop_created` for the seller's shop, as the projector would. */
  syncShop(s: Seller, shopVersion?: number): Promise<void>;
  /** A product of the shop, seeded through the catalog's fixture (never through this domain). */
  product(s: Seller, title?: string): Promise<{ id: string }>;
  // --- the staff client ---
  get(s: Actor, path: string): supertest.Test;
  post(s: Actor, path: string, body?: object): supertest.Test;
  put(s: Actor, path: string, body?: object): supertest.Test;
  del(s: Actor, path: string): supertest.Test;
  /** `POST /shops/:shopId/stories`, expecting 201; returns the story. */
  createStory(
    s: Seller,
    slug?: string,
    defaultLocale?: string,
  ): Promise<{ id: string; slug: string }>;
  saveDraft(
    s: Seller,
    storyId: string,
    locale: string,
    fields?: { title?: string; blocks?: unknown[]; seo?: object },
    expectedRevision?: number,
  ): supertest.Test;
  publish(
    s: Seller,
    storyId: string,
    body: { expectedVersion: number; at?: string },
    key?: string,
  ): supertest.Test;
  /** Create + save an `en` draft + publish; returns the ids. */
  published(
    s: Seller,
    options?: { slug?: string; locales?: string[] },
  ): Promise<{ id: string; slug: string }>;
  /** A job context as the worker would give it. */
  jobContext(overrides?: Partial<JobContext>): JobContext;
  /** Everything written to stdout since the app started (only with `captureLogs`). */
  logLines(): string;
  close(): Promise<void>;
}

export const basicBlocks = (text = 'Design') => [
  { type: 'heading', level: 2, text },
  { type: 'richText', html: '<p>Hello <strong>world</strong></p>' },
];

/**
 * The real story modules over real Postgres, Redis, outbox and the job table, with the production global pipe, filter
 * and prefix. Only the edges are replaced: the clock, and the CDN's API and the front end's route are real HTTP
 * servers on local ports that the spec scripts and inspects.
 */
export async function createStoryApp(
  options: StoryAppOptions = {},
): Promise<StoryTestApp> {
  const clock = new FakeClock(new Date());
  const config: StoryConfig = { ...STORY_DEFAULTS, ...options.config };
  const logs: string[] = [];
  const writeSpy = options.captureLogs
    ? jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          logs.push(String(chunk));
          return true;
        })
    : null;
  const cdn = new FakeEdge();
  const front = new FakeEdge();
  await cdn.start();
  await front.start();
  // the limiter's windows move with the clock the spec moves, instead of the store's own time
  const limiterTime = new ManualTimeSource(clock.nowMs());
  const moduleRef = await generateTestingModule(
    options.captureLogs
      ? [SpecModule, SeedsModule, LoggingModule]
      : [SpecModule, SeedsModule],
    {
      stores: ['redis'],
      customize: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(TimeSource)
          .useValue(limiterTime)
          .overrideProvider(STORY_CONFIG)
          .useValue(config),
    },
  );
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  const settings = app.get(ApiConfigService) as MockApiConfigService;
  settings.set('front_host', FRONT_HOST);
  settings.set('backend_host', BACKEND_HOST);
  settings.set('story_preview_secret', PREVIEW_SECRET);
  if (!options.noEdges) {
    settings.set('cdn_zone', 'zone-test');
    settings.set('cdn_token', 'token-test');
    settings.set('cdn_api_url', cdn.url);
    settings.set('revalidate_secret', REVALIDATE_SECRET);
    settings.set('revalidate_url', `${front.url}/api/revalidate`);
  }
  configureHttpApp(app, {
    useStructuredLogger: options.captureLogs === true,
    processHandlers: false,
  });
  await app.listen(0, '127.0.0.1');
  if (options.captureLogs) app.useLogger(app.get(PinoLogger));

  const db: Sequelize = app.get(getConnectionToken());
  const http = () => supertest(app.getHttpServer());

  const actors: { actor: Actor; role: Role }[] = [];
  const user: StoryTestApp['user'] = async (role = Role.USER) => {
    const created = await createUser(app, {
      email: `s-${v4()}@mail.com`,
      role,
    });
    const { bearer, sessionId } = await issueSession(app, created);
    const actor = {
      id: created.id,
      auth: { Authorization: bearer },
      sessionId,
    };
    actors.push({ actor, role });
    return actor;
  };
  /** Signs the actors in again: an access token lives 300 s of the clock's time. */
  const resign = async () => {
    for (const { actor, role } of actors) {
      const session = await issueSession(app, { id: actor.id, role });
      actor.auth.Authorization = session.bearer;
      actor.sessionId = session.sessionId;
    }
  };
  const seller: StoryTestApp['seller'] = async (opts = {}) => {
    const owner = await user();
    const shop = await createShop(app, owner, {
      name: 'Story Shop',
      slug: opts.slug ?? `shop-${v4().slice(0, 8)}`,
      ...(opts.status ? { status: opts.status } : {}),
    });
    return { ...owner, shopId: shop.id as string, shopSlug: shop.slug };
  };
  const member: StoryTestApp['member'] = async (shopId, role) => {
    const created = await user();
    await addMember(app, shopId, created.id, role);
    return created;
  };
  const rows: StoryTestApp['rows'] = (sql, replacements = {}) =>
    db.query(sql, { type: QueryTypes.SELECT, replacements }) as Promise<never>;

  const shopCopy = app.get(StoryShopCopyConsumer);
  const syncShop: StoryTestApp['syncShop'] = async (s, shopVersion = 1) => {
    await deliver(
      shopCopy,
      shopCreatedEvent(s.shopId, s.shopSlug, shopVersion),
    );
  };

  const prefix = (s: Seller, path: string) => `/api/shops/${s.shopId}${path}`;

  const api: Pick<StoryTestApp, 'get' | 'post' | 'put' | 'del'> = {
    get: (s, path) => http().get(path).set(s.auth),
    post: (s, path, body) => http().post(path).set(s.auth).send(body),
    put: (s, path, body) => http().put(path).set(s.auth).send(body),
    del: (s, path) => http().delete(path).set(s.auth),
  };

  const createStory: StoryTestApp['createStory'] = async (
    s,
    slug = `story-${v4().slice(0, 8)}`,
    defaultLocale,
  ) => {
    const res = await api
      .post(s, prefix(s, '/stories'), {
        slug,
        ...(defaultLocale ? { defaultLocale } : {}),
      })
      .expect(201);
    return { id: res.body.id as string, slug };
  };
  const saveDraft: StoryTestApp['saveDraft'] = (
    s,
    storyId,
    locale,
    fields = {},
    expectedRevision = 0,
  ) =>
    api.put(s, prefix(s, `/stories/${storyId}/drafts/${locale}`), {
      title: fields.title ?? `Title ${locale}`,
      blocks: fields.blocks ?? basicBlocks(),
      ...(fields.seo ? { seo: fields.seo } : {}),
      expectedRevision,
    });
  const publish: StoryTestApp['publish'] = (
    s,
    storyId,
    body,
    key = `k-${uuidv7()}`,
  ) =>
    http()
      .post(prefix(s, `/stories/${storyId}/publish`))
      .set(s.auth)
      .set('Idempotency-Key', key)
      .send(body);

  return {
    app,
    clock,
    db,
    config,
    settings,
    cdn,
    front,
    http,
    limiterTime,
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
    user,
    seller,
    member,
    rows,
    outbox: (aggregateId) => outboxRowsFor(app, aggregateId),
    shopCopy,
    invalidation: app.get(StoryInvalidationConsumer),
    jobs: app.get(StoriesJobs, { strict: false }),
    schedules: app.get(ScheduleService, { strict: false }),
    probe: new JobsTestProbe(db),
    syncShop,
    product: async (s, title) => {
      const created = await createProduct(
        app,
        { id: s.shopId },
        title ? { title } : {},
      );
      return { id: created.id };
    },
    ...api,
    createStory,
    saveDraft,
    publish,
    published: async (s, opts = {}) => {
      const story = await createStory(s, opts.slug);
      const locales = opts.locales ?? ['en'];
      for (const locale of locales)
        await saveDraft(s, story.id, locale).expect(200);
      await publish(s, story.id, { expectedVersion: 0 }).expect(200);
      return story;
    },
    jobContext: (overrides = {}) => ({
      jobId: uuidv7(),
      attempt: 1,
      maxAttempts: 5,
      isLastAttempt: false,
      heartbeat: () => Promise.resolve(),
      signal: new AbortController().signal,
      ...overrides,
    }),
    logLines: () => logs.join(''),
    close: async () => {
      writeSpy?.mockRestore();
      await app.close();
      await cdn.stop();
      await front.stop();
    },
  };
}
