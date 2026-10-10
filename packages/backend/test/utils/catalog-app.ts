import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import supertest from 'supertest';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { issueSession } from '@app/test/seeds/session.fixture';
import { ProductBatchReadModule, ProductModule } from '@app/domains/catalog';
import {
  AuthApiModule,
  KeyStore,
  Role,
  UserModel,
} from '@app/domains/identity';

export interface TestUser {
  id: string;
  email: string;
  /** `Bearer <access token>` */
  bearer: string;
  sessionId: string;
}

type Agent = ReturnType<typeof supertest>;

/**
 * The real app the catalog specs run against: the catalog's HTTP modules (tenancy is global in
 * `generateTestingModule`) with the identity API for sessions, real Postgres, Redis and DynamoDB Local, and the
 * production pipe, filter and prefix (`configureHttpApp`). Only the clock is replaced, so specs can move time.
 */
export interface CatalogTestApp {
  app: INestApplication;
  clock: FakeClock;
  http(): Agent;
  /** Empties every store, resets the clock and the key cache. */
  reset(): Promise<void>;
  close(): Promise<void>;
  /** A seeded user with a real session (access token signed by the production signer). */
  newUser(options?: { role?: Role; email?: string }): Promise<TestUser>;
  /** A new session for a user whose token expired because the test moved the clock; updates `user.bearer`. */
  reauth(user: TestUser): Promise<TestUser>;
  /** The stored session record, as the session store holds it. */
  session(sessionId: string): Promise<Record<string, unknown> | undefined>;
  /** Request helpers that set the bearer of `user`. */
  as(user: TestUser): {
    get(url: string): ReturnType<Agent['get']>;
    post(url: string): ReturnType<Agent['post']>;
    put(url: string): ReturnType<Agent['put']>;
    patch(url: string): ReturnType<Agent['patch']>;
    delete(url: string): ReturnType<Agent['delete']>;
  };
}

/**
 * `extraImports` adds the worker or projector modules a spec needs; `overrides` swaps providers; a spec that needs to
 * break the shared Redis or the database passes the address of a fault proxy as `redisUrl` or `env` (`DB_HOST`,
 * `DB_PORT`), read once when the app boots.
 */
export async function createCatalogApp(
  options: {
    extraImports?: unknown[];
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
    redisUrl?: string;
    env?: Record<string, string>;
  } = {},
): Promise<CatalogTestApp> {
  const env = {
    ...(options.redisUrl ? { REDIS_URL: options.redisUrl } : {}),
    ...options.env,
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);

  const clock = new FakeClock(new Date());
  let app: INestApplication;
  try {
    const moduleRef = await generateTestingModule(
      [
        AuthApiModule,
        SeedsModule,
        ProductModule,
        ProductBatchReadModule,
        ...(options.extraImports ?? []),
      ],
      {
        stores: ['redis', 'dynamo'],
        customize: (builder) => {
          let b = builder.overrideProvider(CLOCK).useValue(clock);
          for (const o of options.overrides ?? [])
            b = b.overrideProvider(o.provide).useValue(o.useValue);
          return b;
        },
      },
    );
    app = moduleRef.createNestApplication({ bufferLogs: false });
    configureHttpApp(app, {
      useStructuredLogger: false,
      processHandlers: false,
    });
    await app.listen(0, '127.0.0.1');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const seeds = app.get(SeedsService);
  const users = app.get<typeof UserModel>(getModelToken(UserModel));
  const dynamo = app.get(DynamoService);
  let counter = 0;
  const http = () => supertest(app.getHttpServer());

  return {
    app,
    clock,
    http,
    async newUser(opts = {}) {
      const user = await users.create({
        email: opts.email ?? `user-${++counter}-${Date.now()}@example.com`,
        passwordHash: null,
        role: opts.role ?? Role.USER,
      });
      const session = await issueSession(app, { id: user.id, role: user.role });
      return {
        id: user.id,
        email: user.email!,
        bearer: session.bearer,
        sessionId: session.sessionId,
      };
    },
    async reset() {
      await seeds.clean();
      clock.set(new Date());
      app.get(KeyStore).invalidate();
    },
    close: () => app.close(),
    async reauth(user) {
      const session = await issueSession(app, { id: user.id, role: Role.USER });
      user.bearer = session.bearer;
      user.sessionId = session.sessionId;
      return user;
    },
    async session(sessionId) {
      const { Item } = await dynamo.doc.send(
        new GetCommand({
          TableName: dynamo.table('Auth'),
          Key: { PK: `SESSION#${sessionId}`, SK: 'META' },
          ConsistentRead: true,
        }),
      );
      return Item;
    },
    as: (user) => ({
      get: (url) => http().get(url).set('Authorization', user.bearer),
      post: (url) => http().post(url).set('Authorization', user.bearer),
      put: (url) => http().put(url).set('Authorization', user.bearer),
      patch: (url) => http().patch(url).set('Authorization', user.bearer),
      delete: (url) => http().delete(url).set('Authorization', user.bearer),
    }),
  };
}
