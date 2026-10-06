import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';

export interface ShopProductHit {
  id: string;
  title: string;
  price: number;
  quantity: number;
  rank: number;
}

/**
 * Shop-admin catalog search on Postgres (no ES): scoped to one shop, read-your-
 * writes fresh, typo-tolerant via trigram similarity when full-text finds
 * nothing. Uses the `Product_search_vector_gin` and `Product_title_trgm` indexes.
 */
@Injectable()
export class ShopProductSearchService {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async search(shopId: string, q: string, limit = 25): Promise<ShopProductHit[]> {
    if (!q.trim()) {
      // No query: the shop's inventory, newest first (the seller's product list).
      return this.sequelize.query<ShopProductHit>(
        `SELECT id, title, price::float AS price, quantity, 0 AS rank FROM "Product" WHERE "shopId" = :shopId ORDER BY "createdAt" DESC LIMIT :limit`,
        { type: QueryTypes.SELECT, replacements: { shopId, limit } },
      );
    }
    const fts = await this.sequelize.query<ShopProductHit>(
      `SELECT id, title, price::float AS price, quantity, ts_rank_cd("searchVector", query) AS rank
       FROM "Product", websearch_to_tsquery('simple', :q) query
       WHERE "shopId" = :shopId AND "searchVector" @@ query
       ORDER BY rank DESC, "updatedAt" DESC
       LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { shopId, q, limit } },
    );
    if (fts.length > 0) return fts;

    // Fallback for typos ("iphnoe cse"): per-word trigram match. Whole-phrase similarity drops below any useful
    // threshold once every word has a typo, so each query word is scored against its best-matching title word
    // and the average must clear 0.3. A scan of one shop's products - fine for the seller admin.
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (tokens.length === 0) return [];
    return this.sequelize.query<ShopProductHit>(
      `SELECT p.id, p.title, p.price::float AS price, p.quantity, s.rank
       FROM "Product" p
       CROSS JOIN LATERAL (SELECT avg(word_similarity(t, p.title)) AS rank FROM unnest(CAST(:tokens AS text[])) t) s
       WHERE p."shopId" = :shopId AND s.rank >= 0.3
       ORDER BY s.rank DESC
       LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { shopId, tokens: `{${tokens.map((t) => `"${t.replace(/["\\]/g, '')}"`).join(',')}}`, limit } },
    );
  }
}
