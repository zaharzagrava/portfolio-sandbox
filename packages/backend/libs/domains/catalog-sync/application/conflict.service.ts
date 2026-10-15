import { Inject, Injectable } from '@nestjs/common';
import type {
  ConflictPage,
  StockConflict,
} from '@marketplace-sandbox/contracts';
import { syncProblem } from '../domain/catalog-sync-errors';
import {
  CONFLICT_REPOSITORY,
  INTEGRATION_REPOSITORY,
  SYNC_CLOCK,
  type Clock,
  type ConflictRecord,
  type ConflictRepository,
  type ConflictStatus,
  type IntegrationRepository,
} from '../domain/ports';

const toDto = (c: ConflictRecord): StockConflict => ({
  id: c.id,
  integrationId: c.integrationId,
  externalId: c.externalId,
  productId: c.productId ?? '',
  kind: c.kind,
  base: c.base,
  local: c.local,
  remote: c.remote,
  merged: c.merged ?? c.local + c.remote - c.base,
  resolvedTo: c.resolvedTo ?? 0,
  status: c.status,
  createdAt: c.createdAt.toISOString(),
  dismissedAt: c.dismissedAt?.toISOString() ?? null,
});

/** The stock-conflict queue of one integration (FR-045, AS-39). Every lookup carries the shop: another shop's ids are 404. */
@Injectable()
export class ConflictService {
  constructor(
    @Inject(INTEGRATION_REPOSITORY)
    private readonly integrations: IntegrationRepository,
    @Inject(CONFLICT_REPOSITORY) private readonly conflicts: ConflictRepository,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
  ) {}

  async list(
    shopId: string,
    integrationId: string,
    query: { status?: ConflictStatus; limit: number; cursor?: string },
  ): Promise<ConflictPage> {
    if (!(await this.integrations.findInShop(shopId, integrationId)))
      throw syncProblem('integration_not_found');
    const page = await this.conflicts.listPage(integrationId, query);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  /** Conditional OPEN -> DISMISSED; stock is not touched. */
  async dismiss(
    shopId: string,
    integrationId: string,
    conflictId: string,
    actorId: string,
  ): Promise<StockConflict> {
    if (!(await this.integrations.findInShop(shopId, integrationId)))
      throw syncProblem('conflict_not_found');
    const dismissed = await this.conflicts.dismiss(
      integrationId,
      conflictId,
      actorId,
      null,
      this.clock.now(),
    );
    if (dismissed) return toDto(dismissed);
    if (!(await this.conflicts.findInIntegration(integrationId, conflictId)))
      throw syncProblem('conflict_not_found');
    throw syncProblem('conflict_not_open');
  }
}
