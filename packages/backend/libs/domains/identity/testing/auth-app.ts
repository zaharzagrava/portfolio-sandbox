import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import supertest from 'supertest';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { FakeBreachChecker } from '@app/test/fakes/breach-checker.fake';
import { AuthApiModule } from '../auth-api.module';
import { BREACH_CHECKER } from '../domain/ports';
import { KeyStore } from '../infra/keys/key-store.service';
import { PasswordHasher } from '../infra/crypto/password-hasher';
import User, { Role } from '../infra/models/user.model';

export const TEST_PASSWORD = 'correct horse battery staple';

/** Reads the `Auth` table the way a spec asserts persisted state: sessions, refresh digests, everything. */
export function authStore(app: INestApplication) {
  const dynamo = app.get(DynamoService);
  const TableName = dynamo.table('Auth');
  const get = async (Key: Record<string, string>) =>
    (
      await dynamo.doc.send(
        new GetCommand({ TableName, Key, ConsistentRead: true }),
      )
    ).Item;
  return {
    session: (sid: string) => get({ PK: `SESSION#${sid}`, SK: 'META' }),
    /** The stored record of a raw refresh token (by its digest). */
    token: (raw: string) =>
      get({
        PK: `RT#${createHash('sha256').update(raw).digest('base64url')}`,
        SK: 'META',
      }),
    all: async () =>
      (
        await dynamo.doc.send(
          new ScanCommand({ TableName, ConsistentRead: true }),
        )
      ).Items ?? [],
  };
}

/** Splits a compact JWS into its decoded header and claims (no verification: tests assert on the content). */
export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
} {
  const [header, claims] = token.split('.');
  const parse = (part: string) =>
    JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return { header: parse(header), claims: parse(claims) };
}

export interface AuthTestApp {
  app: INestApplication;
  clock: FakeClock;
  breach: FakeBreachChecker;
  seeds: SeedsService;
  hasher: PasswordHasher;
  http(): ReturnType<typeof supertest>;
  /** Empties every store and resets the clock, the fake corpus and the key cache. */
  reset(): Promise<void>;
  /** Inserts a user directly (no registration), with an Argon2id hash of `password`. */
  seedUser(input?: {
    email?: string;
    password?: string;
    role?: Role;
    passwordHash?: string | null;
  }): Promise<User>;
  close(): Promise<void>;
}

/**
 * The real `AuthApiModule` over real Postgres, Redis and DynamoDB Local, booted the way production boots an app
 * (`configureHttpApp`: client address, body parsing, prefix, validation pipe; the problem+json filter; the S50
 * `RateLimitModule.forRoot()` that `generateTestingModule` installs, without the default floor). Only the system-edge
 * dependencies are replaced: the breached-password corpus and the clock (F-S50-2).
 */
export async function createAuthApp(
  options: { extraImports?: unknown[] } = {},
): Promise<AuthTestApp> {
  const clock = new FakeClock(new Date());
  const breach = new FakeBreachChecker();
  const moduleRef = await generateTestingModule(
    [AuthApiModule, SeedsModule, ...(options.extraImports ?? [])],
    {
      stores: ['redis', 'dynamo'],
      customize: (builder) =>
        builder
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(BREACH_CHECKER)
          .useValue(breach),
    },
  );
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  configureHttpApp(app, { useStructuredLogger: false, processHandlers: false });
  await app.listen(0, '127.0.0.1');

  const seeds = app.get(SeedsService);
  const hasher = new PasswordHasher();
  const users = app.get<typeof User>(getModelToken(User));
  let counter = 0;

  return {
    app,
    clock,
    breach,
    seeds,
    hasher,
    http: () => supertest(app.getHttpServer()),
    async reset() {
      await seeds.clean();
      clock.set(new Date());
      breach.reset();
      app.get(KeyStore).invalidate();
    },
    async seedUser(input = {}) {
      const password = input.password ?? TEST_PASSWORD;
      return users.create({
        email: input.email ?? `user-${++counter}-${Date.now()}@example.com`,
        passwordHash:
          input.passwordHash === undefined
            ? await hasher.hash(password)
            : input.passwordHash,
        role: input.role ?? Role.USER,
      });
    },
    close: () => app.close(),
  };
}
