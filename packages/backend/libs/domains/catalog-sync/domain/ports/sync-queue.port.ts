import { z } from 'zod';

export const SYNC_QUEUE = Symbol('SYNC_QUEUE_PORT');

export const INTEGRATION_SYNC_QUEUE = 'integration-sync';
export const INTEGRATION_BACKFILL_QUEUE = 'integration-backfill';
export type SyncQueueName =
  typeof INTEGRATION_SYNC_QUEUE | typeof INTEGRATION_BACKFILL_QUEUE;

export const SYNC_MESSAGE_KINDS = [
  'incremental',
  'backfill',
  'one',
  'reconcile',
] as const;

/** Strict message of both sync queues; consumers use it as `bodySchema` too. */
export const syncMessageSchema = z
  .object({
    integrationId: z.string().uuid(),
    kind: z.enum(SYNC_MESSAGE_KINDS),
    externalId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type SyncMessage = z.infer<typeof syncMessageSchema>;

export interface SyncQueue {
  /**
   * Validates the message (throws before any network call on a bad one) and passes only `delaySeconds` (0..900) to the
   * queue: never `groupId` or `dedupeId` (the sync queues are standard queues, L-001).
   */
  enqueue(
    queue: SyncQueueName,
    message: SyncMessage,
    options?: { delaySeconds?: number },
  ): Promise<void>;
}
