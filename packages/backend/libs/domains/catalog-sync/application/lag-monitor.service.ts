import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  CONFLICT_REPOSITORY,
  CURSOR_REPOSITORY,
  INTEGRATION_REPOSITORY,
  QUARANTINE_REPOSITORY,
  SYNC_CLOCK,
  type Clock,
  type ConflictRepository,
  type CursorRepository,
  type IntegrationRepository,
  type QuarantineRepository,
} from '../domain/ports';
import { IntegrationAttentionRequired } from './events/integration-events';
import {
  breakerOpenGauge,
  conflictsOpenGauge,
  quarantineOpenGauge,
  syncLagGauge,
} from './sync-metrics';

/** Sync lag beyond this raises one alert per episode (FR-063, AS-66). */
export const LAG_ALERT_MS = 30 * 60_000;
/** Cursor entity of the per-integration alert latch. */
export const LAG_ALERT_ENTITY = 'lag-alert';
const PAGE = 500;
const PROVIDERS = ['shopify', 'woocommerce'] as const;

/**
 * Evaluates how far each ACTIVE integration's product watermark is behind now (run by the 5-minute job). The lag gauge
 * holds the largest lag per provider. The first evaluation over the limit writes one `sync_lag` event and sets a latch
 * (a cursor row, so no column is needed); the latch is released by the first evaluation that finds the lag below the
 * limit, so a recurrence is a new episode with a new event.
 */
@Injectable()
export class LagMonitorService {
  private readonly logger = new Logger(LagMonitorService.name);

  constructor(
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(CURSOR_REPOSITORY) private readonly cursors: CursorRepository,
    @Inject(QUARANTINE_REPOSITORY)
    private readonly quarantine: QuarantineRepository,
    @Inject(CONFLICT_REPOSITORY) private readonly conflicts: ConflictRepository,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {}

  /** The open-item and breaker gauges ride on the same 5-minute pass; their failure never fails the lag evaluation. */
  private async refreshGauges(now: Date): Promise<void> {
    try {
      quarantineOpenGauge.set(await this.quarantine.countAllOpen());
      conflictsOpenGauge.set(await this.conflicts.countAllOpen());
      const open = await this.integrations.countBreakerOpen(now);
      for (const provider of PROVIDERS)
        breakerOpenGauge.set(open[provider] ?? 0, { provider });
    } catch (error) {
      this.logger.warn({
        action: 'catalog-sync.gauge_refresh_failed',
        error: error instanceof Error ? error.name : 'error',
      });
    }
  }

  async evaluate(): Promise<{ alerted: number; healthy: number }> {
    const now = this.clock.now();
    const worst = new Map<string, number>(PROVIDERS.map((p) => [p, 0]));
    let alerted = 0;
    let healthy = 0;
    let after: string | null = null;
    for (;;) {
      const page = await this.integrations.activeWatermarks(after, PAGE);
      if (page.length === 0) break;
      after = page[page.length - 1].id;
      for (const item of page) {
        const lagMs = Math.max(0, now.getTime() - item.watermark.getTime());
        worst.set(
          item.provider,
          Math.max(worst.get(item.provider) ?? 0, Math.floor(lagMs / 1000)),
        );
        if (lagMs > LAG_ALERT_MS) {
          const raised = await this.transactions.run(async () => {
            if (!(await this.cursors.markAlert(item.id, LAG_ALERT_ENTITY, now)))
              return false;
            await this.outbox.append(
              IntegrationAttentionRequired.create(
                item.id,
                0,
                {
                  integrationId: item.id,
                  shopId: item.shopId,
                  reason: 'sync_lag',
                  detail: `Catalog sync is ${Math.floor(lagMs / 60_000)} minutes behind the store.`,
                },
                now,
              ),
            );
            return true;
          });
          if (raised) {
            alerted++;
            this.logger.warn({
              action: 'catalog-sync.sync_lag',
              integrationId: item.id,
              shopId: item.shopId,
              lagSeconds: Math.floor(lagMs / 1000),
            });
          }
        } else {
          await this.cursors.clearAlert(item.id, LAG_ALERT_ENTITY);
          healthy++;
        }
      }
    }
    for (const [provider, seconds] of worst)
      syncLagGauge.set(seconds, { provider });
    await this.refreshGauges(now);
    return { alerted, healthy };
  }
}
