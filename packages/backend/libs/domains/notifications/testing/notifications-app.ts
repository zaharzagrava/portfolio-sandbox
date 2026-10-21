import type { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import { CLOCK } from '@app/common/core/clock';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { issueSession } from '@app/test/seeds/session.fixture';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import {
  createUser,
  createUserWithoutEmail,
} from '@app/test/utils/user-fixtures';
import { AuthApiModule, KeyStore, type Role } from '@app/domains/identity';
import {
  EMAIL_PROVIDERS,
  PUSH_PROVIDERS,
  SMS_PROVIDERS,
} from '../domain/provider-ports';
import { PROVIDER_CHAINS, type ProviderChains } from '../domain/ports';
import type { ChannelSender } from '../infra/providers/channel-sender';
import { NotificationsModule } from '../notifications.module';
import { NotificationsProjectorModule } from '../notifications-projector.module';
import { NotificationsWorkerModule } from '../notifications-worker.module';
import { TransactionalMailModule } from '../transactional-mail.module';
import { ScriptedProvider } from './scripted-provider';
import { TestClock } from './test-clock';

export interface TestUser {
  id: string;
  email: string;
  /** `Bearer <access token>` */
  bearer: string;
  sessionId: string;
}

type Agent = ReturnType<typeof supertest>;

/** The realtime hub's transport: records every publish, or refuses them while `down`. */
export class FakeRealtimeHub {
  readonly published: Array<{ topic: string; type: string; data: unknown }> =
    [];
  down = false;

  publish(
    topic: string,
    type: string,
    data: unknown,
  ): Promise<{ published: boolean; id: string | null }> {
    if (this.down) return Promise.reject(new Error('realtime hub is down'));
    this.published.push({ topic, type, data });
    return Promise.resolve({ published: true, id: null });
  }

  /** What was announced to `userId` on their private topic. */
  to(userId: string) {
    return this.published.filter((p) => p.topic === `user:${userId}`);
  }

  reset(): void {
    this.published.length = 0;
    this.down = false;
  }
}

export interface NotificationsTestApp {
  app: INestApplication;
  /** Real time until a spec calls `freeze`, `set` or `advance`; the injected clock of every notifications service. */
  clock: TestClock;
  http(): Agent;
  as(user: TestUser): {
    get(url: string): ReturnType<Agent['get']>;
    post(url: string): ReturnType<Agent['post']>;
    put(url: string): ReturnType<Agent['put']>;
    delete(url: string): ReturnType<Agent['delete']>;
  };
  /** The three providers at the SDK boundary, scripted per spec. */
  providers: {
    /** First of the e-mail chain (`ses`), then the fallback (`smtp`). */
    email: ScriptedProvider;
    emailFallback: ScriptedProvider;
    sms: ScriptedProvider;
    push: ScriptedProvider;
  };
  realtime: FakeRealtimeHub;
  /** A seeded user with a real session (access token signed by the production signer). */
  newUser(options?: {
    email?: string;
    role?: Role;
    /** The identity record has no e-mail address; `email` of the result is then empty. */
    withoutEmail?: boolean;
  }): Promise<TestUser>;
  /** A shop with the given users as OWNER members (and `staffIds` as STAFF), through the shared tenancy fixtures. */
  seedShop(
    ownerIds: string[],
    options?: { name?: string; staffIds?: string[] },
  ): Promise<{ shopId: string }>;
  /** Empties the stores, resets the clock, the providers and the hub double. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The real app the notifications specs run against: `NotificationsModule` (HTTP), `NotificationsWorkerModule`,
 * `NotificationsProjectorModule` and `TransactionalMailModule` next to the identity API, over real Postgres, Redis, the
 * wide-column store, the queue stand-in and the jobs table, with the production prefix, pipe, filter and the S50
 * limiter (`configureHttpApp`). Faked only at the system edges: the three providers (scripted), the realtime hub
 * transport and the clock. Users get real sessions; shops and memberships come from the shared tenancy fixtures, so no
 * spec injects `UserModel` or `ShopMembershipModel` (D-7).
 */
export async function createNotificationsApp(
  options: {
    /**
     * Boots `NotificationsWorkerModule` (the queue consumers). Default true. A spec that needs no worker leaves it out:
     * a consumer's last long poll is abandoned when its app closes, and the queue stand-in can hand the next message
     * of the next spec file to that dead poll (invisible for 60 s), so two worker-booting files in one jest run can
     * starve each other's first message.
     */
    workers?: boolean;
    extraImports?: unknown[];
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
    env?: Record<string, string>;
  } = {},
): Promise<NotificationsTestApp> {
  const env = options.env ?? {};
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);

  const clock = new TestClock();
  const providers = {
    email: new ScriptedProvider('ses', 'email'),
    emailFallback: new ScriptedProvider('smtp', 'email'),
    sms: new ScriptedProvider('twilio', 'sms'),
    push: new ScriptedProvider('fcm', 'push'),
  };
  const realtime = new FakeRealtimeHub();

  let app: INestApplication;
  try {
    const moduleRef = await generateTestingModule(
      [
        AuthApiModule,
        SeedsModule,
        TransactionalMailModule,
        NotificationsModule,
        ...(options.workers === false ? [] : [NotificationsWorkerModule]),
        NotificationsProjectorModule,
        ...(options.extraImports ?? []),
      ],
      {
        stores: ['redis', 'cassandra', 'sqs', 'dynamo'],
        customize: (builder) => {
          let b = builder
            .overrideProvider(CLOCK)
            .useValue(clock)
            .overrideProvider(RealtimePublisher)
            .useValue(realtime)
            .overrideProvider(EMAIL_PROVIDERS)
            .useValue([providers.email, providers.emailFallback])
            .overrideProvider(SMS_PROVIDERS)
            .useValue([providers.sms])
            .overrideProvider(PUSH_PROVIDERS)
            .useValue([providers.push]);
          for (const o of options.overrides ?? [])
            b = b.overrideProvider(o.provide).useValue(o.useValue);
          return b;
        },
      },
    );
    app = moduleRef.createNestApplication({ bufferLogs: false, rawBody: true });
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
  const http = () => supertest(app.getHttpServer());
  let counter = 0;

  return {
    app,
    clock,
    http,
    providers,
    realtime,
    as: (user) => ({
      get: (url) => http().get(url).set('Authorization', user.bearer),
      post: (url) => http().post(url).set('Authorization', user.bearer),
      put: (url) => http().put(url).set('Authorization', user.bearer),
      delete: (url) => http().delete(url).set('Authorization', user.bearer),
    }),
    async newUser(opts = {}) {
      const user = opts.withoutEmail
        ? {
            ...(await createUserWithoutEmail(app, { role: opts.role })),
            email: '',
          }
        : await createUser(app, {
            email: opts.email ?? `notif-${++counter}-${Date.now()}@example.com`,
            role: opts.role,
          });
      const session = await issueSession(app, { id: user.id, role: user.role });
      return {
        id: user.id,
        email: user.email,
        bearer: session.bearer,
        sessionId: session.sessionId,
      };
    },
    async seedShop(ownerIds, opts = {}) {
      const [first, ...rest] = ownerIds;
      const shop = await createShop(app, first ? { id: first } : null, {
        name: opts.name,
      });
      for (const id of rest)
        await addMember(app, shop.id, id, 'OWNER', 'invite');
      for (const id of opts.staffIds ?? [])
        await addMember(app, shop.id, id, 'STAFF', 'invite');
      return { shopId: shop.id };
    },
    async reset() {
      await seeds.clean();
      clock.reset();
      app.get(KeyStore).invalidate();
      for (const p of Object.values(providers)) p.reset();
      // The provider send budgets (token buckets, 14 e-mails a second) live in real time in Redis and in a local lease: what one
      // spec spends must not be missing in the next one (AS-49 sent 20 mails at once and found the bucket still drained).
      const limiter = app.get(RateLimiterService);
      for (const policy of [
        'notify.email', 'notify.sms', 'notify.push',
        'notify.email.marketing', 'notify.sms.marketing', 'notify.push.marketing',
      ] as const)
        for (const p of Object.values(providers)) await limiter.reset(policy, p.name);
      realtime.reset();
      if (options.workers !== false)
        for (const chain of Object.values(
          app.get<ProviderChains>(PROVIDER_CHAINS, { strict: false }),
        ))
          (chain as ChannelSender).reset();
    },
    close: () => app.close(),
  };
}
