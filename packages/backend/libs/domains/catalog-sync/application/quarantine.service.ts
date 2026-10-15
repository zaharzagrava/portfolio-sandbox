import { Inject, Injectable } from '@nestjs/common';
import type {
  QuarantineItem,
  QuarantinePage,
} from '@marketplace-sandbox/contracts';
import { syncProblem } from '../domain/catalog-sync-errors';
import {
  INTEGRATION_REPOSITORY,
  PROVIDER_SESSIONS,
  ProviderCallError,
  QUARANTINE_REPOSITORY,
  SYNC_CLOCK,
  type Clock,
  type IntegrationRecord,
  type IntegrationRepository,
  type ProviderSessions,
  type QuarantineRecord,
  type QuarantineRepository,
  type QuarantineStatus,
} from '../domain/ports';
import { LinkApplyService } from './link-apply.service';
import { StockSyncService } from './stock-sync.service';

const toDto = (q: QuarantineRecord): QuarantineItem => ({
  id: q.id,
  integrationId: q.integrationId,
  entity: q.entity,
  externalId: q.externalId,
  reasonCode: q.reasonCode,
  message: q.message,
  payload: q.payload,
  status: q.status,
  occurrences: q.occurrences,
  firstSeenAt: q.firstSeenAt.toISOString(),
  lastSeenAt: q.lastSeenAt.toISOString(),
  resolution: q.resolution,
  resolvedAt: q.resolvedAt?.toISOString() ?? null,
});

/**
 * Review of the items the sync could not accept (FR-050, AS-50): list, retry (re-fetch from the provider and apply) and
 * dismiss. Every lookup carries the shop: another shop's ids are 404. Closing a row is a conditional update, so of two
 * concurrent actions exactly one wins and the other answers `409 quarantine_not_open`.
 */
@Injectable()
export class QuarantineService {
  constructor(
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(QUARANTINE_REPOSITORY)
    private readonly quarantine: QuarantineRepository,
    @Inject(PROVIDER_SESSIONS) private readonly sessions: ProviderSessions,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
    private readonly apply: LinkApplyService,
    private readonly stock: StockSyncService,
  ) {}

  async list(
    shopId: string,
    integrationId: string,
    query: { status?: QuarantineStatus; limit: number; cursor?: string },
  ): Promise<QuarantinePage> {
    if (!(await this.integrations.findInShop(shopId, integrationId)))
      throw syncProblem('integration_not_found');
    const page = await this.quarantine.listPage(integrationId, query);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  async dismiss(
    shopId: string,
    integrationId: string,
    id: string,
    actorId: string,
  ): Promise<QuarantineItem> {
    await this.requireIntegration(shopId, integrationId);
    const closed = await this.quarantine.close(
      integrationId,
      id,
      'DISMISSED',
      'dismissed',
      actorId,
      this.clock.now(),
    );
    if (closed) return toDto(closed);
    throw await this.whyNotClosed(integrationId, id);
  }

  async retry(
    shopId: string,
    integrationId: string,
    id: string,
  ): Promise<{ outcome: 'resolved' | 'still_invalid'; item: QuarantineItem }> {
    const integration = await this.requireIntegration(shopId, integrationId);
    const row = await this.quarantine.findInIntegration(integrationId, id);
    if (!row) throw syncProblem('quarantine_not_found');
    if (row.status !== 'OPEN') throw syncProblem('quarantine_not_open');
    if (integration.status !== 'ACTIVE' || !integration.credentialsSealed)
      throw syncProblem('invalid_integration_transition');

    // An item without a readable id cannot be asked for again: it stays invalid until the provider's data changes.
    if (row.externalId === null) return this.stillInvalid(row);

    const raw = await this.fetch(integration, row.externalId);
    const mine =
      raw?.results.filter(
        (r) => (r.ok ? r.item.externalId : r.externalId) === row.externalId,
      ) ?? [];
    if (!raw || mine.length === 0) {
      // The variant no longer exists at the provider: nothing left to fix.
      const expired = await this.quarantine.close(
        integrationId,
        id,
        'RESOLVED',
        'expired',
        null,
        this.clock.now(),
      );
      if (!expired) throw await this.whyNotClosed(integrationId, id);
      return { outcome: 'resolved', item: toDto(expired) };
    }

    const fetchedAt = this.clock.now();
    // Applying a valid item resolves its row; an invalid one is recorded again (occurrences + 1).
    const applied = await this.apply.applyItems(integration, [
      { ...raw, results: mine },
    ]);
    if (applied.kind === 'shop_not_active')
      throw syncProblem('invalid_integration_transition');
    await this.stock.mergePage(integration, applied.stock, fetchedAt);

    const after = await this.quarantine.findInIntegration(integrationId, id);
    if (!after) throw syncProblem('quarantine_not_found');
    if (after.status === 'RESOLVED')
      return { outcome: 'resolved', item: toDto(after) };
    if (after.status === 'OPEN')
      return { outcome: 'still_invalid', item: toDto(after) };
    throw syncProblem('quarantine_not_open');
  }

  private async stillInvalid(row: QuarantineRecord) {
    const again = await this.quarantine.record(
      {
        integrationId: row.integrationId,
        entity: row.entity,
        externalId: row.externalId,
        dedupeKey: row.dedupeKey,
        payloadDigest: row.payloadDigest,
        reasonCode: row.reasonCode,
        message: row.message,
        payload: row.payload,
      },
      this.clock.now(),
    );
    return { outcome: 'still_invalid' as const, item: toDto(again) };
  }

  private async fetch(integration: IntegrationRecord, externalId: string) {
    try {
      return await this.sessions
        .provider(integration.provider)
        .fetchOne(this.sessions.forIntegration(integration), externalId);
    } catch (error) {
      if (error instanceof ProviderCallError)
        throw syncProblem('provider_unavailable');
      throw error;
    }
  }

  private async requireIntegration(
    shopId: string,
    integrationId: string,
  ): Promise<IntegrationRecord> {
    const integration = await this.integrations.findInShop(
      shopId,
      integrationId,
    );
    if (!integration) throw syncProblem('quarantine_not_found');
    return integration;
  }

  private async whyNotClosed(integrationId: string, id: string) {
    return (await this.quarantine.findInIntegration(integrationId, id))
      ? syncProblem('quarantine_not_open')
      : syncProblem('quarantine_not_found');
  }
}
