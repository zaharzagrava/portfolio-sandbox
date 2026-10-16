import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { z } from 'zod';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { OrderExportRunService } from '../application/order-export-run.service';
import { ORDER_EXPORTS_QUEUE } from './export-queue.adapter';

/** The message is the export id and nothing else: the old `{ kind: 'export', jobId }` shape is invalid (AS-44). */
export const exportMessageSchema = z.strictObject({
  exportId: z.string().uuid(),
});

/** How long shutdown waits for runs to release their exports. */
const SHUTDOWN_WAIT_MS = 15_000;

/**
 * The consumer of the `order-exports` queue (apps/worker). Concurrency, visibility timeout and heartbeat come from the
 * queue port; a body that is not `{exportId}` goes to the dead-letter queue with no side effect. Readiness fails while
 * the consumed queue (or its dead-letter queue) is not defined (L-002). On shutdown the consumer stops taking
 * messages, tells the runs to release their exports, and waits for them.
 */
@Injectable()
export class OrderExportConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly runs: OrderExportRunService,
    @Optional() readiness?: ReadinessService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    readiness?.register({
      name: `queue:${ORDER_EXPORTS_QUEUE}`,
      scope: 'pod',
      timeoutMs: 2_000,
      check: async () => {
        for (const name of [ORDER_EXPORTS_QUEUE, `${ORDER_EXPORTS_QUEUE}-dlq`])
          if (!(await this.queue.queueExists(name)))
            throw new Error(`queue ${name} is not defined`);
      },
    });
    shutdown?.register({
      name: 'order-export-consumer',
      order: 10,
      timeoutMs: SHUTDOWN_WAIT_MS + 2_000,
      run: () => this.shutdown(),
    });
  }

  onApplicationBootstrap(): void {
    this.runs.startHeartbeat();
    this.stop = this.queue.consume<{ exportId: string }>(
      ORDER_EXPORTS_QUEUE,
      async ({ body }) => {
        await this.runs.handle(body.exportId);
      },
      {
        concurrency: 2,
        visibilityTimeoutSec: 300,
        bodySchema: exportMessageSchema,
      },
    );
  }

  async shutdown(): Promise<void> {
    const stop = this.stop;
    this.stop = undefined;
    this.runs.shutdown();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      stop?.(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }
}
