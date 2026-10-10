import { Global, Module, type INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import { PaymentModule } from '../payment.module';
import { PaymentProcessingModule } from '../payment-processor.module';
import { PaymentsCoreModule } from '../payments-core.module';
import { OrdersEventsConsumer } from '../infra/orders-events.consumer';
import { PAYMENT_PROVIDER } from '../domain/ports';
import {
  PROVIDER_TRANSPORT,
  StripePaymentProvider,
} from '../infra/stripe-payment-provider.adapter';
import { FakeProviderTransport } from './fake-payment-provider';

/** The orders consumer without the Kafka framework: specs call `project` directly (as the other domains' consumer specs do). */
@Module({
  imports: [PaymentsCoreModule],
  providers: [OrdersEventsConsumer],
  exports: [OrdersEventsConsumer],
})
class OrdersConsumerProbeModule {}

/** The queue the charge worker consumes from: in memory, so a spec delivers (and loses, and repeats) commands by hand. */
@Global()
@Module({
  providers: [{ provide: TaskQueue, useClass: InMemoryTaskQueue }],
  exports: [TaskQueue],
})
class InMemoryQueueModule {}

/** The secrets the kit boots the app with. */
export const KIT_PAYMENTS_CURSOR_SECRET =
  'payments-kit-cursor-secret-0123456789abcdef-xyz';

/** The realtime hub's transport: records publishes, or refuses them while `down`. */
export class FakeRealtimePublisher {
  readonly published: Array<{ topic: string; type: string; data: unknown }> =
    [];
  down = false;

  publish(topic: string, type: string, data: unknown): Promise<string> {
    if (this.down) return Promise.reject(new Error('realtime hub is down'));
    this.published.push({ topic, type, data });
    return Promise.resolve('0-0');
  }

  reset(): void {
    this.published.length = 0;
    this.down = false;
  }
}

type AnyFn = (...args: never[]) => unknown;

export interface PaymentsTestApp extends CatalogTestApp {
  /** The provider's SDK as a scripted double (below the adapter: breakers, limits and classification run for real). */
  provider: FakeProviderTransport;
  realtime: FakeRealtimePublisher;
  queue: InMemoryTaskQueue;
  /**
   * Replaces `target[method]` with `wrapper(original)` until `reset()` or the returned `restore()`: the fault gates of
   * the plan (a latch inside the insert, a refused ledger write) are installed this way on the real adapters.
   */
  patch<T extends object, K extends keyof T>(
    target: T,
    method: K,
    wrapper: (original: T[K] extends AnyFn ? T[K] : never) => T[K],
  ): () => void;
}

/**
 * The real app the payments specs run against: `PaymentModule` (HTTP) and `PaymentProcessingModule` (charge worker and
 * job handlers, called directly by the specs) next to the identity API, over real Postgres, Redis, the outbox and the
 * jobs table, with the production prefix, pipe, filter and the S50 limiter. Faked only at the system edges: the
 * provider's SDK, the realtime transport, the queue and the clock (S13 test-plan.md).
 */
export async function createPaymentsApp(
  options: {
    extraImports?: unknown[];
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
    env?: Record<string, string>;
    redisUrl?: string;
  } = {},
): Promise<PaymentsTestApp> {
  // The app creates its clock; the provider double is built first and reads the clock through this holder.
  const clockRef: { current?: { now(): Date; advance(ms: number): void } } = {};
  const provider = new FakeProviderTransport({
    now: () => clockRef.current!.now(),
    advance: (ms) => clockRef.current!.advance(ms),
  });
  const realtime = new FakeRealtimePublisher();
  const queue = new InMemoryTaskQueue();

  const base = await createCatalogApp({
    redisUrl: options.redisUrl,
    extraImports: [
      InMemoryQueueModule,
      JobsModule,
      PaymentModule,
      PaymentProcessingModule,
      OrdersConsumerProbeModule,
      ...(options.extraImports ?? []),
    ],
    overrides: [
      { provide: PROVIDER_TRANSPORT, useValue: provider },
      { provide: RealtimePublisher, useValue: realtime },
      // wins over a real `SqsModule` a spec brings (the outbox relay): no spec talks to SQS
      { provide: TaskQueue, useValue: queue },
      ...(options.overrides ?? []),
    ],
    env: {
      PAYMENTS_CURSOR_SECRET: KIT_PAYMENTS_CURSOR_SECRET,
      ...options.env,
    },
  });
  clockRef.current = base.clock;

  const restores: Array<() => void> = [];
  const patch: PaymentsTestApp['patch'] = (target, method, wrapper) => {
    const original = target[method];
    target[method] = wrapper(
      (typeof original === 'function'
        ? (original as AnyFn).bind(target)
        : original) as never,
    );
    const restore = () => {
      target[method] = original;
    };
    restores.push(restore);
    return restore;
  };

  return {
    ...base,
    provider,
    realtime,
    queue,
    patch,
    async reset() {
      while (restores.length) restores.pop()!();
      provider.reset();
      realtime.reset();
      queue.sent.length = 0;
      queue.deadLettered.length = 0;
      (
        base.app.get(PAYMENT_PROVIDER, {
          strict: false,
        }) as StripePaymentProvider
      ).resetBreakers();
      await base.reset();
    },
  };
}

/** One row set of a table, for assertions on persisted state (test code may read every table, IX.6). */
export async function rows<T extends object>(
  app: INestApplication,
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return app
    .get(Sequelize)
    .query<T>(sql, { type: QueryTypes.SELECT, replacements });
}

/** A statement that changes test data. */
export async function exec(
  app: INestApplication,
  sql: string,
  replacements: Record<string, unknown> = {},
): Promise<void> {
  await app.get(Sequelize).query(sql, { replacements });
}
