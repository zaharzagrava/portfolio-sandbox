import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { importMessageSchema } from '@marketplace-sandbox/contracts';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  ImportRunnerService,
  type ImportRunOutcome,
} from '../application/import-runner.service';
import { IMPORT_CONFIG, type ImportConfig } from '../domain/import-limits';
import { IMPORT_QUEUE, type ImportQueuePort } from '../domain/ports';
import { CATALOG_IMPORTS_QUEUE } from './import-queue.adapter';

/** How long shutdown waits for runs to stop at a consistent point. */
const SHUTDOWN_WAIT_MS = 15_000;
const MAX_DELAY_SECONDS = 900;

/**
 * The consumer of the `catalog-imports` queue (apps/worker). A body that is not `{importId}` goes to the dead-letter
 * queue with no side effect (the queue port validates it). A job whose shop is running another import, or has an
 * earlier one pending, is handed back as a fresh message with a delay of 60 seconds plus or minus 20 percent: the
 * original is acknowledged, so the hand-back does not spend the three-delivery budget (AS-60). Readiness fails while
 * the consumed queue (or its dead-letter queue) is not defined (L-002).
 */
@Injectable()
export class ImportConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ImportConsumer.name);
  private stop?: () => Promise<void>;
  /** Replaceable in tests to make the jitter deterministic. */
  random: () => number = Math.random;

  constructor(
    private readonly queue: TaskQueue,
    private readonly runner: ImportRunnerService,
    @Inject(IMPORT_QUEUE) private readonly outgoing: ImportQueuePort,
    @Inject(IMPORT_CONFIG) private readonly config: ImportConfig,
    @Optional() readiness?: ReadinessService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    readiness?.register({
      name: `queue:${CATALOG_IMPORTS_QUEUE}`,
      scope: 'pod',
      timeoutMs: 2_000,
      check: async () => {
        for (const name of [
          CATALOG_IMPORTS_QUEUE,
          `${CATALOG_IMPORTS_QUEUE}-dlq`,
        ])
          if (!(await this.queue.queueExists(name)))
            throw new Error(`queue ${name} is not defined`);
      },
    });
    shutdown?.register({
      name: 'catalog-import-consumer',
      order: 10,
      timeoutMs: SHUTDOWN_WAIT_MS + 2_000,
      run: () => this.shutdown(),
    });
  }

  onApplicationBootstrap(): void {
    this.stop = this.queue.consume<{ importId: string }>(
      CATALOG_IMPORTS_QUEUE,
      async ({ body, id, receiveCount }) => {
        await this.process(body.importId, receiveCount, id);
      },
      {
        concurrency: 4,
        visibilityTimeoutSec: 300,
        bodySchema: importMessageSchema,
      },
    );
  }

  /** One delivery. Throws to have the queue redeliver; otherwise the message is acknowledged. */
  async process(
    importId: string,
    receiveCount: number,
    messageId?: string,
  ): Promise<ImportRunOutcome> {
    let outcome: ImportRunOutcome;
    try {
      outcome = await this.runner.handle(importId, receiveCount);
    } catch (error) {
      // one structured line per failed delivery, with the message id and no payload (AS-41)
      this.logger.warn({
        action: 'import.delivery_rejected',
        importId,
        messageId,
        receiveCount,
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }
    if (outcome === 'busy') {
      const delay = this.busyDelay();
      await this.outgoing.enqueue(importId, { delaySeconds: delay });
      this.logger.log({
        action: 'import.handed_back',
        importId,
        messageId,
        delaySeconds: delay,
      });
    }
    return outcome;
  }

  /** `busyDelaySeconds` plus or minus 20 percent, an integer within the queue's limits. */
  private busyDelay(): number {
    const base = this.config.busyDelaySeconds;
    const jittered = Math.round(base * (0.8 + 0.4 * this.random()));
    return Math.min(MAX_DELAY_SECONDS, Math.max(1, jittered));
  }

  async shutdown(): Promise<void> {
    const stop = this.stop;
    this.stop = undefined;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      (async () => {
        await this.runner.shutdown();
        await stop?.();
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }
}
