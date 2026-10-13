import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { Projector } from '@app/infrastructure/projections/projector';
import { ProductDeleted } from '@app/domains/catalog';
import { ShopDeleted } from '@app/domains/tenancy';
import { MediaStore } from '../domain/ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An event of another type or version, a payload that breaks its schema, or an id that is not a UUID is poison: no side
 * effect, no crash (the producers' schemas accept any string id, the tables do not).
 */
function matchOrNull<D extends { match(envelope: EventEnvelope): unknown }>(
  definition: D,
  envelope: EventEnvelope,
  idOf: (payload: never) => string,
): ReturnType<D['match']> | null {
  try {
    const event = definition.match(envelope) as { payload: never } | null;
    return event && UUID.test(idOf(event.payload))
      ? (event as ReturnType<D['match']>)
      : null;
  } catch {
    return null;
  }
}

/**
 * `catalog.product_deleted` → the product's gallery rows go (the photos stay `READY` and unattached). Idempotency is
 * `natural`: the second delivery finds nothing to delete. The framework validates every payload against the producer's
 * own contract and dead-letters the invalid ones; the check here is for a caller that hands events over directly.
 */
@Injectable()
export class MediaProductDeletedProjector implements Projector {
  readonly name = 'media-product-deleted';
  readonly topics = [ProductDeleted.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ProductDeleted }];
  readonly attempts = 3;

  constructor(private readonly store: MediaStore) {}

  async project(events: EventEnvelope[]): Promise<void> {
    let poison: string | null = null;
    for (const envelope of events) {
      const event = matchOrNull(
        ProductDeleted,
        envelope,
        (p: { productId: string }) => p.productId,
      );
      if (!event) {
        poison ??= 'unexpected_event';
        continue;
      }
      await this.store.tx(({ gallery }) =>
        gallery.deleteForProduct(event.payload.productId),
      );
    }
    if (poison) throw new PermanentError(poison);
  }
}

/**
 * `tenancy.shop_deleted` → every photo of the shop that is not `DELETED` becomes `DELETED` (history row and one
 * `media.deleted` each) and the shop's gallery rows go. The objects are reclaimed later by the purge job; a late worker
 * run for one of its keys answers `SKIPPED`. Natural idempotency: the second delivery finds nothing live.
 */
@Injectable()
export class MediaShopDeletedProjector implements Projector {
  readonly name = 'media-shop-deleted';
  readonly topics = [ShopDeleted.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ShopDeleted }];
  readonly attempts = 3;

  constructor(
    private readonly store: MediaStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    let poison: string | null = null;
    for (const envelope of events) {
      const event = matchOrNull(
        ShopDeleted,
        envelope,
        (p: { shopId: string }) => p.shopId,
      );
      if (!event) {
        poison ??= 'unexpected_event';
        continue;
      }
      const { shopId } = event.payload;
      await this.store.tx(async ({ media, gallery }) => {
        await media.deleteShopPhotos(shopId, this.clock.now());
        await gallery.deleteForShop(shopId);
      });
    }
    if (poison) throw new PermanentError(poison);
  }
}
