import { Inject, Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { afterCommit } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  DIRECTORY_REPOSITORY,
  SHOP_REPOSITORY,
  TENANT_TRANSACTIONS,
  type DirectoryRecord,
  type DirectoryRepository,
  type ShopRepository,
  type TenantTransactions,
} from '../domain/ports';
import { ShopCellMoved } from '../domain/events';
import {
  Domain_RegionNotAllowedError,
  Domain_ShopNotFoundError,
  Domain_StaleVersionError,
  Domain_UnknownCellError,
} from '../domain/errors';
import { parseCells, POOLED_CELL } from '../domain/cell-config';
import { allowedRegions } from '../domain/region-policy';
import { TenancyAudit } from './tenancy-observability';

/** How long a cell answer is trusted in this process: the bound on a lost invalidation (FR-052). */
export const CELL_CACHE_TTL_MS = 5 * 60_000;

interface Entry {
  value: { cell: string; region: string };
  expiresAt: number;
}

/**
 * Which cell and region a shop lives in (FR-050 to FR-052). Lookups are cache-aside in the process for 5 minutes;
 * a move drops the entry here after commit, other instances catch up when their entry expires.
 */
@Injectable()
export class ShopCellService {
  private readonly cache = new Map<string, Entry>();

  constructor(
    @Inject(DIRECTORY_REPOSITORY)
    private readonly directory: DirectoryRepository,
    @Inject(SHOP_REPOSITORY) private readonly shops: ShopRepository,
    @Inject(TENANT_TRANSACTIONS) private readonly shopTx: TenantTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
    private readonly outbox: OutboxService,
    private readonly audit: TenancyAudit,
  ) {}

  async cellOf(shopId: string): Promise<{ cell: string; region: string }> {
    const now = this.clock.nowMs();
    const hit = this.cache.get(shopId);
    if (hit && hit.expiresAt > now) return hit.value;
    const row = await this.directory.find(shopId);
    // No row: the shop is unknown here; never guess "pooled" (fail closed).
    if (!row) throw new Domain_ShopNotFoundError();
    const value = { cell: row.cell, region: row.region };
    this.cache.set(shopId, { value, expiresAt: now + CELL_CACHE_TTL_MS });
    return value;
  }

  async get(shopId: string): Promise<DirectoryRecord> {
    const row = await this.directory.find(shopId);
    if (!row) throw new Domain_ShopNotFoundError();
    return row;
  }

  forget(shopId: string): void {
    this.cache.delete(shopId);
  }

  async move(
    shopId: string,
    actorId: string,
    input: {
      cell: string;
      region: string;
      expectedVersion: number;
      reason: string;
    },
  ): Promise<DirectoryRecord> {
    const cells = parseCells(this.config.get('tenancy_cells')) ?? {};
    if (input.cell !== POOLED_CELL && !(input.cell in cells))
      throw new Domain_UnknownCellError();
    if (
      !allowedRegions(this.config.get('tenancy_regions')).includes(input.region)
    )
      throw new Domain_RegionNotAllowedError();

    const result = await this.shopTx.inShop(shopId, async () => {
      const shop = await this.shops.findById(shopId);
      if (!shop || shop.status === 'DELETED')
        throw new Domain_ShopNotFoundError();
      const current = await this.directory.find(shopId);
      if (!current) throw new Domain_ShopNotFoundError();
      const next = await this.directory.move({
        shopId,
        expectedVersion: input.expectedVersion,
        cell: input.cell,
        region: input.region,
        now: this.clock.now(),
      });
      if (!next) throw new Domain_StaleVersionError();
      await this.outbox.append(
        ShopCellMoved.create(shopId, shop.shopVersion, {
          shopId,
          fromCell: current.cell,
          toCell: next.cell,
          region: next.region,
          version: next.version,
        }),
      );
      afterCommit(() => this.forget(shopId));
      return next;
    });
    this.audit.record('shop.cell_moved', {
      shopId,
      actorId,
      reason: input.reason,
    });
    return result;
  }
}
