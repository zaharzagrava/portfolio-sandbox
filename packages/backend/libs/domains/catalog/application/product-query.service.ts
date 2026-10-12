import { Inject, Injectable } from '@nestjs/common';
import { PRODUCT_LIMITS } from '@marketplace-sandbox/contracts';
import { PRODUCT_REPOSITORY, type ProductRepository } from '../domain/ports';
import { ProductValidationError } from '../domain/product-errors';
import { isUuid } from '../domain/product-input';
import { toProductDto, type ProductDto } from '../domain/product-view';

/**
 * Product facts for other capabilities (R1). Reads the database, never the cache: price and stock that decide money
 * must not come from an entry that is stale by design. One statement for up to 500 ids.
 */
@Injectable()
export class ProductQueryService {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
  ) {}

  /**
   * Whether the product is shown to the public (ACTIVE, not sandbox, shop active). Counts no view and fills no cache;
   * for read paths of other capabilities that must answer a hidden product like an unknown one. A non-UUID is `false`.
   */
  async isPubliclyVisible(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    return (
      (await this.products.findVisibleByIds([id.toLowerCase()])).length > 0
    );
  }

  /**
   * Unknown ids are absent, duplicates collapse, `[]` is an empty map without a statement. With `{shopId}` only that
   * shop's products are returned (the ownership check of the caller). More than 500 ids or a non-UUID is refused.
   */
  async getProductsByIds(
    ids: string[],
    options: { shopId?: string } = {},
  ): Promise<Map<string, ProductDto>> {
    if (
      !Array.isArray(ids) ||
      ids.length > PRODUCT_LIMITS.idsPerQuery ||
      !ids.every(isUuid) ||
      (options.shopId !== undefined && !isUuid(options.shopId))
    )
      throw new ProductValidationError(['ids']);
    const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
    if (unique.length === 0) return new Map();
    const found = await this.products.findByIds(unique, options.shopId);
    return new Map(found.map((p) => [p.id, toProductDto(p)]));
  }
}
