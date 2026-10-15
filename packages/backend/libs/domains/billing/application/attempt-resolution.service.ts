import { Inject, Injectable, Logger } from '@nestjs/common';
import { fullJitterBackoff } from '@app/common/core/backoff';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { BILLING_LIMITS } from '../domain/config';
import {
  BILLING_GATEWAY,
  INVOICE_REPOSITORY,
  type BillingGateway,
  type InvoiceRepository,
} from '../domain/ports';
import type { LookupOutcome } from '../domain/charge-outcome';
import { AttemptSettlement, resolveJobKey } from './attempt-settlement.service';
import './billing.job-types';

/** Shortest wait between two lookups, whatever the jitter says. */
const MIN_DELAY_MS = 5_000;

/**
 * Settling an unknown attempt (S17 FR-033, AS-48 to AS-51): look the charge up by OUR reference. Found: the same
 * guarded step as a direct answer applies it. Not found: still unknown until 60 minutes after the attempt began, then
 * a definite failure `no_provider_record`. Provider unreachable: nothing changes and the next lookup is scheduled
 * with exponential backoff and full jitter (cap 15 minutes). A charge is never sent again for the attempt.
 */
@Injectable()
export class AttemptResolutionService {
  private readonly logger = new Logger(AttemptResolutionService.name);

  constructor(
    @Inject(INVOICE_REPOSITORY) private readonly invoices: InvoiceRepository,
    @Inject(BILLING_GATEWAY) private readonly gateway: BillingGateway,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly jobs: JobsService,
    private readonly settlement: AttemptSettlement,
  ) {}

  async resolve(
    invoiceId: string,
    attemptRef: string,
    round = 0,
    random: () => number = Math.random,
  ): Promise<void> {
    const now = this.clock.now();
    const invoice = await this.invoices.findById(invoiceId);
    // Settled meanwhile (or never claimed): nothing to resolve.
    if (
      !invoice ||
      invoice.attemptRef !== attemptRef ||
      !invoice.attemptStartedAt
    )
      return;
    const began = invoice.attemptStartedAt.getTime();

    if (!invoice.attemptUnknown) {
      // Still in flight in a live process: give it the time the call is allowed, then treat it as unknown.
      if (now.getTime() - began < BILLING_LIMITS.claimTimeoutMs) {
        await this.reschedule(
          invoiceId,
          attemptRef,
          round,
          new Date(began + BILLING_LIMITS.claimTimeoutMs),
        );
        return;
      }
      await this.settlement.unknown(invoice, attemptRef, 'stale_claim');
    }

    let found: LookupOutcome;
    try {
      found = await this.gateway.lookup(
        invoiceId,
        attemptRef,
        BILLING_LIMITS.lookupTimeoutMs,
      );
    } catch (error) {
      this.logger.warn(
        `lookup for invoice ${invoiceId} attempt ${attemptRef} failed: ${(error as Error).message}`,
      );
      await this.rescheduleWithBackoff(
        invoiceId,
        attemptRef,
        round,
        now,
        random,
      );
      return;
    }

    if (found.kind === 'found') {
      const outcome = found.outcome;
      if (outcome.kind === 'succeeded')
        await this.settlement.paid(invoice, attemptRef);
      else await this.settlement.failed(invoice, attemptRef, outcome.reason);
      return;
    }
    if (now.getTime() - began >= BILLING_LIMITS.unknownLimitMs) {
      await this.settlement.failed(invoice, attemptRef, 'no_provider_record');
      return;
    }
    await this.rescheduleWithBackoff(invoiceId, attemptRef, round, now, random);
  }

  private rescheduleWithBackoff(
    invoiceId: string,
    attemptRef: string,
    round: number,
    now: Date,
    random: () => number,
  ): Promise<void> {
    const delay = Math.max(
      MIN_DELAY_MS,
      fullJitterBackoff(
        round + 1,
        {
          baseMs: BILLING_LIMITS.firstResolutionDelayMs,
          maxMs: BILLING_LIMITS.resolutionBackoffCapMs,
        },
        random,
      ),
    );
    return this.reschedule(
      invoiceId,
      attemptRef,
      round,
      new Date(now.getTime() + delay),
    );
  }

  private async reschedule(
    invoiceId: string,
    attemptRef: string,
    round: number,
    runAt: Date,
  ): Promise<void> {
    await this.jobs.enqueue(
      'billing.resolve-attempt',
      { invoiceId, attempt: attemptRef, round: round + 1 },
      {
        runAt,
        idempotencyKey: resolveJobKey(invoiceId, attemptRef, round + 1),
      },
    );
  }
}
