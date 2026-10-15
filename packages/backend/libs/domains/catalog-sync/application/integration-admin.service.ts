import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  Integration,
  IntegrationPage,
  IntegrationSyncRequest,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  Domain_RateLimitedError,
  Domain_RateLimiterUnavailableError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import { syncProblem } from '../domain/catalog-sync-errors';
import { parseCredentials } from '../domain/credentials';
import { transition } from '../domain/integration-status';
import {
  CREDENTIAL_VAULT,
  CURSOR_REPOSITORY,
  INTEGRATION_BACKFILL_QUEUE,
  INTEGRATION_REPOSITORY,
  INTEGRATION_SYNC_QUEUE,
  PROVIDER_SESSIONS,
  SYNC_CLOCK,
  SYNC_QUEUE,
  type Clock,
  type CredentialVault,
  type CursorRepository,
  type IntegrationRecord,
  type IntegrationRepository,
  type ProviderSessions,
  type StoreTarget,
  type SyncQueue,
} from '../domain/ports';
import { IntegrationStatusChanged } from './events/integration-events';
import {
  IntegrationViewService,
  PRODUCT_ENTITY,
} from './integration-view.service';

/**
 * The seller's management actions on one integration (FR-008, FR-070 - FR-072, AS-67 - AS-70). Every lookup carries the
 * shop, so another shop's integration is a plain `404`. A status change is the status machine's decision, one
 * conditional UPDATE plus the history row and the outbox event in one transaction; a refused move or a lost race writes
 * nothing and emits nothing. Provider calls (webhook clean-up) and queue messages happen after the commit.
 */
@Injectable()
export class IntegrationAdminService {
  private readonly logger = new Logger(IntegrationAdminService.name);

  constructor(
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(CURSOR_REPOSITORY) private readonly cursors: CursorRepository,
    @Inject(PROVIDER_SESSIONS) private readonly sessions: ProviderSessions,
    @Inject(CREDENTIAL_VAULT) private readonly vault: CredentialVault,
    @Inject(SYNC_QUEUE) private readonly queue: SyncQueue,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly view: IntegrationViewService,
    private readonly limiter: RateLimiterService,
  ) {}

  async list(
    shopId: string,
    query: { limit: number; cursor?: string },
  ): Promise<IntegrationPage> {
    const page = await this.integrations.listPage(shopId, query);
    return {
      items: await Promise.all(
        page.items.map((record) => this.view.toDto(record)),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async get(shopId: string, integrationId: string): Promise<Integration> {
    return this.view.toDto(await this.require(shopId, integrationId));
  }

  pause(
    shopId: string,
    integrationId: string,
    actorId: string,
  ): Promise<Integration> {
    return this.move(shopId, integrationId, 'pause', actorId);
  }

  /** `PAUSED -> ACTIVE`; local changes made during the pause converge through the merge (one pull plus one reconcile). */
  async resume(
    shopId: string,
    integrationId: string,
    actorId: string,
  ): Promise<Integration> {
    const dto = await this.move(shopId, integrationId, 'resume', actorId);
    for (const [queue, kind] of [
      [INTEGRATION_SYNC_QUEUE, 'incremental'],
      [INTEGRATION_BACKFILL_QUEUE, 'reconcile'],
    ] as const)
      try {
        await this.queue.enqueue(queue, { integrationId, kind });
      } catch (error) {
        // The row is due for a pull at once (`nextSyncAt` = now on resume), so the scheduled job catches up.
        this.logger.error({
          action: 'catalog-sync.resume_enqueue_failed',
          integrationId,
          kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    return dto;
  }

  private async move(
    shopId: string,
    integrationId: string,
    action: 'pause' | 'resume',
    actorId: string,
  ): Promise<Integration> {
    const record = await this.require(shopId, integrationId);
    const decision = transition(record.status, action);
    if (decision.kind !== 'moved')
      throw syncProblem('invalid_integration_transition');
    const now = this.clock.now();
    const moved = await this.transactions.run(async () => {
      const row = await this.integrations.transition(
        integrationId,
        record.status,
        decision.to,
        {
          reason: action,
          actorId,
          now,
          pausedReason: decision.pausedReason,
        },
      );
      if (!row) return null; // lost a race: the other call's outcome stands
      await this.outbox.append(
        IntegrationStatusChanged.create(
          integrationId,
          0,
          {
            integrationId,
            shopId: record.shopId,
            from: record.status,
            to: decision.to,
            reason: 'seller',
          },
          now,
        ),
      );
      return row;
    });
    if (!moved) throw syncProblem('invalid_integration_transition');
    return this.view.toDto(moved);
  }

  /**
   * `DELETE`: `DISCONNECTED`, credentials erased in the same transaction, links, products and conflicts kept. The
   * provider's webhooks are removed once, after the commit, and a failure does not fail the call. A repeat is a plain
   * success: no second event and no provider call.
   */
  async disconnect(
    shopId: string,
    integrationId: string,
    actorId: string,
  ): Promise<void> {
    const record = await this.require(shopId, integrationId);
    const decision = transition(record.status, 'disconnect');
    if (decision.kind !== 'moved') return;
    const now = this.clock.now();
    const moved = await this.transactions.run(async () => {
      const row = await this.integrations.transition(
        integrationId,
        record.status,
        decision.to,
        {
          reason: 'disconnect',
          actorId,
          now,
          pausedReason: null,
          eraseCredentials: true,
        },
      );
      if (!row) return false;
      await this.outbox.append(
        IntegrationStatusChanged.create(
          integrationId,
          0,
          {
            integrationId,
            shopId: record.shopId,
            from: record.status,
            to: decision.to,
            reason: 'disconnected',
          },
          now,
        ),
      );
      return true;
    });
    if (moved) await this.deregisterWebhooks(record);
  }

  /** Best effort, once. The credentials were read before they were erased; nothing here can fail the request. */
  private async deregisterWebhooks(record: IntegrationRecord): Promise<void> {
    if (!record.credentialsSealed) return;
    try {
      const credentials = parseCredentials(
        this.vault.open(record.id, record.credentialsSealed),
      );
      const target: StoreTarget =
        record.provider === 'shopify'
          ? { provider: 'shopify', shopDomain: record.externalShop }
          : { provider: 'woocommerce', storeUrl: record.externalShop };
      const session = this.sessions.forCredentials({
        target,
        credentialId: record.id,
        credentials,
      });
      await this.sessions
        .provider(record.provider)
        .deregisterWebhooksAt(session, {
          callbackUrl: `${this.config.get('backend_host').replace(/\/+$/, '')}/api/integrations/${record.id}/webhooks`,
        });
    } catch (error) {
      this.logger.warn({
        action: 'catalog-sync.webhook_cleanup_failed',
        integrationId: record.id,
        shopId: record.shopId,
        reason: (error as { kind?: string })?.kind ?? 'error',
      });
    }
  }

  /**
   * `incremental` or `backfill` on demand. Only an `ACTIVE` integration (`409` otherwise); with the breaker open nothing
   * is queued; while a pull holds the lease nothing is queued either. The limits (1 per minute, backfill 1 per hour) are
   * charged only when a message is about to be queued, so a refusal never uses them up.
   */
  async syncNow(
    shopId: string,
    integrationId: string,
    request: IntegrationSyncRequest,
  ): Promise<{ enqueued: boolean; reason?: 'breaker_open' }> {
    const record = await this.require(shopId, integrationId);
    if (record.status !== 'ACTIVE')
      throw syncProblem('invalid_integration_transition');
    const now = this.clock.now();
    if (record.breakerOpenUntil !== null && record.breakerOpenUntil > now)
      return { enqueued: false, reason: 'breaker_open' };
    const cursor = await this.cursors.read(integrationId, PRODUCT_ENTITY);
    if (
      cursor?.leaseHolder &&
      cursor.leaseExpiresAt &&
      cursor.leaseExpiresAt > now
    )
      return { enqueued: false };

    const backfill = request.mode === 'backfill';
    await this.charge(
      backfill
        ? 'catalog-sync.backfill-now.integration'
        : 'catalog-sync.sync-now.integration',
      integrationId,
    );
    if (backfill) await this.cursors.reset(integrationId, PRODUCT_ENTITY);
    await this.queue.enqueue(
      backfill ? INTEGRATION_BACKFILL_QUEUE : INTEGRATION_SYNC_QUEUE,
      { integrationId, kind: backfill ? 'backfill' : 'incremental' },
    );
    return { enqueued: true };
  }

  private async charge(
    policy:
      | 'catalog-sync.backfill-now.integration'
      | 'catalog-sync.sync-now.integration',
    integrationId: string,
  ): Promise<void> {
    const decision = await this.limiter.check(policy, integrationId);
    if (decision.allowed) return;
    if (decision.reason === 'store-unavailable')
      throw new Domain_RateLimiterUnavailableError();
    throw new Domain_RateLimitedError(
      Math.max(1, Math.ceil((decision.retryAfterMs ?? 1000) / 1000)),
    );
  }

  private async require(
    shopId: string,
    integrationId: string,
  ): Promise<IntegrationRecord> {
    const found = await this.integrations.findInShop(shopId, integrationId);
    if (!found) throw syncProblem('integration_not_found');
    return found;
  }
}
