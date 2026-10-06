import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { ProductModel as Product } from '@app/domains/catalog';
import { ElasticsearchService, PRODUCTS_INDEX } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { UpsertProductDocument } from '@app/infrastructure/elasticsearch/types';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'search.reindex-products': { batchSize?: number };
  }
}

const toDoc = (p: Product): UpsertProductDocument => ({
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
});

/**
 * Zero-downtime full reindex (lesson 10/09 #37):
 *   T0 → build products_v<ts> from Postgres (keyset batches, external versions)
 *      → ONE atomic _aliases call moves `products` to the new index (removing the
 *        old one, even a pre-alias concrete `products` index)
 *      → catch-up: re-index every product updated since T0 (the live projector
 *        kept writing to the OLD index while we built) - versions make overlaps harmless
 *      → delete superseded indices except the previous one (instant rollback).
 * Search keeps answering from the old index the whole time.
 */
@Injectable()
export class SearchReindexService {
  private readonly logger = new Logger(SearchReindexService.name);

  constructor(
    @InjectModel(Product) private readonly productModel: typeof Product,
    private readonly es: ElasticsearchService,
  ) {}

  @JobHandler('search.reindex-products', { concurrency: 1, leaseMs: 3_600_000 })
  async reindex({ batchSize = 1_000 }: { batchSize?: number } = {}): Promise<{ index: string; documents: number }> {
    const client = this.es.getClient();
    await this.es.ensureSynonymsSet();
    const target = `${PRODUCTS_INDEX}_v${Date.now()}`;
    const definition = this.es.productsIndexDefinition();
    // Bulk-load mode: no refreshes, no replicas while building.
    await client.indices.create({ index: target, mappings: definition.mappings, settings: { ...definition.settings, refresh_interval: '-1', number_of_replicas: 0 } } as Parameters<typeof client.indices.create>[0]);

    const t0 = new Date();
    let documents = 0;
    let lastId: string | undefined;
    for (;;) {
      const batch = await this.productModel.findAll({ where: lastId ? { id: { [Op.gt]: lastId } } : {}, order: [['id', 'ASC']], limit: batchSize });
      if (batch.length === 0) break;
      await this.bulk(target, batch.map(toDoc));
      documents += batch.length;
      lastId = batch[batch.length - 1].id;
    }

    // Bulk-load settings off → serving settings on before taking traffic.
    await client.indices.putSettings({ index: target, settings: { refresh_interval: '5s', number_of_replicas: 1 } });
    await client.indices.refresh({ index: target });

    const previous = await this.currentIndices();
    await client.indices.updateAliases({
      actions: [
        ...previous.filter((i) => i.isAlias).map((i) => ({ remove: { index: i.name, alias: PRODUCTS_INDEX } })),
        ...previous.filter((i) => !i.isAlias).map((i) => ({ remove_index: { index: i.name } })),
        { add: { index: target, alias: PRODUCTS_INDEX, is_write_index: true } },
      ],
    });

    const changed = await this.productModel.findAll({ where: { updatedAt: { [Op.gte]: t0 } } });
    if (changed.length) await this.bulk(target, changed.map(toDoc));

    const old = (await client.indices.get({ index: `${PRODUCTS_INDEX}_v*` })) ?? {};
    const stale = Object.keys(old).filter((name) => name !== target).sort().slice(0, -1); // keep one previous for rollback
    if (stale.length) await client.indices.delete({ index: stale });

    this.logger.log(`reindexed ${documents} products into ${target} (+${changed.length} catch-up)`);
    return { index: target, documents };
  }

  private async bulk(index: string, docs: UpsertProductDocument[]) {
    const operations = docs.flatMap((d): object[] => {
      const { id, version, ...source } = d;
      return [{ index: { _index: index, _id: id, version, version_type: 'external_gte' as const } }, source];
    });
    const res = await this.es.getClient().bulk({ operations, refresh: false });
    const failed = res.items.filter((i) => i.index?.error && i.index.error.type !== 'version_conflict_engine_exception');
    if (failed.length) throw new Error(`reindex bulk: ${failed.length} failures`);
  }

  private async currentIndices(): Promise<{ name: string; isAlias: boolean }[]> {
    const client = this.es.getClient();
    if (await client.indices.existsAlias({ name: PRODUCTS_INDEX })) {
      return Object.keys(await client.indices.getAlias({ name: PRODUCTS_INDEX })).map((name) => ({ name, isAlias: true }));
    }
    return (await client.indices.exists({ index: PRODUCTS_INDEX })) ? [{ name: PRODUCTS_INDEX, isAlias: false }] : [];
  }
}
