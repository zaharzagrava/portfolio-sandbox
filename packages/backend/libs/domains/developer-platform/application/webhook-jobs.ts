import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

/**
 * Payload of the delayed-retry job (S43 R-06: the retry lane is a job that puts the delivery back into the ordered lane,
 * never a standard queue with a group). It is the lane message plus the instant it was scheduled for; the body is read
 * from the delivery record when the attempt runs.
 */
export interface WebhookRetryPayload {
  endpointId: string;
  eventId: string;
  deliveryId: string;
  kind: 'event' | 'replay' | 'ping';
  attempt: number;
  scheduledFor?: string;
}

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'webhooks.retry': WebhookRetryPayload;
  }
}

/** The auto-disable sweep (S43 FR-042): single run, every 15 minutes. */
export const WEBHOOK_SWEEP_JOB = 'webhooks.disable-failing-endpoints';
/** The retention purge of the state-change history (S43 FR-044): single run, daily. */
export const WEBHOOK_PURGE_JOB = 'webhooks.purge-history';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'webhooks.disable-failing-endpoints': Record<string, never>;
    'webhooks.purge-history': Record<string, never>;
  }
}

declareJobType({
  name: WEBHOOK_SWEEP_JOB,
  contract: z.object({}).strict(),
});
declareJobType({
  name: WEBHOOK_PURGE_JOB,
  contract: z.object({}).strict(),
});

declareJobType({
  name: 'webhooks.retry',
  contract: z
    .object({
      endpointId: z.string(),
      eventId: z.string(),
      deliveryId: z.string(),
      kind: z.enum(['event', 'replay', 'ping']),
      attempt: z.number().int().positive(),
      scheduledFor: z.string().optional(),
    })
    .strict(),
});
