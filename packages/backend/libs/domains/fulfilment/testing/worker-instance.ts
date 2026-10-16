import { Module, type INestApplication } from '@nestjs/common';
import { CLOCK, type FakeClock } from '@app/common/core/clock';
import { OrderFulfilmentService } from '@app/domains/orders';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { DeliveryOwnership } from '../application/delivery-ownership.service';
import { OrderLifecycleService } from '../application/order-lifecycle.service';
import { RecoveryService } from '../application/recovery.service';
import { SurgeService } from '../application/surge.service';
import { DeliveryCoreModule } from '../delivery-core.module';
import { ORDER_LIFECYCLE_PORT } from '../domain/delivery-ports';
import { DeliveryJobHandlers } from '../infra/delivery-job-handlers';
import { DeliveryQueueWorker } from '../infra/delivery-queue.worker';
import { OrderLifecycleAdapter } from '../infra/order-lifecycle.adapter';
import { RingHeartbeat } from '../infra/ring-heartbeat';
import type { FakeOrderFulfilment } from './fake-orders';

export interface WorkerInstance {
  app: INestApplication;
  instanceId: string;
  ownership: DeliveryOwnership;
  heartbeat: RingHeartbeat;
  worker: DeliveryQueueWorker;
  recovery: RecoveryService;
  surge: SurgeService;
  handlers: DeliveryJobHandlers;
  redis: RedisService;
  close(): Promise<void>;
}

/**
 * A second (third ...) `DeliveryWorkerModule`-shaped instance in this process, for the ownership specs: the same
 * providers as the worker (core services, ring heartbeat, timer consumer, job handlers) over the same Postgres and
 * Redis, with the orders capability replaced by the fake. It shares the spec's frozen clock. Its queue consumer is
 * stopped right after boot: the spec feeds `worker.handle(...)` by hand, so no real poll races the assertions.
 */
export async function startWorkerInstance(
  clock: FakeClock,
  fakeOrders: FakeOrderFulfilment,
): Promise<WorkerInstance> {
  @Module({
    imports: [DeliveryCoreModule],
    providers: [
      { provide: OrderFulfilmentService, useValue: fakeOrders },
      { provide: ORDER_LIFECYCLE_PORT, useClass: OrderLifecycleAdapter },
      OrderLifecycleService,
      RingHeartbeat,
      DeliveryQueueWorker,
      DeliveryJobHandlers,
    ],
  })
  class WorkerInstanceModule {}

  const moduleRef = await generateTestingModule([WorkerInstanceModule], {
    stores: ['redis', 'dynamo'],
    customize: (builder) => builder.overrideProvider(CLOCK).useValue(clock),
  });
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  await app.init();
  const worker = app.get(DeliveryQueueWorker);
  await worker.onModuleDestroy();
  const ownership = app.get(DeliveryOwnership);
  return {
    app,
    instanceId: ownership.instanceId,
    ownership,
    heartbeat: app.get(RingHeartbeat),
    worker,
    recovery: app.get(RecoveryService),
    surge: app.get(SurgeService),
    handlers: app.get(DeliveryJobHandlers),
    redis: app.get(RedisService),
    close: () => app.close(),
  };
}
