import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  CatalogImportService,
  IMPORT_QUEUE,
  ShopBusyError,
} from '../application/catalog-import.service';

/**
 * apps/worker consumer for imports. The queue's visibility is
 * extended by the consumer heartbeat while a long import runs; on shutdown
 * the AbortController stops at the next row and the checkpoint lets the
 * redelivered message resume.
 */
@Injectable()
export class CatalogImportWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CatalogImportWorker.name);
  private readonly shutdown = new AbortController();
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly imports: CatalogImportService,
  ) {}

  onApplicationBootstrap() {
    this.stop = this.queue.consume<{ kind: 'import'; jobId: string }>(
      IMPORT_QUEUE,
      async ({ body }) => {
        try {
          await this.imports.process(body.jobId, this.shutdown.signal);
        } catch (error) {
          if (error instanceof ShopBusyError) {
            // Fairness: this shop already has an import running - try again in a minute instead of hogging a worker slot.
            await this.queue.enqueue(IMPORT_QUEUE, body, { delaySeconds: 60 });
            return;
          }
          throw error;
        }
      },
      { concurrency: 4, visibilityTimeoutSec: 300 },
    );
  }

  async onModuleDestroy() {
    this.shutdown.abort();
    await this.stop?.();
  }
}
