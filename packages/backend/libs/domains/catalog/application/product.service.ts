import { Injectable } from '@nestjs/common';
import { ProductValidationError } from '../domain/product-errors';
import { ProductCommandService } from './product-command.service';
import { PublicProductService } from './public-product.service';

/** Legacy shapes the sibling capabilities still read through this facade (`gaps.md` section C). */
export interface ProductSearchParams {
  q?: string;
  priceMin?: number;
  priceMax?: number;
  ratingMin?: number;
  category?: string;
  brand?: string;
  facets?: boolean;
  semantic?: boolean;
  sort?: string;
  size?: number;
  from?: number;
}

const LEGACY_EMPTY_BRAND = 'Unbranded';

export interface LegacyCreateProduct {
  title: string;
  description?: string;
  brand: string;
  category: string;
  /** Minor units (the legacy field name). */
  price: number;
  tags?: string[];
  quantity?: number;
}

export interface ProductDetailDto {
  id: string;
  shopId: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  /** Legacy name of `priceMinor`. */
  price: number;
  priceMinor: number;
  rating: number;
  tags: string[];
  inStock: boolean;
  version: number;
  viewCount: number;
}

/**
 * DEPRECATED compatibility facade for `findById` and `create`, kept only while other capabilities still call them
 * (removal: with the last importer, listed in `specs/domains/S05-products/gaps.md`). New code uses
 * `ProductCommandService`, `ProductQueryService` and the public read routes. Both are thin adapters over the one read
 * path and the one write path; search lives in S32 and the catalog no longer touches Elasticsearch.
 */
@Injectable()
export class ProductService {
  constructor(
    private readonly commands: ProductCommandService,
    private readonly reads: PublicProductService,
  ) {}

  public async findById(id: string): Promise<ProductDetailDto | null> {
    const view = await this.reads.getById(id);
    return view ? { ...view, price: view.priceMinor } : null;
  }

  public async create(
    params: LegacyCreateProduct,
    sellerId: string,
    shopId?: string,
  ): Promise<{ id: string }> {
    if (!shopId) throw new ProductValidationError(['shopId']);
    const { price, brand, ...rest } = params;
    return this.commands.create(shopId, sellerId, {
      ...rest,
      // Legacy callers (public API) allowed an empty brand; the catalog contract needs 1 to 100 characters.
      brand: brand.trim() === '' ? LEGACY_EMPTY_BRAND : brand,
      priceMinor: price,
    });
  }
}
