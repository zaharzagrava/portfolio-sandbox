import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { ProductModel as Product } from '@app/domains/catalog';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { boughtTogetherKey } from '../infra/recommendation-keys';

export interface Recommendation {
  productId: string;
  title: string;
  price: number;
  score: number;
  /** 1 = bought together directly; 2 = via a neighbour (cold-start expansion). */
  hops: 1 | 2;
}

const HOP_DECAY = 0.5;
const EXPAND_FROM = 5;

/**
 * Read path: one ZREVRANGE (sub-ms) per product page. Products with few direct
 * edges (new / niche) get a depth-2 BFS over the precomputed graph: neighbours
 * of the top-5 neighbours, score = s1 · s2 · decay, best path wins. Bounded:
 * at most 1 + 5 ZSET reads, one pipeline round-trip.
 */
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly redis: RedisService,
    @InjectModel(Product) private readonly productModel: typeof Product,
  ) {}

  async boughtTogether(productId: string, limit = 8): Promise<Recommendation[]> {
    const direct = await this.neighbours(productId, limit * 2);
    const scored = new Map<string, { score: number; hops: 1 | 2 }>(direct.map((n) => [n.id, { score: n.score, hops: 1 }]));

    if (direct.length < limit) {
      const seeds = direct.slice(0, EXPAND_FROM);
      const pipeline = this.redis.client.pipeline();
      for (const seed of seeds) pipeline.zrevrange(boughtTogetherKey(seed.id), 0, limit - 1, 'WITHSCORES');
      const results = (await pipeline.exec()) ?? [];
      results.forEach(([error, flat], i) => {
        if (error) return;
        for (const n of pairs(flat as string[])) {
          if (n.id === productId || scored.get(n.id)?.hops === 1) continue;
          const score = seeds[i].score * n.score * HOP_DECAY;
          if (score > (scored.get(n.id)?.score ?? 0)) scored.set(n.id, { score, hops: 2 });
        }
      });
    }

    const ranked = [...scored.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
    // Hydrate + drop anything out of stock or deleted since the nightly build.
    const products = new Map(
      (
        await this.productModel.findAll({
          where: { id: { [Op.in]: ranked.slice(0, limit * 2).map(([id]) => id) }, quantity: { [Op.gt]: 0 } },
          attributes: ['id', 'title', 'price'],
          raw: true,
        })
      ).map((p) => [p.id, p]),
    );
    return ranked
      .filter(([id]) => products.has(id))
      .slice(0, limit)
      .map(([id, { score, hops }]) => ({ productId: id, title: products.get(id)!.title, price: Number(products.get(id)!.price), score: Math.round(score * 1e4) / 1e4, hops }));
  }

  private async neighbours(productId: string, count: number) {
    return pairs(await this.redis.client.zrevrange(boughtTogetherKey(productId), 0, count - 1, 'WITHSCORES'));
  }
}

function pairs(flat: string[]): { id: string; score: number }[] {
  const out: { id: string; score: number }[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ id: flat[i], score: Number(flat[i + 1]) });
  return out;
}
