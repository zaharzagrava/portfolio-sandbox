import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { PaymentCancellationService } from '../application/payment-cancellation.service';
import { PaymentChargeService } from '../application/payment-charge.service';
import { PaymentRefundService } from '../application/payment-refund.service';
import { PaymentResolutionService } from '../application/payment-resolution.service';

import '../application/payment.job-types';

/**
 * Job handlers of `payments` (S13 contracts/services.md). Each is idempotent by conditional state: a second run, or a
 * run on another instance, finds nothing left to do. The periodic sweep is scheduled at bootstrap.
 */
@Injectable()
export class PaymentJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentJobs.name);

  constructor(
    private readonly charges: PaymentChargeService,
    private readonly resolution: PaymentResolutionService,
    private readonly cancellation: PaymentCancellationService,
    private readonly refunds: PaymentRefundService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.jobs.upsertSchedule({
        name: 'payments.sweep-unknown',
        cron: '0 * * * * *',
        jobType: 'payments.sweep-unknown',
        payload: {},
      });
    } catch (error) {
      if (!(error instanceof InvalidScheduleError)) throw error;
      this.logger.error(`sweep schedule not registered: ${error.message}`);
    }
  }

  /** A charge retry scheduled after a "not sent" answer (open breaker, `429`, no connection). */
  @JobHandler('payments.charge', { concurrency: 20 })
  async charge({
    paymentId,
    attempt,
  }: {
    paymentId: string;
    attempt: number;
  }): Promise<void> {
    await this.charges.charge(paymentId, attempt);
  }

  /** One lookup of an `UNKNOWN` payment at the provider, by our reference. */
  @JobHandler('payments.resolve-unknown', { concurrency: 20 })
  async resolveUnknown({ paymentId }: { paymentId: string }): Promise<void> {
    await this.resolution.resolve(paymentId);
  }

  /** Cancels the provider's intent of a payment whose order was cancelled while the customer had not finished. */
  @JobHandler('payments.cancel-intent', { concurrency: 10 })
  async cancelIntent({ paymentId }: { paymentId: string }): Promise<void> {
    await this.cancellation.cancelIntent(paymentId);
  }

  /** Runs a refund, or one wait of a refund that is waiting for its payment to settle. */
  @JobHandler('payments.refund', { concurrency: 10 })
  async refund({ paymentId }: { paymentId: string }): Promise<void> {
    await this.refunds.execute(paymentId);
  }

  /** Backstop for lost resolution and refund jobs: one run in the fleet at a time. */
  @JobHandler('payments.sweep-unknown', {
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async sweepUnknown(): Promise<void> {
    await this.resolution.sweepDue();
    await this.refunds.sweepDue();
  }
}
