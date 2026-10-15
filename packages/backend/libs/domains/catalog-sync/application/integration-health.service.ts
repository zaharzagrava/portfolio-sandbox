import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { transition } from '../domain/integration-status';
import {
  INTEGRATION_REPOSITORY,
  SYNC_CLOCK,
  type Clock,
  type IntegrationRecord,
  type IntegrationRepository,
} from '../domain/ports';
import {
  IntegrationAttentionRequired,
  IntegrationStatusChanged,
} from './events/integration-events';

/**
 * What a failing provider does to the integration's status (FR-008, FR-009, AS-60). The only mover here is
 * `auth_failed`: the credential no longer works and no refresh fixed it, so the integration needs the seller.
 */
@Injectable()
export class IntegrationHealthService {
  private readonly logger = new Logger(IntegrationHealthService.name);

  constructor(
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * `ACTIVE | PAUSED -> NEEDS_REAUTH` with the history row, the status event and the one attention event in one
   * transaction. The update is conditional on the status read here, so of several workers that fail at the same moment
   * exactly one moves the row and writes the events. Returns whether this call moved it.
   */
  async markNeedsReauth(integration: IntegrationRecord): Promise<boolean> {
    const outcome = transition(integration.status, 'auth_failed');
    if (outcome.kind !== 'moved') return false;
    const now = this.clock.now();
    const moved = await this.transactions.run(async () => {
      const row = await this.integrations.transition(
        integration.id,
        integration.status,
        outcome.to,
        {
          reason: 'auth_failed',
          actorId: null,
          now,
          lastError: 'provider_auth_failed',
        },
      );
      if (!row) return false;
      await this.outbox.append([
        IntegrationStatusChanged.create(
          integration.id,
          0,
          {
            integrationId: integration.id,
            shopId: integration.shopId,
            from: integration.status,
            to: outcome.to,
            reason: 'auth_failed',
          },
          now,
        ),
        IntegrationAttentionRequired.create(
          integration.id,
          0,
          {
            integrationId: integration.id,
            shopId: integration.shopId,
            reason: 'needs_reauth',
            detail:
              'The store rejected the credential and it could not be refreshed. Reconnect the store.',
          },
          now,
        ),
      ]);
      return true;
    });
    if (moved)
      this.logger.warn({
        action: 'catalog-sync.needs_reauth',
        integrationId: integration.id,
        shopId: integration.shopId,
      });
    return moved;
  }
}
