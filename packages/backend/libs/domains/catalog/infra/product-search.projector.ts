import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op, QueryTypes } from 'sequelize';
import Product from './models/product.model';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { ProductChanged } from '../application/events/product-events';

/**
 * Products read model in Elasticsearch (README #7, SD-37), rebuilt on the F-05
 * framework. Replaces `SearchIndexerService`:
 *  - coalesces a batch to one write per product,
 *  - loads all changed products in ONE query (was N sequential findOne calls),
 *  - indexes with external versioning so a late, older event can't overwrite
 *    a newer document,
 *  - no forced refresh per batch.
 * Reads the current row (not the event payload) on purpose: product events
 * are "something changed" notifications from legacy producers.
 */
@Injectable()
export class ProductSearchProjector implements Projector {
  readonly name = 'search-indexer';
  readonly topics = [ProductChanged.topic];
  // Elasticsearch indexes with the product's own version as the external version: older writes are rejected.
  readonly idempotency = 'versionGuard' as const;
  readonly handles = [{ event: ProductChanged }];
  readonly coalesce = true;

  constructor(
    @InjectModel(Product) private readonly productModel: typeof Product,
    private readonly elasticsearch: ElasticsearchService,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const ids = [...new Set(events.map((e) => e.aggregateId))];
    const all = await this.productModel.findAll({
      where: { id: { [Op.in]: ids } },
      raw: true,
    });
    // SD-07 sandbox shops (test API keys) must never reach public search.
    const sandboxShops = new Set(
      (
        await this.productModel.sequelize!.query<{ id: string }>(
          `SELECT id FROM "Shop" WHERE "sandboxOf" IS NOT NULL AND id IN (:shopIds)`,
          {
            type: QueryTypes.SELECT,
            replacements: {
              shopIds: [
                ...new Set(all.map((p) => p.shopId).filter(Boolean)),
                '00000000-0000-0000-0000-000000000000',
              ],
            },
          },
        )
      ).map((r) => r.id),
    );
    const products = all.filter(
      (p) => !p.shopId || !sandboxShops.has(p.shopId),
    );

    await this.elasticsearch.bulkUpsertProducts(
      products.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        brand: p.brand,
        category: p.category,
        price: Number(p.price),
        rating: p.rating,
        tags: p.tags,
        embedding: p.embedding,
        version: p.version,
        inStock: p.quantity > 0,
        popularity: Number(p.viewCount ?? 0),
        createdAt: p.createdAt,
      })),
      { refresh: false },
    );
  }
}
