import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ShopCreated,
  ShopDeleted,
  ShopStatusChanged,
} from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { PickupProjectionService } from '../application/pickup-projection.service';

/**
 * `tenancy.shop_created|shop_status_changed|shop_deleted` → the shop copy and the documents of the shop's points
 * (S19 FR-032, research R-4). `shop_created` starts the copy at `ACTIVE`, because a shop that is never suspended emits
 * no status event; a status change is version-guarded by `shopVersion`; `shop_deleted` deactivates every point (one
 * `pickup.point_changed` each) and keeps the stock. Not coalesced: the three types do not all carry full state.
 */
@Injectable()
export class PickupShopProjector implements Projector {
  readonly name: string = 'pickup-index-shop';
  readonly topics: string[] = [ShopCreated.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [
    { event: ShopCreated },
    { event: ShopStatusChanged },
    { event: ShopDeleted },
  ];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly projection: PickupProjectionService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const total: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    const add = (c: SinkCounts) => {
      total.applied += c.applied;
      total.duplicate += c.duplicate;
      total.stale += c.stale;
    };
    for (const event of events) {
      const created = ShopCreated.match(event);
      if (created) {
        add(
          await this.projection.applyShopStatus({
            kind: 'status',
            shopId: created.payload.shopId,
            status: 'ACTIVE',
            shopVersion: created.payload.shopVersion,
          }),
        );
        continue;
      }
      const status = ShopStatusChanged.match(event);
      if (status) {
        add(
          await this.projection.applyShopStatus({
            kind: 'status',
            shopId: status.payload.shopId,
            status: status.payload.to,
            shopVersion: status.payload.shopVersion,
          }),
        );
        continue;
      }
      const deleted = ShopDeleted.match(event);
      if (deleted)
        add(
          await this.projection.applyShopDeleted({
            kind: 'deleted',
            shopId: deleted.payload.shopId,
            shopVersion: deleted.payload.shopVersion,
          }),
        );
    }
    return total;
  }
}
