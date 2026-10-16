import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import type { JobsService } from '@app/infrastructure/jobs/jobs.service';
import {
  ORDER_LIFECYCLE_JOB,
  orderLifecycleJobKey,
} from '../domain/dispatch-rules';

/**
 * The scheduled tick has no payload: it runs once for the fleet on the instance that claims it and covers the cities that
 * instance owns. It then queues one follow-up per other live instance with `for` = that instance's id, run by whoever
 * claims it, so every city is covered once per tick (S20 FR-043).
 */
export interface OwnerScope {
  for?: string;
}
const ownerScopeContract = z.object({
  for: z.string().min(1).max(100).optional(),
});

// Declarations first, handlers later in this file (T046 recovery, T052 write-back, T068 surge): an app that only
// enqueues loads the declarations without the worker code (S49 follow-up: `declareJobType` next to the augmentation).
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    /** Every 60 s: surge per geohash cell for the cities this instance owns. */
    'fulfilment.compute-surge': OwnerScope;
    /** Every 15 s: overdue offers and retries, order write-back re-drive, stale index entries, double-assignment count. */
    'fulfilment.recover-deliveries': OwnerScope;
    /** After a commit: tells the order about `ASSIGNED` (startFulfilment), `PICKED_UP` (ship) or `DELIVERED` (deliver). */
    'fulfilment.apply-order-lifecycle': {
      deliveryId: string;
      status: 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED';
    };
  }
}

export const COMPUTE_SURGE_JOB = 'fulfilment.compute-surge' as const;
export const RECOVER_DELIVERIES_JOB = 'fulfilment.recover-deliveries' as const;
export const APPLY_ORDER_LIFECYCLE_JOB = ORDER_LIFECYCLE_JOB;
export { orderLifecycleJobKey };

/** Write-back is retried with exponential backoff and full jitter, at most 8 attempts (S20 FR-046). */
export const ORDER_LIFECYCLE_MAX_ATTEMPTS = 8;

declareJobType({ name: COMPUTE_SURGE_JOB, contract: ownerScopeContract });
declareJobType({ name: RECOVER_DELIVERIES_JOB, contract: ownerScopeContract });
declareJobType({
  name: APPLY_ORDER_LIFECYCLE_JOB,
  contract: z.object({
    deliveryId: z.string().uuid(),
    status: z.enum(['ASSIGNED', 'PICKED_UP', 'DELIVERED']),
  }),
  maxAttempts: ORDER_LIFECYCLE_MAX_ATTEMPTS,
});

/** Six-field cron (leading seconds): every 15 s and every 60 s. */
export const DELIVERY_SCHEDULES = [
  {
    name: RECOVER_DELIVERIES_JOB,
    cron: '*/15 * * * * *',
    jobType: RECOVER_DELIVERIES_JOB,
  },
  {
    name: COMPUTE_SURGE_JOB,
    cron: '0 * * * * *',
    jobType: COMPUTE_SURGE_JOB,
  },
] as const;

/**
 * Registers the recurring schedules from the worker's bootstrap. An invalid schedule is a programming error: it is
 * logged by the caller through the returned list and never stops the worker from booting.
 */
export async function upsertDeliverySchedules(
  jobs: Pick<JobsService, 'upsertSchedule'>,
  /** Only the schedules whose handler this app has loaded (default: all). */
  only: readonly string[] = DELIVERY_SCHEDULES.map((s) => s.name),
): Promise<InvalidScheduleError[]> {
  const failures: InvalidScheduleError[] = [];
  for (const schedule of DELIVERY_SCHEDULES.filter((s) =>
    only.includes(s.name),
  )) {
    try {
      await jobs.upsertSchedule({
        name: schedule.name,
        cron: schedule.cron,
        jobType: schedule.jobType,
        payload: {},
        overlap: 'skip',
      });
    } catch (error) {
      if (error instanceof InvalidScheduleError) failures.push(error);
      else throw error;
    }
  }
  return failures;
}

/**
 * Cancels the queued write-back of a delivery that no longer needs it. `JobsService.cancel*` answers with a
 * discriminated result: only `CONFLICT` on a RUNNING job matters (it finishes on its own, idempotently); a missing job
 * is fine.
 */
export async function cancelOrderLifecycleJob(
  jobs: Pick<JobsService, 'cancelByKey'>,
  deliveryId: string,
  status: string,
): Promise<'cancelled' | 'running_or_done' | 'absent'> {
  const result = await jobs.cancelByKey(
    orderLifecycleJobKey(deliveryId, status),
  );
  switch (result.outcome) {
    case 'CANCELLED':
      return 'cancelled';
    case 'CONFLICT':
      return 'running_or_done';
    case 'NOT_FOUND':
      return 'absent';
  }
}
