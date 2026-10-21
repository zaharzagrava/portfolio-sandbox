import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OrderExportWorkerModule } from '@app/domains/orders';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { WorkerModule } from './worker.module';

const QUEUE = 'order-exports';

const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condition not met within ${ms} ms`);
};

// The readiness service keeps its answer for 2 s. Dropping that kept answer before each look makes every change show at
// once, so the test still proves "the check follows the queue" without waiting for the 2 s to pass after each change.
const freshReport = (readiness: ReadinessService) => {
  (readiness as unknown as { cached?: unknown }).cached = undefined;
  return readiness.report();
};

/**
 * The real worker application (S12 L-004, L-015, L-018, L-002): `WorkerModule` starts with `OrderExportWorkerModule` in
 * it, the three jobs are declared with a strict contract, and the pod is not ready while the queue it consumes (or its
 * dead-letter queue) is missing.
 */
describe('Order export wiring in the real worker application', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(WorkerModule, { logger: false });
    configureHttpApp(app, {
      useStructuredLogger: false,
      processHandlers: false,
    });
    await app.listen(0, '127.0.0.1');
  }, 120_000);
  afterAll(() => app?.close());

  it('S12 T082: the started worker declares recovery, expiry and purge with strict empty contracts', () => {
    for (const name of [
      'orders.recover-stalled-exports',
      'orders.expire-exports',
      'orders.purge-exports',
    ]) {
      const declaration = getJobTypeDeclaration(name as never);
      expect(declaration?.contract.safeParse({}).success).toBe(true);
      expect(declaration?.contract.safeParse({ shopId: 'x' }).success).toBe(
        false,
      );
    }
  });

  it('S12 T082: the export consumer, the jobs and the tenancy consumers are providers of the module the worker imports', () => {
    const providers = Reflect.getMetadata(
      'providers',
      OrderExportWorkerModule,
    ) as Array<{ name?: string }>;
    expect(providers.map((p) => p.name)).toEqual(
      expect.arrayContaining(['OrderExportConsumer', 'OrderExportJobs']),
    );
    const imports = Reflect.getMetadata('imports', WorkerModule) as unknown[];
    expect(imports).toContain(OrderExportWorkerModule);
  });

  it('S12 AS-01: the worker is ready while the export queue and its dead-letter queue exist and not ready while one is missing (L-002)', async () => {
    const readiness = app.get(ReadinessService);
    const check = `queue:${QUEUE}`;
    await until(async () => (await freshReport(readiness)).checks[check] === 'up');
    const queue = app.get(TaskQueue);
    for (const missing of [QUEUE, `${QUEUE}-dlq`]) {
      const exists = jest
        .spyOn(queue, 'queueExists')
        .mockImplementation((name) => Promise.resolve(name !== missing));
      try {
        await until(async () => {
          const report = await freshReport(readiness);
          return report.checks[check] === 'down' && !report.ready;
        });
      } finally {
        exists.mockRestore();
      }
      await until(
        async () => (await freshReport(readiness)).checks[check] === 'up',
      );
    }
  });
});
