import { Injectable } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import type { PayoutJobsPort } from '../domain/payout-ports';

/** Enqueues the send job in the creation step's transaction, once per payout (`payout-send:<id>`), fair per shop. */
@Injectable()
export class JobsPayoutAdapter implements PayoutJobsPort {
  constructor(private readonly jobs: JobsService) {}

  async enqueueSend(
    payoutId: string,
    shopId: string,
    // The job service joins the active transaction (CLS); the parameter keeps the port explicit about it.
    _tx: Transaction,
  ): Promise<void> {
    await this.jobs.enqueue(
      'payouts.send',
      { payoutId },
      { idempotencyKey: `payout-send:${payoutId}`, shopId },
    );
  }
}
