import { Injectable } from '@nestjs/common';
import { INTEGRATION_SYNC_QUEUE } from '../../domain/ports';
import { SyncQueueConsumer } from './sync-queue-consumer';

/** `integration-sync`: incremental pulls and webhook fetches. Concurrency 20, visibility 300 s, DLQ after 5 receives. */
@Injectable()
export class SyncConsumer extends SyncQueueConsumer {
  protected readonly queueName = INTEGRATION_SYNC_QUEUE;
  protected readonly kinds = ['incremental', 'one'] as const;
  protected readonly concurrency = 20;
  protected readonly visibilityTimeoutSec = 300;
}
