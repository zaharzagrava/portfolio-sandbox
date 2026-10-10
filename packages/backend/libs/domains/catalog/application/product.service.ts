import { Injectable } from '@nestjs/common';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';
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
 * DEPRECATED compatibility facade for `findById`, `create` and `search`, kept only while other capabilities still call
 * them (removal: with the last importer, listed in `specs/domains/S05-products/gaps.md`). New code uses
 * `ProductCommandService`, `ProductQueryService` and the public read routes. `findById` and `create` are thin adapters
 * over the one read path and the one write path; `search` moves to S32 together with its Elasticsearch dependency.
 */
@Injectable()
export class ProductService {
  constructor(
    private readonly elasticsearchService: ElasticsearchService,
    private readonly commands: ProductCommandService,
    private readonly reads: PublicProductService,
  ) {}

  public async findById(id: string): Promise<ProductDetailDto | null> {
    const view = await this.reads.getById(id);
    return view ? { ...view, price: view.priceMinor } : null;
  }

  public search(query: ProductSearchParams) {
    return this.elasticsearchService.searchProducts({
      q: query.q,
      priceMin: query.priceMin,
      priceMax: query.priceMax,
      ratingMin: query.ratingMin,
      category: query.category,
      brand: query.brand,
      facets: query.facets ?? false,
      semantic: query.semantic ?? false,
      sort: query.sort as never,
      size: query.size ?? 20,
      from: query.from ?? 0,
    });
  }

  public async create(
    params: LegacyCreateProduct,
    sellerId: string,
    shopId?: string,
  ): Promise<{ id: string }> {
    if (!shopId) throw new ProductValidationError(['shopId']);
    const { price, ...rest } = params;
    return this.commands.create(shopId, sellerId, {
      ...rest,
      priceMinor: price,
    });
  }
}
