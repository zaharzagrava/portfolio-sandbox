import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ShopDeleted,
  ShopOffboardingStarted,
  ShopStatusChanged,
} from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { SnapshotEffectsService } from '../application/snapshot-effects.service';

/**
 * `tenancy.events` -> the shop read model of sponsored listings (S36 FR-062, R-5): status, offboarding and deletion with
 * the shop's own version as the guard. A suspended or offboarding shop is not served; a deleted shop's campaigns end. The
 * other tenancy events are skipped by the framework.
 */
@Injectable()
export class AdsShopSnapshotProjector implements Projector {
  readonly name = 'ads-shop-snapshot';
  readonly topics = [ShopStatusChanged.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [
    { event: ShopStatusChanged },
    { event: ShopOffboardingStarted },
    { event: ShopDeleted },
  ];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(private readonly effects: SnapshotEffectsService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const event of events) {
      const status = ShopStatusChanged.match(event);
      const offboarding = ShopOffboardingStarted.match(event);
      const deleted = ShopDeleted.match(event);
      const applied = status
        ? await this.effects.applyShop({
            shopId: status.payload.shopId,
            status: status.payload.to,
            offboarding: status.payload.to === 'DELETING',
            deleted: status.payload.to === 'DELETED',
            shopVersion: status.payload.shopVersion,
          })
        : offboarding
          ? await this.effects.applyShop({
              shopId: offboarding.payload.shopId,
              status: 'DELETING',
              offboarding: true,
              deleted: false,
              shopVersion: offboarding.payload.shopVersion,
            })
          : deleted
            ? await this.effects.applyShop({
                shopId: deleted.payload.shopId,
                status: 'DELETED',
                offboarding: false,
                deleted: true,
                shopVersion: deleted.payload.shopVersion,
              })
            : null;
      if (applied === null) continue;
      if (applied) counts.applied++;
      else counts.stale++;
    }
    return counts;
  }
}
