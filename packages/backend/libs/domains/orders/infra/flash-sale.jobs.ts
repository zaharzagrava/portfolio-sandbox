import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { z } from 'zod';
import { ApiConfigService } from '@app/common/config';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { NonRetryableJobError } from '@app/infrastructure/jobs/job-types';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { FlashLifecycleService } from '../application/flash-lifecycle.service';
import { flashSpan } from '../application/flash-tracing';

import '../application/order.job-types';

const payloadSchema = z.object({ saleId: z.string().uuid() });

/** `<n>` seconds as a six-field cron (seconds first, as the other periodic jobs of the domain). */
const everySeconds = (n: number) =>
  `*/${Math.max(1, Math.min(59, n))} * * * * *`;

/**
 * Job handlers of flash sales (S11 contracts/services.md). Thin: parse the payload, make one lifecycle call. A
 * malformed payload or an unknown sale is a dead letter (`NonRetryableJobError`, no side effect); a store or catalog
 * failure propagates, and the job retries with backoff. Redelivery is harmless: every step is conditional.
 */
@Injectable()
export class FlashSaleJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(FlashSaleJobs.name);

  constructor(
    private readonly lifecycle: FlashLifecycleService,
    private readonly jobs: JobsService,
    private readonly config: ApiConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const schedules = [
      {
        name: 'flash-sale.verify',
        cron: everySeconds(
          this.config.get('orders_flash_verify_interval_seconds'),
        ),
      },
      {
        name: 'flash-sale.sweep-claims',
        cron: everySeconds(
          this.config.get('orders_flash_sweep_interval_seconds'),
        ),
      },
    ] as const;
    for (const s of schedules) {
      try {
        await this.jobs.upsertSchedule({
          name: s.name,
          cron: s.cron,
          jobType: s.name,
          payload: {},
          overlap: 'skip',
        });
      } catch (error) {
        if (!(error instanceof InvalidScheduleError)) throw error;
        this.logger.error(
          `schedule ${s.name} not registered: ${error.message}`,
        );
      }
    }
  }

  private saleId(payload: unknown): string {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success)
      throw new NonRetryableJobError('flash sale job payload is not valid');
    return parsed.data.saleId;
  }

  private unknown(saleId: string): never {
    throw new NonRetryableJobError(`flash sale ${saleId} does not exist`);
  }

  /** `startsAt − 60 s`: stock out of the catalog, units into the buckets, `LOADED`. Up to 8 attempts. */
  @JobHandler('flash-sale.load', { leaseMs: 60_000, concurrency: 20 })
  async load(payload: { saleId: string }): Promise<void> {
    const id = this.saleId(payload);
    const outcome = await flashSpan('flash.job.load', { saleId: id }, () =>
      this.lifecycle.load(id),
    );
    this.logger.log({ event: 'flash.job', job: 'load', saleId: id, outcome });
    if (outcome === 'unknown') this.unknown(id);
  }

  /** The pre-S11 name of `flash-sale.load`: jobs enqueued by the old route drain through it for one release. */
  @JobHandler('flash-sale.start', { leaseMs: 60_000, concurrency: 20 })
  async start(payload: { saleId: string }): Promise<void> {
    await this.load(payload);
  }

  /** `endsAt`: `LOADED → ENDED` and the reconcile job. */
  @JobHandler('flash-sale.end', { leaseMs: 60_000, concurrency: 20 })
  async end(payload: { saleId: string }): Promise<void> {
    const id = this.saleId(payload);
    const outcome = await flashSpan('flash.job.end', { saleId: id }, () =>
      this.lifecycle.end(id),
    );
    this.logger.log({ event: 'flash.job', job: 'end', saleId: id, outcome });
    if (outcome === 'unknown') this.unknown(id);
  }

  /** After the hold window: leftover units back to regular stock exactly once; waits (and re-enqueues itself) for holds. */
  @JobHandler('flash-sale.reconcile', { leaseMs: 120_000, concurrency: 10 })
  async reconcile(payload: { saleId: string }): Promise<void> {
    const id = this.saleId(payload);
    const outcome = await flashSpan('flash.job.reconcile', { saleId: id }, () =>
      this.lifecycle.reconcile(id),
    );
    this.logger.log({
      event: 'flash.job',
      job: 'reconcile',
      saleId: id,
      outcome,
    });
    if (outcome === 'unknown') this.unknown(id);
  }

  /** Every 30 s: clamp phantom stock, stop and remediate an oversell. One run in the fleet at a time. */
  @JobHandler('flash-sale.verify', {
    leaseMs: 60_000,
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async verify(): Promise<void> {
    await flashSpan('flash.job.verify', {}, () => this.lifecycle.verify());
  }

  /** Every 10 s: give back abandoned claims (≤ 200 per sale per run). One run in the fleet at a time. */
  @JobHandler('flash-sale.sweep-claims', {
    leaseMs: 60_000,
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async sweepClaims(): Promise<void> {
    await flashSpan('flash.job.sweep-claims', {}, () =>
      this.lifecycle.sweepClaims(),
    );
  }
}
