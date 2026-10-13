import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ProductDeleted } from '@app/domains/catalog';
import { ShopDeleted, ShopStatusChanged } from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { Projector } from '@app/infrastructure/projections/projector';
import { VideoStore } from '../domain/video-ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Videos soft-deleted per transaction when a shop goes away (S30 AS-54). */
export const SHOP_DELETE_BATCH = 50;

/**
 * An event of another type or version, a payload that breaks its schema, or an id that is not a UUID is poison: no side
 * effect, no crash (the producers' schemas accept any string id, the tables do not).
 */
function matchOrNull<D extends { match(envelope: EventEnvelope): unknown }>(
  definition: D,
  envelope: EventEnvelope,
  idsOf: (payload: never) => string[],
): ReturnType<D['match']> | null {
  try {
    const event = definition.match(envelope) as { payload: never } | null;
    return event && idsOf(event.payload).every((id) => UUID.test(id))
      ? (event as ReturnType<D['match']>)
      : null;
  } catch {
    return null;
  }
}

/**
 * `catalog.product_deleted` → the videos of that product in that shop lose their link and gain a version (the videos
 * stay). A `shopId` that does not match the video's shop changes nothing. Natural idempotency: the second delivery
 * finds no video still linked.
 */
@Injectable()
export class VideoProductDeletedProjector implements Projector {
  readonly name = 'video-product-deleted';
  readonly topics = [ProductDeleted.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ProductDeleted }];
  readonly attempts = 3;

  constructor(
    private readonly store: VideoStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    let poison: string | null = null;
    for (const envelope of events) {
      const event = matchOrNull(
        ProductDeleted,
        envelope,
        (p: { productId: string; shopId: string }) => [p.productId, p.shopId],
      );
      if (!event) {
        poison ??= 'unexpected_event';
        continue;
      }
      const { productId, shopId } = event.payload as {
        productId: string;
        shopId: string;
      };
      await this.store.tx(({ video }) =>
        video.clearProduct(productId, shopId, this.clock.now()),
      );
    }
    if (poison) throw new PermanentError(poison);
  }
}

/**
 * `tenancy.shop_deleted` → every video of the shop that is not `DELETED` becomes `DELETED` in batches of 50, each batch
 * one transaction (history row, `video.deleted` per video, open tasks `CANCELLED`). The objects, and an open multipart
 * upload, are reclaimed by the purge job: this projector holds no storage and no queue. Natural idempotency.
 */
@Injectable()
export class VideoShopDeletedProjector implements Projector {
  readonly name = 'video-shop-deleted';
  readonly topics = [ShopDeleted.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ShopDeleted }];
  readonly attempts = 3;

  constructor(
    private readonly store: VideoStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    let poison: string | null = null;
    for (const envelope of events) {
      const event = matchOrNull(
        ShopDeleted,
        envelope,
        (p: { shopId: string }) => [p.shopId],
      );
      if (!event) {
        poison ??= 'unexpected_event';
        continue;
      }
      const { shopId } = event.payload as { shopId: string };
      let moved: number;
      do {
        moved = await this.store.tx(({ video }) =>
          video.deleteShopBatch(shopId, SHOP_DELETE_BATCH, this.clock.now()),
        );
      } while (moved === SHOP_DELETE_BATCH);
    }
    if (poison) throw new PermanentError(poison);
  }
}

/**
 * `tenancy.shop_status_changed` → the local copy of the shop's suspension (`VideoShopState`), kept only when the event's
 * `shopVersion` is higher than the stored one, so an older or repeated event changes nothing. A shop with no video gets
 * its copy anyway: playback reads it by shop id and a missing row means active.
 */
@Injectable()
export class VideoShopStatusProjector implements Projector {
  readonly name = 'video-shop-status';
  readonly topics = [ShopStatusChanged.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ShopStatusChanged }];
  readonly attempts = 3;

  constructor(
    private readonly store: VideoStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    let poison: string | null = null;
    for (const envelope of events) {
      const event = matchOrNull(
        ShopStatusChanged,
        envelope,
        (p: { shopId: string }) => [p.shopId],
      );
      if (!event) {
        poison ??= 'unexpected_event';
        continue;
      }
      const { shopId, to, shopVersion } = event.payload as {
        shopId: string;
        to: string;
        shopVersion: number;
      };
      await this.store.tx(({ video }) =>
        video.upsertShopState({
          shopId,
          suspended: to === 'SUSPENDED',
          shopVersion,
          now: this.clock.now(),
        }),
      );
    }
    if (poison) throw new PermanentError(poison);
  }
}
