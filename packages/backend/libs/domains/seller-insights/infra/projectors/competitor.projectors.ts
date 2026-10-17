import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  competitorProductDeletedSchema,
  competitorShopCreatedSchema,
  competitorShopDeletedSchema,
  competitorShopPlanChangedSchema,
  competitorShopStatusChangedSchema,
} from '@marketplace-sandbox/contracts';
import { ProductDeleted } from '@app/domains/catalog';
import {
  ShopCreated,
  ShopDeleted,
  ShopPlanChanged,
  ShopStatusChanged,
} from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { CompetitorShopService } from '../../application/competitor-shop.service';
import { parseOrReject, permissive } from './support';

const counts = (): SinkCounts => ({ applied: 0, duplicate: 0, stale: 0 });
const uuid = z.string().uuid();

/**
 * `tenancy.shop_created|plan_changed|status_changed|deleted` -> the competitor shop read model (R3, S41 FR-029): a
 * version-guarded copy of plan and status, watches paused while the shop is not ACTIVE, erased with the shop. Each
 * payload is validated against the contracts schema; anything else is dead-lettered as `invalid_payload`.
 */
@Injectable()
export class CompetitorShopProjector implements Projector {
  readonly name = 'seller-insights-competitor-shops';
  readonly topics = [ShopCreated.topic];
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [
    permissive(ShopCreated),
    permissive(ShopPlanChanged),
    permissive(ShopStatusChanged),
    permissive(ShopDeleted),
  ];
  readonly aggregateIdSchema = uuid;

  constructor(private readonly shops: CompetitorShopService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const sink = counts();
    for (const event of events) {
      switch (event.type) {
        case ShopCreated.type: {
          const p = parseOrReject(
            'competitor-shops',
            event,
            competitorShopCreatedSchema,
          );
          sink[await this.shops.shopCreated(p)]++;
          break;
        }
        case ShopPlanChanged.type: {
          const p = parseOrReject(
            'competitor-shops',
            event,
            competitorShopPlanChangedSchema,
          );
          sink[await this.shops.planChanged(p)]++;
          break;
        }
        case ShopStatusChanged.type: {
          const p = parseOrReject(
            'competitor-shops',
            event,
            competitorShopStatusChangedSchema,
          );
          sink[await this.shops.statusChanged(p)]++;
          break;
        }
        case ShopDeleted.type: {
          const p = parseOrReject(
            'competitor-shops',
            event,
            competitorShopDeletedSchema,
          );
          await this.shops.shopDeleted(p.shopId);
          sink.applied++;
          break;
        }
        default:
          sink.stale++;
      }
    }
    return sink;
  }
}

/** `catalog.product_deleted` -> the product's watches are deleted and unwatched targets retired (S41 FR-030). */
@Injectable()
export class CompetitorProductProjector implements Projector {
  readonly name = 'seller-insights-competitor-products';
  readonly topics = [ProductDeleted.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [permissive(ProductDeleted)];
  readonly aggregateIdSchema = uuid;

  constructor(private readonly shops: CompetitorShopService) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const sink = counts();
    for (const event of events) {
      const p = parseOrReject(
        'competitor-products',
        event,
        competitorProductDeletedSchema,
      );
      await this.shops.productDeleted(p.productId);
      sink.applied++;
    }
    return sink;
  }
}
