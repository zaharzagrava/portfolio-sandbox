import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  TaskQueue,
  type TaskMessage,
} from '@app/infrastructure/sqs/task-queue.port';
import {
  SyncEngineService,
  type DeliverySignal,
} from '../../application/sync-engine.service';
import {
  syncMessageSchema,
  type SyncMessage,
  type SyncQueueName,
} from '../../domain/ports';

/**
 * Base of the two queue consumers. The strict message schema is the queue's `bodySchema`, so a malformed body (bad UUID,
 * unknown kind, extra field, empty `externalId`, or a kind that belongs to the other queue) goes straight to the
 * dead-letter queue without calling the engine (AS-25). The engine acknowledges messages for unknown, paused or
 * disconnected integrations; any error it throws leaves the message for redelivery until the queue's receive limit.
 */
@Injectable()
export abstract class SyncQueueConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  protected readonly logger = new Logger(this.constructor.name);
  private stop?: () => Promise<void>;

  protected abstract readonly queueName: SyncQueueName;
  protected abstract readonly kinds: readonly SyncMessage['kind'][];
  protected abstract readonly concurrency: number;
  protected abstract readonly visibilityTimeoutSec: number;

  constructor(
    private readonly queue: TaskQueue,
    private readonly engine: SyncEngineService,
  ) {}

  private get bodySchema() {
    return syncMessageSchema.refine((m) => this.kinds.includes(m.kind));
  }

  onApplicationBootstrap(): void {
    this.stop = this.queue.consume<unknown>(
      this.queueName,
      (message) => this.handle(message),
      {
        concurrency: this.concurrency,
        visibilityTimeoutSec: this.visibilityTimeoutSec,
        bodySchema: this.bodySchema,
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop?.();
  }

  /** One delivery. Public so the specs drive the real consumer without a queue. */
  async handle(message: Pick<TaskMessage<unknown>, 'body'>): Promise<void> {
    const parsed = this.bodySchema.safeParse(message.body);
    if (!parsed.success) throw new Error('invalid sync message');
    const delivery: DeliverySignal = { retry: false };
    await this.engine.handle(parsed.data, delivery);
    // The provider could not be reached: leave the message for redelivery (the run is recorded `failed`, the lease is released).
    if (delivery.retry)
      throw new Error('provider unreachable; message returned to the queue');
  }
}
