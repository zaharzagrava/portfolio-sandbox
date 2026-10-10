import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { v4 } from 'uuid';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { IdentityTopicsModule } from '@app/domains/identity';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import {
  RealtimeConfig,
  RealtimePublisher,
  RealtimeStreamModule,
  realtimeRatePolicies,
  RealtimeSubscriptions,
  SubscriptionHub,
  TopicRegistry,
  type RealtimeConfigValues,
} from '@app/infrastructure/realtime';
import {
  TestFixtures,
  TestTopicsModule,
} from '@app/infrastructure/realtime/testing/test-topics.module';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { issueSession } from '@app/test/seeds/session.fixture';
import { TableName } from '@app/test/seeds/types';
import { generateTestingModule } from './global-modules';

export interface RealtimeTestUser {
  id: string;
  bearer: string;
}

/**
 * One gateway instance for the S51 specs: the real `RealtimeStreamModule` and `RealtimeModule` behind the production
 * pipe, filter, prefix and interceptors (`configureHttpApp`, the S50 interceptor from the shared harness), the identity
 * credential check, and the test topics. Call it twice for the two-instance cases: each app has its own hub, both share
 * the store. `config` carries millisecond-level limits.
 */
export interface RealtimeTestApp {
  app: INestApplication;
  port: number;
  baseUrl: string;
  clock: FakeClock;
  publisher: RealtimePublisher;
  subscriptions: RealtimeSubscriptions;
  hub: SubscriptionHub;
  registry: TopicRegistry;
  fixtures: TestFixtures;
  redis: RedisService;
  seeds: SeedsService;
  /** `GET /api/streams?topics=<a,b>` */
  url(...topics: string[]): string;
  newUser(): Promise<RealtimeTestUser>;
  close(): Promise<void>;
}

export async function createRealtimeApp(
  options: {
    config?: Partial<RealtimeConfigValues>;
    extraImports?: unknown[];
    /** Skip the seed cleanup (a second instance in the same test must not wipe the first's store). */
    keepStore?: boolean;
    /** Keep the production `realtime.connect` limit (60/min). Otherwise it is raised so specs can open hundreds of streams. */
    realRateLimit?: boolean;
  } = {},
): Promise<RealtimeTestApp> {
  const clock = new FakeClock(new Date());
  (
    realtimeRatePolicies.policies['realtime.connect'] as { limit: number }
  ).limit = options.realRateLimit ? 60 : 1_000_000;
  const moduleRef = await generateTestingModule(
    [
      RealtimeStreamModule,
      TestTopicsModule,
      IdentityTopicsModule,
      SeedsModule,
      ...(options.extraImports ?? []),
    ],
    {
      stores: ['redis'],
      customize: (builder) =>
        builder
          .overrideProvider(RealtimeConfig)
          .useValue(RealtimeConfig.from(options.config ?? {}, {}))
          .overrideProvider(CLOCK)
          .useValue(clock),
    },
  );
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  configureHttpApp(app, { useStructuredLogger: false, processHandlers: false });
  try {
    await app.listen(0, '127.0.0.1');
  } catch (error) {
    // a failed boot (for example a duplicate route) must not leave connections open
    await app.close().catch(() => undefined);
    throw error;
  }
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const seeds = app.get(SeedsService);
  if (!options.keepStore) await seeds.clean();

  return {
    app,
    port,
    baseUrl,
    clock,
    publisher: app.get(RealtimePublisher),
    subscriptions: app.get(RealtimeSubscriptions),
    hub: app.get(SubscriptionHub),
    registry: app.get(TopicRegistry),
    fixtures: app.get(TestFixtures),
    redis: app.get(RedisService),
    seeds,
    url: (...topics) => `${baseUrl}/streams?topics=${topics.join(',')}`,
    async newUser() {
      const [user] = await seeds.createTreelike([
        { __type__: TableName.User, email: `rt-${v4()}@mail.com` },
      ]);
      const session = await issueSession(app, user);
      return { id: user.id, bearer: session.bearer };
    },
    close: () => app.close(),
  };
}

/** A fresh topic id so specs on the shared store never see each other's events. */
export const freshId = () => v4().slice(0, 8);
