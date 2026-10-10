import { Inject, Injectable } from '@nestjs/common';
import { SHOP_REPOSITORY, type ShopRepository } from '../domain/ports';
import { Domain_TooManyIdsError } from '../domain/errors';
import { toShopSummary, type ShopSummaryDto } from './shop-summary';

export const SHOP_QUERY_MAX_IDS = 500;

/**
 * The way other capabilities read shops (R1, FR-070): a batch by id returning summaries, never the table. Suspended and
 * tombstoned shops are included with their status so a caller can tell "closed" from "never existed".
 */
@Injectable()
export class ShopQueryService {
  constructor(
    @Inject(SHOP_REPOSITORY) private readonly shops: ShopRepository,
  ) {}

  /** One query; unknown ids are absent, duplicates collapse. */
  async getShopsByIds(ids: string[]): Promise<Map<string, ShopSummaryDto>> {
    const unique = [...new Set(ids)];
    if (unique.length > SHOP_QUERY_MAX_IDS)
      throw new Domain_TooManyIdsError(SHOP_QUERY_MAX_IDS);
    const found = await this.shops.findByIds(unique);
    return new Map(found.map((s) => [s.id, toShopSummary(s)]));
  }
}
