import { Inject, Injectable } from '@nestjs/common';
import type { Integration } from '@marketplace-sandbox/contracts';
import {
  CONFLICT_REPOSITORY,
  CURSOR_REPOSITORY,
  LINK_REPOSITORY,
  QUARANTINE_REPOSITORY,
  SYNC_CLOCK,
  type Clock,
  type ConflictRepository,
  type CursorRepository,
  type IntegrationRecord,
  type LinkRepository,
  type QuarantineRepository,
} from '../domain/ports';

export const PRODUCT_ENTITY = 'product';

/** `integrationSchema` of the HTTP contract: never carries credentials, only whether they are set. */
@Injectable()
export class IntegrationViewService {
  constructor(
    @Inject(CURSOR_REPOSITORY) private readonly cursors: CursorRepository,
    @Inject(LINK_REPOSITORY) private readonly links: LinkRepository,
    @Inject(QUARANTINE_REPOSITORY)
    private readonly quarantine: QuarantineRepository,
    @Inject(CONFLICT_REPOSITORY) private readonly conflicts: ConflictRepository,
    @Inject(SYNC_CLOCK) private readonly clock: Clock,
  ) {}

  async toDto(record: IntegrationRecord): Promise<Integration> {
    const [cursor, linkedProducts, openQuarantine, openConflicts] =
      await Promise.all([
        this.cursors.read(record.id, PRODUCT_ENTITY),
        this.links.countLinked(record.id),
        this.quarantine.countOpen(record.id),
        this.conflicts.countOpen(record.id),
      ]);
    const watermark = cursor?.watermark ?? null;
    return {
      id: record.id,
      provider: record.provider,
      externalShop: record.externalShop,
      status: record.status,
      pausedReason: record.pausedReason,
      lastError: record.lastError,
      lastSyncAt: record.lastSyncAt?.toISOString() ?? null,
      watermark: watermark?.toISOString() ?? null,
      lagSeconds: watermark
        ? Math.max(
            0,
            Math.floor(
              (this.clock.now().getTime() - watermark.getTime()) / 1000,
            ),
          )
        : null,
      linkedProducts,
      openQuarantine,
      openConflicts,
      breakerOpenUntil: record.breakerOpenUntil?.toISOString() ?? null,
      credentialsSet: record.credentialsSealed !== null,
      createdAt: record.createdAt.toISOString(),
    };
  }
}
