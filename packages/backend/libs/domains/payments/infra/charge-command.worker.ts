import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { z } from 'zod';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import type { TaskMessage } from '@app/infrastructure/sqs/task-queue.port';
import { PaymentChargeService } from '../application/payment-charge.service';
import { CHARGE_QUEUE } from '../application/payment-intent.service';

export const chargeCommandSchema = z.object({
  paymentId: z.string().uuid(),
  attempt: z.number().int().nonnegative(),
});
export type ChargeCommand = z.infer<typeof chargeCommandSchema>;

/**
 * Consumer of the `payments-charge` queue (S13 US2). A body that is not `{paymentId, attempt}` goes to the dead-letter
 * queue without reaching `charge` (reason `SCHEMA_INVALID`); everything else is handed to the idempotent use case, which
 * acknowledges stale or repeated commands by doing nothing. Specs call `handle` directly; the queue consumer starts only
 * where a `TaskQueue` is provided (the processor and worker apps).
 */
@Injectable()
export class ChargeCommandWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ChargeCommandWorker.name);
  private stop: (() => Promise<void>) | null = null;
  private stopping = false;
  private inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly charges: PaymentChargeService,
    @Optional() private readonly queue?: TaskQueue,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.queue) return;
    this.stop = this.queue.consume<ChargeCommand>(
      CHARGE_QUEUE,
      (message) => this.handle(message),
      { concurrency: 20, bodySchema: chargeCommandSchema },
    );
  }

  async handle(
    message: Pick<TaskMessage<ChargeCommand>, 'body'>,
  ): Promise<void> {
    if (this.stopping) throw new Error('charge worker is shutting down');
    const parsed = chargeCommandSchema.safeParse(message.body);
    if (!parsed.success) {
      this.logger.warn('charge command with an invalid body ignored');
      return;
    }
    const run = this.charges.charge(parsed.data.paymentId, parsed.data.attempt);
    this.inFlight.add(run);
    try {
      await run;
    } finally {
      this.inFlight.delete(run);
    }
  }

  /** Stops taking commands, then lets the calls in flight finish (the provider call is bounded by its own timeout). */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.stop?.();
    await Promise.allSettled([...this.inFlight]);
  }
}
