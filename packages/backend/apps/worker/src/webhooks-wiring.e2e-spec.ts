import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WebhooksWorkerModule } from '@app/domains/developer-platform';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { getJobTypeDeclaration } from '@app/infrastructure/jobs/job-type-registry';
import { configureHttpApp } from '@app/infrastructure/platform';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { WorkerModule } from './worker.module';

const QUEUE = 'webhook-deliveries.fifo';

const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condition not met within ${ms} ms`);
};

/**
 * The real worker application (S43 L-004, L-015, L-018, L-002): `WorkerModule` starts with `WebhooksWorkerModule` in it,
 * the retry job is declared with a strict contract, the delivery consumer is a provider of the module that starts, and the
 * pod is not ready while the FIFO queue it consumes (or its dead-letter queue) is missing.
 */
describe('Webhooks wiring in the real worker application', () => {
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

  it('S43 AS-46: the started worker declares the retry job with a strict contract', () => {
    const declaration = getJobTypeDeclaration('webhooks.retry' as never);
    const message = {
      endpointId: 'e',
      eventId: 'evt_1',
      deliveryId: 'd',
      kind: 'event',
      attempt: 4,
    };
    expect(declaration?.contract.safeParse(message).success).toBe(true);
    expect(
      declaration?.contract.safeParse({ ...message, body: '{}' }).success,
    ).toBe(false);
    expect(
      declaration?.contract.safeParse({ ...message, type: 'order.paid' })
        .success,
    ).toBe(false);
  });

  it('S43 AS-54: the delivery consumer is a provider of a module the worker imports', () => {
    const providers = Reflect.getMetadata(
      'providers',
      WebhooksWorkerModule,
    ) as Array<{ name?: string }>;
    expect(providers.map((p) => p.name)).toContain('WebhookWorkers');
    const imports = Reflect.getMetadata('imports', WorkerModule) as unknown[];
    expect(imports).toContain(WebhooksWorkerModule);
  });

  it('S43 AS-46: the worker is ready while the delivery queue and its dead-letter queue exist and not ready while one is missing (L-002)', async () => {
    const readiness = app.get(ReadinessService);
    const check = `queue:${QUEUE}`;
    await until(async () => (await readiness.report()).checks[check] === 'up');
    const queue = app.get(TaskQueue);
    for (const missing of [QUEUE, 'webhook-deliveries-dlq.fifo']) {
      const exists = jest
        .spyOn(queue, 'queueExists')
        .mockImplementation((name) => Promise.resolve(name !== missing));
      try {
        await until(async () => {
          const report = await readiness.report();
          return report.checks[check] === 'down' && !report.ready;
        });
      } finally {
        exists.mockRestore();
      }
      await until(
        async () => (await readiness.report()).checks[check] === 'up',
      );
    }
  });
});
