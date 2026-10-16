import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { productDeletedPayloadSchema } from '@marketplace-sandbox/contracts';
import { ProductDeleted } from '@app/domains/catalog';
import { ShopDeleted } from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { assetMetrics } from '../application/asset-metrics';
import { CleanupService } from '../application/cleanup.service';
import { EntitlementService } from '../application/entitlement.service';

export const CATALOG_SHOP_CONSUMER = 'asset-library-catalog-shop';

const shopDeletedPayload = z.object({ shopId: z.string().uuid() }).loose();

/**
 * `catalog.product_deleted` (the product's link goes, entitlements keep working) and `tenancy.shop_deleted` (the shop's
 * library is purged and its entitlements revoked) (S31 FR-044, AS-70, AS-71). `natural` idempotency: every step is
 * conditional on state that the first delivery already changed, and the storage deletes of a shop purge must not run
 * inside an inbox transaction. An unknown product or shop is not an error.
 */
@Injectable()
export class AssetCatalogShopConsumer implements Projector {
  readonly name: string = CATALOG_SHOP_CONSUMER;
  readonly topics: string[] = [ProductDeleted.topic, ShopDeleted.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly attempts = 5;
  readonly handles: HandledEvent[] = [
    { event: ProductDeleted },
    { event: ShopDeleted },
  ];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(
    private readonly entitlements: EntitlementService,
    private readonly cleanup: CleanupService,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const event of events) {
      if (event.version !== 1) throw this.invalid(event.type);
      if (event.type === ProductDeleted.type) {
        const parsed = productDeletedPayloadSchema.safeParse(event.payload);
        if (!parsed.success) throw this.invalid(event.type);
        await this.entitlements.onProductDeleted(
          parsed.data.productId,
          parsed.data.shopId,
        );
      } else if (event.type === ShopDeleted.type) {
        const parsed = shopDeletedPayload.safeParse(event.payload);
        if (!parsed.success) throw this.invalid(event.type);
        // entitlements end first, so nothing is "in use" while the library goes
        await this.entitlements.revokeShop(parsed.data.shopId);
        await this.cleanup.purgeShop(parsed.data.shopId);
      }
    }
  }

  private invalid(type: string): PermanentError {
    assetMetrics.entitlements.add(1, { event: 'dead_lettered' });
    return new PermanentError(`invalid ${type} payload`);
  }
}
