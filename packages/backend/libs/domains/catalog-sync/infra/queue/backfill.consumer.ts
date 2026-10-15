import { Injectable } from '@nestjs/common';
import { INTEGRATION_BACKFILL_QUEUE } from '../../domain/ports';
import { SyncQueueConsumer } from './sync-queue-consumer';

/**
 * `integration-backfill`: full imports and reconciliation, so a 100k-variant first import never delays other shops'
 * incremental pulls (AS-21). Concurrency 4, visibility 900 s, DLQ after 3 receives.
 */
@Injectable()
export class BackfillConsumer extends SyncQueueConsumer {
  protected readonly queueName = INTEGRATION_BACKFILL_QUEUE;
  protected readonly kinds = ['backfill', 'reconcile'] as const;
  protected readonly concurrency = 4;
  protected readonly visibilityTimeoutSec = 900;
}
