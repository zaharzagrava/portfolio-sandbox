import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { ProductModel as Product } from '@app/domains/catalog';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { AVAILABILITY_INDEX } from './availability-index';
import { PickupStockChanged } from '../application/events/pickup-events';

/**
 * PickupStock changes → availability index (D26). Coalesced per
 * (point, product) - a burst of 30 stock edits during a sale is ONE write.
 * External versioning: a late, older event can't resurrect stock that's gone;
 * quantity 0 deletes the doc (deletes are versioned too).
 */
@Injectable()
export class PickupAvailabilityProjector implements Projector {
  readonly name = 'pickup-availability';
  readonly topics = [PickupStockChanged.topic];
  // Elasticsearch external versioning with the aggregate version: older and equal writes are rejected.
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [{ event: PickupStockChanged }];
  readonly coalesce = true;

  constructor(
    @InjectModel(Product) private readonly productModel: typeof Product,
    private readonly es: SearchEngineClient,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const changes = events
      .map((e) => PickupStockChanged.match(e))
      .filter((e): e is NonNullable<typeof e> => !!e);
    if (changes.length === 0) return;
    const products = new Map(
      (
        await this.productModel.findAll({
          where: {
            id: {
              [Op.in]: [...new Set(changes.map((c) => c.payload.productId))],
            },
          },
          attributes: ['id', 'title', 'category', 'price'],
          raw: true,
        })
      ).map((p) => [p.id, p]),
    );

    const operations = changes.flatMap((c): object[] => {
      const product = products.get(c.payload.productId);
      const meta = {
        _index: AVAILABILITY_INDEX,
        _id: c.aggregateId,
        version: c.aggregateVersion,
        version_type: 'external_gte' as const,
      };
      if (!product || c.payload.quantity <= 0) return [{ delete: meta }];
      return [
        { index: meta },
        {
          productId: product.id,
          pickupPointId: c.payload.pickupPointId,
          shopId: c.payload.shopId,
          title: product.title,
          category: product.category,
          price: Number(product.price),
          quantity: c.payload.quantity,
          location: { lat: c.payload.lat, lon: c.payload.lng },
        },
      ];
    });
    const res = await this.es.getClient().bulk({ operations, refresh: false });
    const failures = res.items.filter((i) => {
      const r = i.index ?? i.delete;
      return (
        r?.error &&
        r.error.type !== 'version_conflict_engine_exception' &&
        r.status !== 404
      );
    });
    if (failures.length)
      throw new Error(`pickup availability bulk: ${failures.length} failures`);
  }
}
