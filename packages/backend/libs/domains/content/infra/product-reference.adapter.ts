import { Inject, Injectable } from '@nestjs/common';
import { ProductQueryService } from '@app/domains/catalog';
import type { ProductReferenceChecker } from '../domain/ports';
import type { StoryConfig } from '../domain/limits';
import { STORY_CONFIG } from '../application/story-config.token';
import { withTimeout } from '../application/with-timeout';

/**
 * Product references of a story, checked through S05's exported batch query with the shop filter (R1, B3): one call, other
 * shops' ids absent, an archived product present. 2 s timeout; a failure or timeout is raised to the caller, who fails
 * closed (`503 dependency_unavailable`).
 */
@Injectable()
export class CatalogProductReferenceChecker implements ProductReferenceChecker {
  constructor(
    private readonly products: ProductQueryService,
    @Inject(STORY_CONFIG) private readonly config: StoryConfig,
  ) {}

  async missing(shopId: string, productIds: string[]): Promise<string[]> {
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return [];
    const found = await withTimeout(
      this.products.getProductsByIds(ids, { shopId }),
      this.config.dependencyTimeoutMs,
    );
    return ids.filter((id) => !found.has(id.toLowerCase()) && !found.has(id));
  }
}
