import { Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { ShopQueryService } from '@app/domains/tenancy';
import { feedUnavailable } from '../domain/feed-errors';
import type { FeedShopDirectory, ShopInfo } from '../domain/ports';
import { withTimeout } from '../domain/with-timeout';

/**
 * Anti-corruption adapter over tenancy's exported batch query (S03 R1, IV.8): the only importer of `ShopQueryService`
 * in the feed. Unknown ids are absent; a failure or a timeout is `503 feed_unavailable` (A1), never "not found".
 */
@Injectable()
export class ShopDirectoryAdapter implements FeedShopDirectory {
  private readonly logger = new Logger(ShopDirectoryAdapter.name);

  constructor(
    private readonly shops: ShopQueryService,
    private readonly config: ApiConfigService,
  ) {}

  async lookup(shopIds: string[]): Promise<Map<string, ShopInfo>> {
    if (!shopIds.length) return new Map();
    try {
      const found = await withTimeout(
        this.shops.getShopsByIds(shopIds),
        this.config.get('feed_directory_timeout_ms'),
        () => new Error('directory timeout'),
      );
      return new Map(
        [...found].map(([id, shop]) => [
          id,
          {
            shopId: id,
            name: shop.name,
            status: shop.status,
            isSandbox: shop.isSandbox,
          },
        ]),
      );
    } catch (error) {
      this.logger.warn(`shop lookup failed cause=${(error as Error).name}`);
      throw feedUnavailable();
    }
  }
}
