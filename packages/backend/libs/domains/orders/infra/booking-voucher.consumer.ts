import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { bookingVoucherRequestedSchema } from '@marketplace-sandbox/contracts';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { ConsumerPauseFlags } from '@app/infrastructure/projections/consumer-pause';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { VoucherService } from '../application/voucher.service';

/** The queue the booking confirmation writes its voucher command to (S22 emits, `elasticmq.conf` defines it and its DLQ). */
export const BOOKING_VOUCHER_QUEUE = 'orders-booking-voucher-requested';

/** The operator name of this consumer in the control surface (S53, J03 G-42): pause, resume, `state`, `lag`. */
export const BOOKING_VOUCHER_GROUP = 'orders-booking-voucher';

/**
 * Consumer `orders-booking-voucher` (J03 G-04, apps/worker and the local monolith): one voucher per confirmed hold. The
 * command is idempotent on `booking-voucher:<holdId>` (UNIQUE `holdId`, redelivery is a no-op); a body that is not a valid
 * command goes to the dead-letter queue with no side effect (`bodySchema`). While the operator holds the group the
 * consumer takes nothing off the queue. Readiness fails while the queue or its DLQ is not defined (L-002).
 */
@Injectable()
export class BookingVoucherConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BookingVoucherConsumer.name);
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly vouchers: VoucherService,
    private readonly flags: ConsumerPauseFlags,
    @Optional() readiness?: ReadinessService,
  ) {
    readiness?.register({
      name: `queue:${BOOKING_VOUCHER_QUEUE}`,
      scope: 'pod',
      timeoutMs: 2_000,
      check: async () => {
        for (const name of [
          BOOKING_VOUCHER_QUEUE,
          `${BOOKING_VOUCHER_QUEUE}-dlq`,
        ])
          if (!(await this.queue.queueExists(name)))
            throw new Error(`queue ${name} is not defined`);
      },
    });
  }

  onApplicationBootstrap(): void {
    this.stop = this.queue.consume(
      BOOKING_VOUCHER_QUEUE,
      async ({ body }) => {
        await this.vouchers.issue(bookingVoucherRequestedSchema.parse(body));
      },
      {
        concurrency: 4,
        bodySchema: bookingVoucherRequestedSchema,
        isPaused: () => this.flags.isPaused([BOOKING_VOUCHER_GROUP]),
      },
    );
    this.logger.log(`consuming ${BOOKING_VOUCHER_QUEUE}`);
  }

  async onModuleDestroy(): Promise<void> {
    const stop = this.stop;
    this.stop = undefined;
    await stop?.();
  }
}
