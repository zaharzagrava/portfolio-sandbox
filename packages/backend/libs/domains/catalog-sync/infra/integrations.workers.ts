import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { KafkaTopicGroup } from '@app/infrastructure/outbox/outbox.model';
import {
  BACKFILL_QUEUE,
  IntegrationSyncService,
  SYNC_QUEUE,
} from '../application/integration-sync.service';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'integrations.sync-all': Record<string, never>;
    'integrations.reconcile-all': Record<string, never>;
  }
}

type SyncMessage =
  | { integrationId: string; kind: 'incremental' }
  | { integrationId: string; kind: 'one'; externalId: string };

/** apps/worker: two queues (incremental/webhook vs backfill) so initial imports never block day-to-day syncs. */
@Injectable()
export class IntegrationWorkers
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private stops: (() => Promise<void>)[] = [];

  constructor(
    private readonly queue: TaskQueue,
    private readonly sync: IntegrationSyncService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    const handle = async ({ body }: { body: SyncMessage }) => {
      if (body.kind === 'one')
        await this.sync.syncOne(body.integrationId, body.externalId);
      else await this.sync.syncIncremental(body.integrationId);
    };
    this.stops = [
      this.queue.consume<SyncMessage>(SYNC_QUEUE, handle, {
        concurrency: 20,
        visibilityTimeoutSec: 300,
      }),
      this.queue.consume<SyncMessage>(BACKFILL_QUEUE, handle, {
        concurrency: 4,
        visibilityTimeoutSec: 900,
      }),
    ];
    await this.jobs.upsertSchedule({
      name: 'integrations.sync-all',
      cron: '*/5 * * * *',
      jobType: 'integrations.sync-all',
      payload: {},
    });
    await this.jobs.upsertSchedule({
      name: 'integrations.reconcile-all',
      cron: '40 3 * * *',
      jobType: 'integrations.reconcile-all',
      payload: {},
    });
  }

  async onModuleDestroy() {
    await Promise.all(this.stops.map((s) => s()));
  }

  /** Webhooks are an optimisation; the 5-minute incremental pull is the guarantee (webhooks get lost). */
  @JobHandler('integrations.sync-all', { concurrency: 1 })
  async syncAll() {
    for (const integrationId of await this.sync.activeIds())
      await this.queue.enqueue(SYNC_QUEUE, {
        integrationId,
        kind: 'incremental',
      });
  }

  @JobHandler('integrations.reconcile-all', { concurrency: 1 })
  async reconcileAll() {
    for (const integrationId of await this.sync.activeIds())
      await this.sync.reconcile(integrationId);
  }
}

/** apps/projector: local product changes → push stock to connected providers (echo-suppressed by hash). */
@Injectable()
export class StockPushProjector implements Projector {
  readonly name = 'integrations-stock-push';
  readonly topics = [KafkaTopicGroup.PRODUCTS_EVENTS];
  readonly coalesce = true;

  constructor(private readonly sync: IntegrationSyncService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const productId of new Set(
      events
        .map(
          (e) =>
            (e.payload as { productId?: string })?.productId ?? e.aggregateId,
        )
        .filter(Boolean),
    ))
      await this.sync.pushStock(productId);
  }
}
