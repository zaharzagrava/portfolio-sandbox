import { Inject, Injectable } from '@nestjs/common';
import { ShopQueryService } from '@app/domains/tenancy';
import type { ShopCopy, ShopLookup } from '../domain/ports';
import type { StoryConfig } from '../domain/limits';
import { STORY_CONFIG } from '../application/story-config.token';
import { withTimeout } from '../application/with-timeout';

/**
 * The single write-path lookup of a shop that has no copy yet (S27 FR-062): S03's exported batch query (R1), 2 s timeout.
 * The result is used once; the copy itself is only ever written by its consumer.
 */
@Injectable()
export class TenancyShopLookup implements ShopLookup {
  constructor(
    private readonly shops: ShopQueryService,
    @Inject(STORY_CONFIG) private readonly config: StoryConfig,
  ) {}

  async get(shopId: string): Promise<ShopCopy | null> {
    const found = await withTimeout(
      this.shops.getShopsByIds([shopId]),
      this.config.dependencyTimeoutMs,
    );
    const shop = found.get(shopId);
    return shop
      ? {
          shopId: shop.id,
          slug: shop.slug,
          status: shop.status,
          shopVersion: shop.shopVersion,
        }
      : null;
  }
}
