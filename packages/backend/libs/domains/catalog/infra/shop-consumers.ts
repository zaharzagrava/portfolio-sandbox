import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { JobsService } from '@app/infrastructure/jobs';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { ShopDeleted, ShopStatusChanged } from '@app/domains/tenancy';
import { ShopListingService } from '../application/shop-listing.service';
import './shop-lifecycle.jobs';

interface StatusPayload {
  shopId: string;
  to: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
  shopVersion: number;
}

/**
 * `tenancy.shop_status_changed`: keeps the catalog's copy of the shop status (version-guarded: an event not above the
 * stored `shopVersion` changes nothing) and has the shop's cached entries dropped in the background. The sweep is
 * enqueued for every delivery, applied or not, under a key of its own, so a crash between the two steps is repaired by
 * the redelivery.
 */
@Injectable()
export class ShopStatusConsumer implements Projector {
  readonly name: string = 'product-shop-status';
  readonly topics: string[] = [ShopStatusChanged.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [{ event: ShopStatusChanged }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(
    private readonly listing: ShopListingService,
    private readonly jobs: JobsService,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const event of events) {
      const { shopId, to, shopVersion } =
        event.payload as unknown as StatusPayload;
      const stored = await this.listing.applyStatus(shopId, to, shopVersion);
      if (stored) counts.applied += 1;
      else counts.stale += 1;
      await this.jobs.enqueue(
        'products.drop-shop-entries',
        { shopId, shopVersion },
        { idempotencyKey: `catalog-drop-entries:${shopId}:${shopVersion}` },
      );
    }
    return counts;
  }
}

/**
 * `tenancy.shop_deleted`: marks the shop `DELETED` (its products are hidden at once) and has its products purged in
 * the background, once per shop.
 */
@Injectable()
export class ShopDeletedConsumer implements Projector {
  readonly name: string = 'product-shop-deleted';
  readonly topics: string[] = [ShopDeleted.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [{ event: ShopDeleted }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(
    private readonly listing: ShopListingService,
    private readonly jobs: JobsService,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const event of events) {
      const { shopId, shopVersion } = event.payload as {
        shopId: string;
        shopVersion: number;
      };
      const stored = await this.listing.applyStatus(
        shopId,
        'DELETED',
        shopVersion,
      );
      if (stored) counts.applied += 1;
      else counts.duplicate += 1;
      await this.jobs.enqueue(
        'products.purge-shop',
        { shopId },
        { idempotencyKey: `catalog-purge-shop:${shopId}` },
      );
    }
    return counts;
  }
}
