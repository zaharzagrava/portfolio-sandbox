import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { transition } from '../domain/integration-status';
import {
  INTEGRATION_BACKFILL_QUEUE,
  INTEGRATION_REPOSITORY,
  INTEGRATION_SYNC_QUEUE,
  SHOP_PURGE_REPOSITORY,
  SYNC_CLOCK,
  SYNC_QUEUE,
  type Clock,
  type IntegrationRecord,
  type IntegrationRepository,
  type ShopPurgeRepository,
  type SyncQueue,
} from '../domain/ports';
import { IntegrationStatusChanged } from './events/integration-events';

/** Rows deleted per statement (and so per transaction) while a deleted shop is purged (AS-75). */
export const PURGE_BATCH = 1_000;
/**
 * What the shop's lifecycle does to its integrations (FR-080, AS-74, AS-75). Offboarding pauses the `ACTIVE` ones for
 * the reason `shop_offboarding` (seller pauses keep their own reason); cancelling it resumes only those and queues the
 * catch-up. Deletion erases the credentials first, then deletes every row of the shop in batches, children before the
 * integrations, so an interrupted purge is finished by the redelivery. Every move is the status machine's decision, one
 * conditional UPDATE with its history row and its outbox event in one transaction; a duplicate delivery finds nothing to
 * move and writes nothing.
 */
@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(SHOP_PURGE_REPOSITORY) private readonly purge: ShopPurgeRepository,
    @Inject(SYNC_QUEUE) private readonly queue: SyncQueue,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {}

  /** `tenancy.shop_offboarding_started`: `ACTIVE` -> `PAUSED(shop_offboarding)`. */
  async offboardingStarted(shopId: string): Promise<{ paused: number }> {
    let paused = 0;
    for (const record of await this.integrations.listByShop(shopId, [
      'ACTIVE',
    ])) {
      const decision = transition(record.status, 'offboarding_started');
      if (decision.kind !== 'moved') continue;
      if (
        await this.move(
          record,
          decision.to,
          decision.pausedReason,
          'shop_offboarding',
        )
      ) {
        paused++;
        this.logger.log({
          action: 'catalog-sync.shop_offboarding_paused',
          integrationId: record.id,
          shopId,
        });
      }
    }
    return { paused };
  }

  /** `tenancy.shop_offboarding_cancelled`: only `PAUSED(shop_offboarding)` -> `ACTIVE`, then the catch-up. */
  async offboardingCancelled(shopId: string): Promise<{ resumed: number }> {
    let resumed = 0;
    for (const record of await this.integrations.listByShop(shopId, [
      'PAUSED',
    ])) {
      const decision = transition(record.status, 'offboarding_cancelled', {
        pausedReason: record.pausedReason,
      });
      if (decision.kind !== 'moved') continue;
      if (
        !(await this.move(record, decision.to, null, 'offboarding_cancelled'))
      )
        continue;
      resumed++;
      this.logger.log({
        action: 'catalog-sync.shop_offboarding_resumed',
        integrationId: record.id,
        shopId,
      });
      for (const [queue, kind] of [
        [INTEGRATION_SYNC_QUEUE, 'incremental'],
        [INTEGRATION_BACKFILL_QUEUE, 'reconcile'],
      ] as const)
        try {
          await this.queue.enqueue(queue, { integrationId: record.id, kind });
        } catch (error) {
          // The row is due for a pull at once (`nextSyncAt` = now on resume), so the scheduled job catches up.
          this.logger.error({
            action: 'catalog-sync.offboarding_catch_up_not_queued',
            integrationId: record.id,
            shopId,
            kind,
            error: error instanceof Error ? error.name : 'error',
          });
        }
    }
    return { resumed };
  }

  /** `tenancy.shop_deleted`: credentials first, then batches until nothing of the shop is left. */
  async purgeShop(shopId: string): Promise<{ deleted: number }> {
    await this.purge.eraseCredentials(shopId);
    let deleted = 0;
    for (;;) {
      const batch = await this.purge.deleteBatch(shopId, PURGE_BATCH);
      if (batch.deleted === 0) break;
      deleted += batch.deleted;
    }
    if (deleted > 0)
      this.logger.log({ action: 'catalog-sync.shop_purged', shopId, deleted });
    return { deleted };
  }

  private async move(
    record: IntegrationRecord,
    to: IntegrationRecord['status'],
    pausedReason: IntegrationRecord['pausedReason'],
    reason: 'shop_offboarding' | 'offboarding_cancelled',
  ): Promise<boolean> {
    const now = this.clock.now();
    return this.transactions.run(async () => {
      const row = await this.integrations.transition(
        record.id,
        record.status,
        to,
        {
          reason,
          actorId: null,
          now,
          pausedReason,
        },
      );
      if (!row) return false; // lost a race or a duplicate delivery: the other outcome stands, no event
      await this.outbox.append(
        IntegrationStatusChanged.create(
          record.id,
          0,
          {
            integrationId: record.id,
            shopId: record.shopId,
            from: record.status,
            to,
            reason,
          },
          now,
        ),
      );
      return true;
    });
  }
}
