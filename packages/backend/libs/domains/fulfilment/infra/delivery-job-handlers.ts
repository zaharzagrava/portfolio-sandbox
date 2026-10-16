import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import {
  NonRetryableJobError,
  type JobContext,
} from '@app/infrastructure/jobs/job-types';
import { errorText, logDelivery } from '../application/delivery-log';
import { DeliveryOwnership } from '../application/delivery-ownership.service';
import {
  COURIER_REPOSITORY,
  type CourierRepository,
} from '../domain/delivery-ports';
import { OrderLifecycleService } from '../application/order-lifecycle.service';
import { SurgeService } from '../application/surge.service';
import { RecoveryService } from '../application/recovery.service';
import { DeliveryMetrics } from '../application/delivery-metrics';
import {
  APPLY_ORDER_LIFECYCLE_JOB,
  COMPUTE_SURGE_JOB,
  RECOVER_DELIVERIES_JOB,
  upsertDeliverySchedules,
  type OwnerScope,
} from './delivery-jobs';

/**
 * The job handlers of the delivery capability that are loaded in `apps/worker` (S20 T046, T052). Each is idempotent by
 * conditional state, so a second run, a retry or a run on another instance finds nothing left to do.
 */
@Injectable()
export class DeliveryJobHandlers implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeliveryJobHandlers.name);

  constructor(
    private readonly recovery: RecoveryService,
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    private readonly surge: SurgeService,
    private readonly orderLifecycle: OrderLifecycleService,
    private readonly ownership: DeliveryOwnership,
    private readonly jobs: JobsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const failures = await upsertDeliverySchedules(this.jobs, [
      RECOVER_DELIVERIES_JOB,
      COMPUTE_SURGE_JOB,
    ]);
    for (const failure of failures)
      logDelivery(this.logger, 'error', 'dispatcher.schedule_not_registered', {
        error: errorText(failure),
      });
    // The draft surge schedule (`delivery.compute-surge`) has no handler any more.
    await this.jobs.removeSchedule('delivery.compute-surge').catch(() => false);
  }

  /**
   * Every 15 s, one run in the fleet (FR-018, FR-043): the scheduled tick covers the cities this instance owns and the
   * work that belongs to no city, then hands every other live instance its cities as a follow-up job (`for`).
   */
  @JobHandler(RECOVER_DELIVERIES_JOB, { concurrency: 1 })
  async recover(
    payload: OwnerScope = {},
    ctx?: Pick<JobContext, 'jobId'>,
  ): Promise<void> {
    const now = this.clock.now();
    if (payload.for) {
      await this.recovery.recoverCities(now, await this.citiesOf(payload.for));
      return;
    }
    await this.recovery.recoverOverdue(now);
    await this.fanOut(RECOVER_DELIVERIES_JOB, ctx);
  }

  /** Every 60 s, once per tick (job-table claim): surge per cell for the owned cities, then the others' follow-ups. */
  @JobHandler(COMPUTE_SURGE_JOB, { concurrency: 1 })
  async computeSurge(
    payload: OwnerScope = {},
    ctx?: Pick<JobContext, 'jobId'>,
  ): Promise<void> {
    const now = this.clock.now();
    if (payload.for) {
      await this.surge.compute(now, await this.citiesOf(payload.for));
      return;
    }
    await this.surge.compute(now);
    await this.fanOut(COMPUTE_SURGE_JOB, ctx);
  }

  /** The cities of another instance; none when the ring is gone (the claiming instance then covered every city). */
  private async citiesOf(instanceId: string): Promise<string[]> {
    return (
      (await this.ownership.ownedCities(
        await this.couriers.listCities(),
        instanceId,
      )) ?? []
    );
  }

  private async fanOut(
    type: typeof RECOVER_DELIVERIES_JOB | typeof COMPUTE_SURGE_JOB,
    ctx?: Pick<JobContext, 'jobId'>,
  ): Promise<void> {
    if (!ctx) return;
    for (const peer of await this.ownership.peers()) {
      try {
        await this.jobs.enqueue(
          type,
          { for: peer },
          { idempotencyKey: `${type}:${ctx.jobId}:${peer}` },
        );
      } catch (error) {
        logDelivery(this.logger, 'warn', 'dispatcher.follow_up_not_queued', {
          step: type,
          error: errorText(error),
        });
      }
    }
  }

  /**
   * Tells the order about a milestone. A transient failure rethrows (the job framework retries with exponential backoff
   * and full jitter, at most 8 attempts); a final refusal is dead-lettered with its reason.
   */
  @JobHandler(APPLY_ORDER_LIFECYCLE_JOB, { concurrency: 20 })
  async applyOrderLifecycle(
    payload: {
      deliveryId: string;
      status: 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED';
    },
    ctx: Pick<JobContext, 'isLastAttempt'>,
  ): Promise<void> {
    try {
      await this.orderLifecycle.apply(payload.deliveryId, payload.status);
    } catch (error) {
      if (error instanceof NonRetryableJobError) throw error;
      DeliveryMetrics.orderWriteBack.add(1, {
        result: ctx.isLastAttempt ? 'dead_lettered' : 'retried',
      });
      throw error;
    }
  }
}
