import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { resolveCatalogSyncSettings } from '@app/common/config/catalog-sync-config';
import { nextDueAt } from '../domain/schedule';
import { advanceWatermark, sinceFor } from '../domain/watermark';
import {
  CURSOR_REPOSITORY,
  INTEGRATION_BACKFILL_QUEUE,
  INTEGRATION_REPOSITORY,
  INTEGRATION_SYNC_QUEUE,
  PROVIDER_SESSIONS,
  ProviderCallError,
  RUN_REPOSITORY,
  SHOP_STATUS_GATEWAY,
  SYNC_CLOCK,
  SYNC_QUEUE,
  type Clock,
  type CursorRepository,
  type IntegrationRecord,
  type IntegrationRepository,
  type ProviderSessions,
  type RunRepository,
  type ShopStatusGateway,
  type SyncCounters,
  type SyncMessage,
  type SyncQueue,
  type SyncRunKind,
  type SyncRunOutcome,
} from '../domain/ports';
import { PRODUCT_ENTITY } from './integration-view.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { IntegrationAttentionRequired } from './events/integration-events';
import { IntegrationHealthService } from './integration-health.service';
import { emptyCounters, LinkApplyService } from './link-apply.service';
import { ReconcileService } from './reconcile.service';
import { StockSyncService } from './stock-sync.service';
import { syncRunsCounter } from './sync-metrics';

/** A run holds the cursor lease for this long and renews it after every page (AS-18). */
export const LEASE_TTL_MS = 5 * 60_000;
/** More quarantined items than this in one run mean the provider's schema changed: the run halts (AS-53, FR-051). */
export const QUARANTINE_RUN_LIMIT = 1_000;
/** A halted integration is not pulled again for this long. */
export const SCHEMA_DRIFT_DELAY_MS = 60 * 60_000;
const MAX_DELAY_SECONDS = 900;

export type HandleResult = SyncRunOutcome | 'ignored';

/** Set by the engine when the message must be redelivered (the queue consumer throws on it). */
export interface DeliverySignal {
  retry: boolean;
}

/** Failures of reaching the provider; after them the message is returned to the queue. */
const RETRYABLE_KINDS: ReadonlySet<string> = new Set([
  'timeout',
  'network',
  'unavailable',
]);

const queueFor = (kind: SyncRunKind) =>
  kind === 'backfill' || kind === 'reconcile'
    ? INTEGRATION_BACKFILL_QUEUE
    : INTEGRATION_SYNC_QUEUE;

/**
 * What the page checkpoint stores: the provider's cursor of the next page and the largest `updatedAt` seen on the pages
 * already applied, so a resumed run (or a continuation after a yield) still moves the watermark to the maximum of the
 * whole pass (AS-17). A plain string is a cursor written without a maximum.
 */
interface Checkpoint {
  pageCursor: string | null;
  maxUpdatedAt: Date | null;
}

export function encodeCheckpoint(checkpoint: Checkpoint): string | null {
  if (checkpoint.pageCursor === null) return null;
  return JSON.stringify({
    c: checkpoint.pageCursor,
    m: checkpoint.maxUpdatedAt?.toISOString() ?? null,
  });
}

export function decodeCheckpoint(stored: string | null): Checkpoint {
  if (stored === null) return { pageCursor: null, maxUpdatedAt: null };
  if (stored.startsWith('{"c":')) {
    try {
      const parsed = JSON.parse(stored) as { c: string; m: string | null };
      return {
        pageCursor: parsed.c,
        maxUpdatedAt: parsed.m ? new Date(parsed.m) : null,
      };
    } catch {
      // fall through: treated as an opaque provider cursor
    }
  }
  return { pageCursor: stored, maxUpdatedAt: null };
}

/**
 * One pull of one integration: backfill (everything) or incremental (since the watermark minus the overlap). Lease-fenced
 * (one runner per integration), checkpointed per page, ended by a budget with exactly one continuation message, and the
 * watermark moves only when the whole pass is done (FR-010 - FR-016, AS-12, AS-13, AS-16 - AS-19).
 */
@Injectable()
export class SyncEngineService {
  private readonly logger = new Logger(SyncEngineService.name);

  constructor(
    private readonly config: ApiConfigService,
    private readonly apply: LinkApplyService,
    private readonly stock: StockSyncService,
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(CURSOR_REPOSITORY) private readonly cursors: CursorRepository,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(PROVIDER_SESSIONS) private readonly sessions: ProviderSessions,
    @Inject(SHOP_STATUS_GATEWAY) private readonly shops: ShopStatusGateway,
    @Inject(SYNC_QUEUE) private readonly queue: SyncQueue,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly health: IntegrationHealthService,
    private readonly reconcile: ReconcileService,
  ) {}

  /** Read per run, so a changed budget applies to the next message without a restart. */
  private get settings() {
    return resolveCatalogSyncSettings((k) => this.config.get(k));
  }

  /** Queue entry point. A message for an unknown, paused or disconnected integration is acknowledged and does nothing (A29). */
  async handle(
    message: SyncMessage,
    delivery: DeliverySignal = { retry: false },
  ): Promise<HandleResult> {
    const integration = await this.integrations.findById(message.integrationId);
    if (
      !integration ||
      integration.status !== 'ACTIVE' ||
      !integration.credentialsSealed
    )
      return 'ignored';
    if (message.kind === 'incremental' || message.kind === 'backfill')
      return this.pull(integration, message.kind, delivery);
    if (message.kind === 'one')
      return this.fetchOne(integration, message, delivery);
    return this.reconcile.run(integration);
  }

  private async pull(
    integration: IntegrationRecord,
    kind: 'incremental' | 'backfill',
    delivery: DeliverySignal,
  ): Promise<HandleResult> {
    const startedAt = this.clock.now();
    const shop = (await this.shops.getStatuses([integration.shopId])).get(
      integration.shopId,
    );
    if (!shop || shop.status !== 'ACTIVE')
      return this.recordSkipped(integration, kind, 'skipped_shop_not_active');

    const holder = randomUUID();
    const fence = await this.cursors.claimLease(
      integration.id,
      PRODUCT_ENTITY,
      holder,
      LEASE_TTL_MS,
      startedAt,
    );
    if (fence === null)
      return this.recordSkipped(integration, kind, 'skipped_locked');

    const settings = this.settings;
    const runId = await this.runs.start(integration.id, kind, startedAt);
    const counters = emptyCounters();
    const finish = async (outcome: SyncRunOutcome, detail?: string) => {
      await this.runs.finish(
        runId,
        { outcome, counters, detail: detail ?? null },
        this.clock.now(),
      );
      syncRunsCounter.add(1, { provider: integration.provider, kind, outcome });
      return outcome;
    };
    const budgetMs =
      kind === 'backfill'
        ? settings.backfillBudgetMs
        : settings.incrementalBudgetMs;

    try {
      const session = this.sessions.forIntegration(integration);
      const provider = this.sessions.provider(integration.provider);
      const cursor = await this.cursors.read(integration.id, PRODUCT_ENTITY);
      const since =
        kind === 'backfill' || !cursor?.watermark
          ? null
          : sinceFor(cursor.watermark);
      const resumed = decodeCheckpoint(cursor?.pageCursor ?? null);
      let pageCursor = resumed.pageCursor;
      let maxUpdatedAt: Date | null = resumed.maxUpdatedAt;
      let pages = 0;

      for (;;) {
        const fetchedAt = this.clock.now();
        const page = await provider.listChanged(session, { since, pageCursor });
        // A pause or disconnect that happened while the page was in flight stops the run before it writes anything (AS-69).
        const current = await this.integrations.findById(integration.id);
        if (!current || current.status !== 'ACTIVE')
          return await finish('failed', 'integration_inactive');
        const applied = await this.apply.applyItems(integration, page.items, {
          quarantineLimit: QUARANTINE_RUN_LIMIT - counters.quarantined,
        });
        add(counters, applied.counters);
        if (applied.kind === 'shop_not_active')
          return await finish('skipped_shop_not_active');
        await this.stock.mergePage(integration, applied.stock, fetchedAt);
        if (applied.halted)
          return await this.haltSchemaDrift(integration, fence, finish);
        if (
          applied.kind === 'applied' &&
          applied.maxUpdatedAt &&
          (!maxUpdatedAt || applied.maxUpdatedAt > maxUpdatedAt)
        )
          maxUpdatedAt = applied.maxUpdatedAt;

        pages++;
        pageCursor = page.nextCursor;
        const now = this.clock.now();
        const kept =
          (await this.cursors.checkpoint(
            integration.id,
            PRODUCT_ENTITY,
            fence,
            encodeCheckpoint({ pageCursor, maxUpdatedAt }),
          )) &&
          (await this.cursors.renewLease(
            integration.id,
            PRODUCT_ENTITY,
            holder,
            fence,
            LEASE_TTL_MS,
            now,
          ));
        if (!kept) return await finish('failed', 'lease_lost');

        if (pageCursor === null) break;
        if (
          pages >= settings.maxPagesPerRun ||
          now.getTime() - startedAt.getTime() >= budgetMs
        ) {
          await this.queue.enqueue(queueFor(kind), {
            integrationId: integration.id,
            kind,
          });
          return await finish('yielded');
        }
      }

      const now = this.clock.now();
      const watermark = advanceWatermark({
        current: cursor?.watermark ?? null,
        fetched: maxUpdatedAt ? [maxUpdatedAt] : [],
        now,
      });
      // `watermark` is the maximum of the whole pass (clamped to now, never backwards); the fence guards the write.
      const moved = watermark
        ? await this.cursors.advanceWatermark(
            integration.id,
            PRODUCT_ENTITY,
            fence,
            watermark,
          )
        : await this.cursors.checkpoint(
            integration.id,
            PRODUCT_ENTITY,
            fence,
            null,
          );
      if (!moved) return await finish('failed', 'lease_lost');
      await this.integrations.recordSynced(
        integration.id,
        now,
        nextDueAt(now, integration.id),
      );
      return await finish(
        counters.quarantined > 0 ? 'completed_with_quarantine' : 'completed',
      );
    } catch (error) {
      if (!(error instanceof ProviderCallError)) {
        await finish('failed', 'internal_error').catch(() => undefined);
        throw error;
      }
      return await this.providerFailure(
        integration,
        { integrationId: integration.id, kind },
        error,
        finish,
        delivery,
      );
    } finally {
      await this.cursors
        .releaseLease(integration.id, PRODUCT_ENTITY, holder, fence)
        .catch(() => undefined);
    }
  }

  /**
   * The run reached the quarantine limit (AS-53): good items already applied stay applied, the watermark does not move,
   * the page checkpoint is dropped (the next pull starts again from the watermark), the next pull is an hour away and
   * the seller is told once.
   */
  private async haltSchemaDrift(
    integration: IntegrationRecord,
    fence: number,
    finish: (
      outcome: SyncRunOutcome,
      detail?: string,
    ) => Promise<SyncRunOutcome>,
  ): Promise<SyncRunOutcome> {
    const now = this.clock.now();
    await this.cursors.checkpoint(integration.id, PRODUCT_ENTITY, fence, null);
    await this.transactions.run(async () => {
      await this.integrations.setNextSync(
        integration.id,
        new Date(now.getTime() + SCHEMA_DRIFT_DELAY_MS),
      );
      await this.outbox.append(
        IntegrationAttentionRequired.create(
          integration.id,
          0,
          {
            integrationId: integration.id,
            shopId: integration.shopId,
            reason: 'schema_drift',
            detail: `${QUARANTINE_RUN_LIMIT} items were quarantined in one run; the pull was stopped`,
          },
          now,
        ),
      );
    });
    return finish('halted_schema_drift');
  }

  /**
   * Webhook fast path (`one`): fetch the provider's current state of one product and apply it like a page item. No lease
   * and no watermark: the per-item stale guard and the catalog's own serialisation make a concurrent page and fetch
   * produce exactly one effect (AS-22, AS-23). A product gone at the provider is confirmed by this direct read before
   * anything is deleted (AS-30); a product the provider still returns is applied, never deleted.
   */
  private async fetchOne(
    integration: IntegrationRecord,
    message: SyncMessage,
    delivery: DeliverySignal,
  ): Promise<HandleResult> {
    if (!message.externalId) return 'ignored';
    const startedAt = this.clock.now();
    const shop = (await this.shops.getStatuses([integration.shopId])).get(
      integration.shopId,
    );
    if (!shop || shop.status !== 'ACTIVE')
      return this.recordSkipped(integration, 'one', 'skipped_shop_not_active');

    const runId = await this.runs.start(integration.id, 'one', startedAt);
    const counters = emptyCounters();
    const finish = async (outcome: SyncRunOutcome, detail?: string) => {
      await this.runs.finish(
        runId,
        { outcome, counters, detail: detail ?? null },
        this.clock.now(),
      );
      syncRunsCounter.add(1, {
        provider: integration.provider,
        kind: 'one',
        outcome,
      });
      return outcome;
    };
    try {
      const session = this.sessions.forIntegration(integration);
      const fetchedAt = this.clock.now();
      const raw = await this.sessions
        .provider(integration.provider)
        .fetchOne(session, message.externalId);
      if (raw) {
        const applied = await this.apply.applyItems(integration, [raw]);
        add(counters, applied.counters);
        if (applied.kind === 'shop_not_active')
          return await finish('skipped_shop_not_active');
        await this.stock.mergePage(integration, applied.stock, fetchedAt);
      } else {
        // The direct read answered "gone" (404): that, not the webhook, confirms the deletion (AS-30).
        counters.updated += await this.apply.markDeleted(
          integration,
          message.externalId,
        );
      }
      return await finish(
        counters.quarantined > 0 ? 'completed_with_quarantine' : 'completed',
      );
    } catch (error) {
      if (!(error instanceof ProviderCallError)) {
        await finish('failed', 'internal_error').catch(() => undefined);
        throw error;
      }
      return await this.providerFailure(
        integration,
        message,
        error,
        finish,
        delivery,
      );
    }
  }

  private async providerFailure(
    integration: IntegrationRecord,
    message: SyncMessage,
    error: ProviderCallError,
    finish: (
      outcome: SyncRunOutcome,
      detail?: string,
    ) => Promise<SyncRunOutcome>,
    delivery: DeliverySignal,
  ): Promise<SyncRunOutcome> {
    if (error.isYield) {
      const delaySeconds = Math.min(
        MAX_DELAY_SECONDS,
        Math.max(1, Math.ceil((error.retryAfterMs ?? 1000) / 1000)),
      );
      await this.queue.enqueue(queueFor(message.kind), message, {
        delaySeconds,
      });
      return finish('yielded', error.kind);
    }
    if (error.kind === 'breaker_open') return finish('skipped_breaker_open');
    if (error.kind === 'auth_failed') {
      // The credential does not work and no refresh fixed it: the integration needs the seller (AS-60). Nothing to retry.
      await this.health.markNeedsReauth(integration);
      return finish('failed', error.kind);
    }
    await this.integrations.recordError(
      integration.id,
      `provider_${error.kind}`,
    );
    // The provider could not be reached: the message goes back to the queue (AS-58). A refusal or a bad answer is not
    // retried by redelivery; the next scheduled pull tries again.
    delivery.retry = RETRYABLE_KINDS.has(error.kind);
    return finish('failed', error.kind);
  }

  private async recordSkipped(
    integration: IntegrationRecord,
    kind: SyncRunKind,
    outcome: SyncRunOutcome,
  ): Promise<SyncRunOutcome> {
    const at = this.clock.now();
    const runId = await this.runs.start(integration.id, kind, at);
    await this.runs.finish(runId, { outcome, counters: {}, detail: null }, at);
    syncRunsCounter.add(1, { provider: integration.provider, kind, outcome });
    return outcome;
  }
}

function add(into: SyncCounters, from: SyncCounters): void {
  for (const key of Object.keys(into) as Array<keyof SyncCounters>)
    into[key] += from[key];
}
