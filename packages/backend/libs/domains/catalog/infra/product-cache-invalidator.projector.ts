import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { CacheService } from '@app/infrastructure/cache';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { TransientError } from '@app/infrastructure/projections/errors';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import {
  ProductArchived,
  ProductChanged,
  ProductCreated,
  ProductDeleted,
  ProductRestored,
  ProductUpdated,
} from '../application/events/product-events';
import {
  productInvalidationCounter,
  productInvalidationLag,
} from '../domain/product-metrics';
import { productCacheKey } from './product-cache';

interface Target {
  /** Highest `productVersion` among the snapshot events of the batch; null when there was none. */
  version: number | null;
  /** A legacy "something changed" notification or a delete: drop the entry whatever it holds. */
  unconditional: boolean;
}

/**
 * Event-side delete-on-write for the public product entry (FR-024 to FR-028), the safety net behind the writer's own
 * delete: a lost or failed writer-side delete is repaired here. Its own consumer group, so a slow search projector
 * never delays it.
 *
 * - Snapshot events invalidate by version (`invalidateIfOlder`): the entry is dropped only when it is older than the
 *   event and the event's version becomes the minimum a reader may store again, so duplicates and late events change
 *   nothing and a slow reader cannot put an old row back.
 * - The legacy `catalog.product_changed` notification (writers that still update `Product` with raw SQL and do not
 *   bump `version`) and `catalog.product_deleted` drop the entry unconditionally; the legacy version is never used.
 * - The batch is coalesced here to one invalidation per product.
 * - A store failure is transient: the framework backs off and retries, it never skips the repair.
 */
@Injectable()
export class ProductCacheInvalidator implements Projector {
  readonly name: string = 'product-cache-invalidator';
  readonly topics: string[] = [ProductCreated.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [
    { event: ProductCreated },
    { event: ProductUpdated },
    { event: ProductArchived },
    { event: ProductRestored },
    { event: ProductDeleted },
    { event: ProductChanged },
  ];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(
    private readonly cache: CacheService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const targets = new Map<string, Target>();
    const now = this.clock.now().getTime();
    for (const event of events) {
      const target = targets.get(event.aggregateId) ?? {
        version: null,
        unconditional: false,
      };
      if (event.type === ProductChanged.type) target.unconditional = true;
      else if (event.type === ProductDeleted.type) target.unconditional = true;
      else
        target.version = Math.max(target.version ?? 0, event.aggregateVersion);
      targets.set(event.aggregateId, target);
    }

    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    try {
      for (const [productId, target] of targets) {
        const key = productCacheKey(productId);
        if (target.unconditional) {
          await this.cache.invalidate([key]);
          productInvalidationCounter.add(1, { result: 'applied' });
          counts.applied += 1;
        } else if (target.version !== null) {
          const { outcome } = await this.cache.invalidateIfOlder(
            key,
            target.version,
          );
          if (outcome === 'applied') counts.applied += 1;
          else counts.stale += 1;
          productInvalidationCounter.add(1, { result: outcome });
        }
      }
    } catch (error) {
      productInvalidationCounter.add(1, { result: 'failed' });
      throw new TransientError(
        `product cache invalidation failed: ${(error as Error).message}`,
        { cause: error },
      );
    }

    // Invalidation lag: from the commit of the change to its repair here, per event.
    for (const event of events)
      productInvalidationLag.record(
        Math.max(0, (now - Date.parse(event.occurredAt)) / 1000),
      );
    productInvalidationCounter.add(Math.max(0, events.length - targets.size), {
      result: 'coalesced',
    });
    return counts;
  }
}
