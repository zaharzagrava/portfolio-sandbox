import {
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import type { TaskMessage } from '@app/infrastructure/sqs/task-queue.port';
import {
  refundMessageSchema,
  REFUND_QUEUE,
  RefundRequestService,
} from '../application/refund-request.service';

/**
 * Consumer of the `orders-refund-requested` queue (S13 US6). A body that is not a refund request goes to the queue's
 * dead-letter queue (reason `SCHEMA_INVALID`) before the service sees it; the semantic refusals (amount, currency,
 * reference, unknown payment, unsupported reason) are dead-lettered by the service with their own reason. Specs call
 * `handle` directly; the consumer starts only where a `TaskQueue` is provided.
 */
@Injectable()
export class RefundRequestWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private stop: (() => Promise<void>) | null = null;

  constructor(
    private readonly requests: RefundRequestService,
    @Optional() private readonly queue?: TaskQueue,
    @Optional() private readonly shutdown?: ShutdownRegistry,
  ) {}

  onApplicationBootstrap(): void {
    this.shutdown?.register({
      name: 'payments.refund-worker',
      order: 10,
      timeoutMs: 9_000,
      run: () => this.drain(),
    });
    if (!this.queue) return;
    this.stop = this.queue.consume(
      REFUND_QUEUE,
      (message) => this.handle(message),
      { concurrency: 10, bodySchema: refundMessageSchema },
    );
  }

  async handle(message: Pick<TaskMessage<unknown>, 'body'>): Promise<void> {
    await this.requests.handle(message.body);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
  }

  /** Stops taking refund requests; the queue consumer finishes the message it holds before `stop` returns. */
  private async drain(): Promise<void> {
    await this.stop?.();
  }
}
