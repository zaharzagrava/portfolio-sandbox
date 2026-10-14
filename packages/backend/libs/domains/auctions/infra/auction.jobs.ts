import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { NonRetryableJobError } from '@app/infrastructure/jobs/job-types';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import {
  auctionJobPayloadSchema,
  requestOrderPayloadSchema,
  type AuctionJobPayload,
  type RequestOrderPayload,
} from '../application/auction.job-types';
import { AuctionCloseService } from '../application/auction-close.service';
import { AuctionScheduleService } from '../application/auction-schedule.service';
import { SettlementService } from '../application/settlement.service';
import { BidPartitionService } from './bid-partitions.service';

/** `<n>` seconds as a six-field cron (seconds first, as the other periodic jobs). */
const everySeconds = (n: number) =>
  `*/${Math.max(1, Math.min(59, n))} * * * * *`;

/**
 * Job handlers of auctions (S21 contracts/services.md). Thin: parse the payload, make one application call. A malformed
 * payload or an unknown auction is a dead letter (`NonRetryableJobError`, no side effect, nothing published); a store or
 * upstream failure propagates and the job retries with backoff. Redelivery is harmless: every step is conditional.
 */
@Injectable()
export class AuctionJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuctionJobs.name);

  constructor(
    private readonly schedule: AuctionScheduleService,
    private readonly closing: AuctionCloseService,
    private readonly settlement: SettlementService,
    private readonly partitions: BidPartitionService,
    private readonly jobs: JobsService,
    private readonly config: ApiConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const schedules = [
      {
        name: 'auctions.sweep-due',
        cron: everySeconds(this.config.get('auctions_sweep_interval_s')),
      },
      // daily at 03:17 UTC, off the hour so it does not meet the other nightly jobs
      { name: 'auctions.ensure-bid-partitions', cron: '0 17 3 * * *' },
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

  private auctionId(payload: unknown): string {
    const parsed = auctionJobPayloadSchema.safeParse(payload);
    if (!parsed.success)
      throw new NonRetryableJobError('auction job payload is not valid');
    return parsed.data.auctionId;
  }

  private unknown(auctionId: string): never {
    throw new NonRetryableJobError(`auction ${auctionId} does not exist`);
  }

  /** At creation: the unit leaves regular stock. Up to 5 attempts; the sweeper repairs what is left. */
  @JobHandler('auctions.hold-stock', { leaseMs: 60_000, concurrency: 20 })
  async holdStock(payload: AuctionJobPayload): Promise<void> {
    const id = this.auctionId(payload);
    const outcome = await this.schedule.holdUnit(id);
    this.logger.log({
      event: 'auction.job',
      job: 'hold-stock',
      auctionId: id,
      outcome,
    });
    if (outcome === 'unknown') this.unknown(id);
  }

  /** At `startsAt`: `SCHEDULED → OPEN` once the unit is held. */
  @JobHandler('auctions.open', { leaseMs: 60_000, concurrency: 20 })
  async open(payload: AuctionJobPayload): Promise<void> {
    const id = this.auctionId(payload);
    const outcome = await this.schedule.open(id);
    this.logger.log({
      event: 'auction.job',
      job: 'open',
      auctionId: id,
      outcome,
    });
    if (outcome === 'unknown') this.unknown(id);
  }

  /** After `UNSOLD` or `CANCELLED`: the unit goes back exactly once. Up to 8 attempts, then dead letter and alert. */
  @JobHandler('auctions.return-stock', { leaseMs: 60_000, concurrency: 20 })
  async returnStock(payload: AuctionJobPayload): Promise<void> {
    const id = this.auctionId(payload);
    const outcome = await this.schedule.returnUnit(id);
    this.logger.log({
      event: 'auction.job',
      job: 'return-stock',
      auctionId: id,
      outcome,
    });
    if (outcome === 'unknown') this.unknown(id);
  }

  /** At `endsAt` (and at each moved end): the close is conditional on the stored end, so a stale job re-arms and stops. */
  @JobHandler('auctions.close', { leaseMs: 60_000, concurrency: 20 })
  async close(payload: AuctionJobPayload): Promise<void> {
    const id = this.auctionId(payload);
    const outcome = await this.closing.closeIfDue(id);
    this.logger.log({
      event: 'auction.job',
      job: 'close',
      auctionId: id,
      outcome,
    });
    if (outcome === 'unknown') this.unknown(id);
  }

  /** After `CLOSED` or `SECOND_CHANCE`: the order of the awardee is requested from `orders`, up to 8 attempts. */
  @JobHandler('auctions.request-order', { leaseMs: 90_000, concurrency: 20 })
  async requestOrder(
    payload: RequestOrderPayload,
    ctx?: { isLastAttempt: boolean },
  ): Promise<void> {
    const parsed = requestOrderPayloadSchema.safeParse(payload);
    if (!parsed.success)
      throw new NonRetryableJobError('auction order job payload is not valid');
    const { auctionId, step } = parsed.data;
    try {
      const outcome = await this.settlement.requestOrder(auctionId, step);
      this.logger.log({
        event: 'auction.job',
        job: 'request-order',
        auctionId,
        step,
        outcome,
      });
      if (outcome === 'unknown') this.unknown(auctionId);
    } catch (error) {
      if (!(error instanceof NonRetryableJobError))
        this.settlement.requestFailed(ctx?.isLastAttempt ?? false);
      throw error;
    }
  }

  /** Every 30 s: the safety net for lost jobs. One run in the fleet at a time. */
  @JobHandler('auctions.sweep-due', {
    leaseMs: 120_000,
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async sweepDue(): Promise<void> {
    const closed = await this.closing.sweepDue();
    const holds = await this.schedule.repairHolds();
    const returns = await this.schedule.repairReturns();
    const opened = await this.schedule.openDue();
    const orders = await this.settlement.repairOrders();
    this.logger.log({
      event: 'auction.job',
      job: 'sweep-due',
      closed,
      holds,
      returns,
      opened,
      orders,
    });
  }

  /** Daily: the current month and the next 3 exist; the default partition is counted. */
  @JobHandler('auctions.ensure-bid-partitions', {
    leaseMs: 60_000,
    concurrency: 1,
    fleetConcurrency: 1,
  })
  async ensureBidPartitions(): Promise<void> {
    const { defaultRows } = await this.partitions.ensure();
    this.logger.log({
      event: 'auction.job',
      job: 'ensure-bid-partitions',
      defaultRows,
    });
  }
}
