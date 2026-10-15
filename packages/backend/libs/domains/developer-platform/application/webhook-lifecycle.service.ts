import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock, CLOCK } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { isFailureWindowExpired } from '../domain/endpoint-status';
import {
  DeliveryLog,
  EndpointHistory,
  EndpointRepository,
  type EndpointRecord,
} from '../domain/webhook-ports';
import {
  WEBHOOK_SETTINGS,
  type WebhookSettings,
} from '../domain/webhook-settings';
import { parseEndpointUrl } from '../domain/webhook-url';
import {
  WebhookEndpointChanged,
  WebhookEndpointDisabled,
} from './events/webhook-events';
import { webhookMetrics } from './webhook-metrics';
import { WebhookSubscriptions } from './webhook-subscriptions.service';

/** Rows (or items) removed by one statement; a shop with more is purged over several. */
export const PURGE_BATCH = 1_000;
/** Endpoints one sweep pass looks at; the sweep loops until none is left. */
const SWEEP_PAGE = 200;
const DAY_MS = 86_400_000;

/**
 * Lifecycle of the webhook data (S43 FR-042, FR-044, FR-048): the failure window and auto-disable, the sweep that
 * catches endpoints no attempt reaches any more, the shop-deleted purge and the history retention.
 *
 * The disable is one conditional statement (`status = 'enabled' AND failingSince <= cutoff`) in a transaction with its
 * history row and its outbox events, so a concurrent attempt, a second sweep on another instance or a repeat finds
 * nothing to do and writes no second event. Whatever needs the network or another store (the subscription cache, the
 * delivery log) runs after the commit and is repeated by the next sweep if it fails.
 */
@Injectable()
export class WebhookLifecycleService {
  private readonly logger = new Logger(WebhookLifecycleService.name);

  constructor(
    private readonly endpoints: EndpointRepository,
    private readonly history: EndpointHistory,
    private readonly log: DeliveryLog,
    private readonly subscriptions: WebhookSubscriptions,
    private readonly outbox: OutboxService,
    private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WEBHOOK_SETTINGS) private readonly settings: WebhookSettings,
  ) {}

  // ------------------------------------------------------------ failure window

  /** True when a failure at `at` with the window opened at `failingSince` switches the endpoint off. */
  windowExpired(failingSince: Date | null, at: Date): boolean {
    return isFailureWindowExpired(
      failingSince,
      at,
      this.settings.failureWindowMs,
    );
  }

  /**
   * Switches the endpoint off when its failure window is over; false when it was not (still inside the window,
   * recovered, already disabled, or another caller did it first). The event is `{endpointId, shopId, host,
   * failingSince}`: the host only, an address path or query can carry a secret.
   */
  async autoDisable(endpointId: string): Promise<boolean> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - this.settings.failureWindowMs);
    const disabled = await this.runner.run(async () => {
      const done = await this.endpoints.disableIfFailingSince(
        endpointId,
        cutoff,
        now,
      );
      if (!done) return null;
      const host = this.hostOf(done);
      await this.history.append([
        {
          endpointId: done.id,
          shopId: done.shopId,
          facet: 'status',
          fromValue: 'enabled',
          toValue: 'disabled',
          actorId: null,
          at: now,
        },
      ]);
      await this.outbox.append([
        WebhookEndpointDisabled.create(
          done.id,
          0,
          {
            endpointId: done.id,
            shopId: done.shopId,
            host,
            failingSince: done.failingSince!.toISOString(),
          },
          now,
        ),
        WebhookEndpointChanged.create(
          done.id,
          0,
          { endpointId: done.id, shopId: done.shopId, change: 'disabled' },
          now,
        ),
      ]);
      return { endpoint: done, host };
    });
    if (!disabled) return false;
    webhookMetrics.autoDisabled().add(1);
    this.logger.log(
      `webhook endpoint ${disabled.endpoint.id} of shop ${disabled.endpoint.shopId} switched off after the failure window (host ${disabled.host})`,
    );
    await this.afterDisable(disabled.endpoint);
    return true;
  }

  private hostOf(endpoint: EndpointRecord): string {
    const parsed = parseEndpointUrl(endpoint.url);
    return parsed.ok ? parsed.host : 'invalid';
  }

  /** Cache and delivery log follow the commit; a failure here is repaired by the next sweep or by the attempt itself. */
  private async afterDisable(endpoint: EndpointRecord): Promise<void> {
    await Promise.allSettled([
      this.subscriptions.invalidate(endpoint.shopId, endpoint.id),
      this.log.cancelPending(endpoint.id, 'endpoint_disabled'),
    ]).then((results) => {
      for (const r of results)
        if (r.status === 'rejected')
          this.logger.warn(
            `after-disable step failed for endpoint ${endpoint.id}: ${String(r.reason?.message ?? r.reason)}`,
          );
    });
  }

  /**
   * The scheduled job (every 15 minutes, one run at a time): endpoints whose window is over and that no attempt reaches
   * any more (every delivery is exhausted) are switched off. Safe to run twice or on two instances at once. Returns the
   * number this call disabled.
   */
  async sweepFailingEndpoints(): Promise<number> {
    let disabled = 0;
    const cutoff = new Date(
      this.clock.now().getTime() - this.settings.failureWindowMs,
    );
    for (;;) {
      const due = await this.endpoints.findFailingBefore(cutoff, SWEEP_PAGE);
      let progressed = 0;
      for (const { id } of due) {
        if (await this.autoDisable(id)) {
          disabled++;
          progressed++;
        }
      }
      // A row that another instance disabled between the read and our update makes no progress here but is gone from
      // the next read; stop when a whole page changed nothing so a stuck row cannot loop forever.
      if (due.length < SWEEP_PAGE || progressed === 0) break;
    }
    return disabled;
  }

  // ------------------------------------------------------------ shop deleted

  /**
   * A deleted shop: its endpoints (and its counter with the last batch), their history rows and their log items go, at
   * most `PURGE_BATCH` rows per transaction. Idempotent: a repeat finds nothing. Queued deliveries are never sent: the
   * worker finds neither endpoint nor delivery. Returns the number of endpoints removed.
   */
  async purgeShop(shopId: string): Promise<number> {
    let removed = 0;
    for (;;) {
      const ids = await this.runner.run(() =>
        this.endpoints.deleteForShop(shopId, PURGE_BATCH),
      );
      for (const id of ids)
        while ((await this.log.deleteForEndpoint(id, PURGE_BATCH)) > 0);
      removed += ids.length;
      if (ids.length < PURGE_BATCH) break;
    }
    while (
      (await this.runner.run(() =>
        this.history.deleteForShop(shopId, PURGE_BATCH),
      )) > 0
    );
    await this.subscriptions.invalidate(shopId);
    return removed;
  }

  // ------------------------------------------------------------ retention

  /**
   * The history of state changes is kept `historyRetentionDays` (400): a row whose age reached that is deleted, at most
   * `PURGE_BATCH` per statement. Idempotent. Returns the number removed. (The delivery log expires through the store's
   * TTL and is never read after 30 days.)
   */
  async purgeHistory(): Promise<number> {
    const cutoff = new Date(
      this.clock.now().getTime() - this.settings.historyRetentionDays * DAY_MS,
    );
    let removed = 0;
    for (;;) {
      const n = await this.runner.run(() =>
        this.history.deleteOlderThan(cutoff, PURGE_BATCH),
      );
      removed += n;
      if (n < PURGE_BATCH) break;
    }
    return removed;
  }
}
