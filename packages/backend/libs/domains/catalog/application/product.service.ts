import { Injectable, Logger } from '@nestjs/common';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { DbUtilsService } from '@app/infrastructure/database/db-utils/db-utils.service';
import { ProductDtoService } from '../infra/product-dto.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { productChanged } from './events/product-events';
import { InjectModel } from '@nestjs/sequelize';
import Product from '../infra/models/product.model';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { WriteBehindCounter } from '@app/infrastructure/cache/write-behind-counter';
import {
  PRODUCT_VIEWS_COUNTER,
  ProductDetailDto,
  productCacheKey,
} from '../infra/product-cache';
import {
  CreateProductDto,
  ProductRawDto,
  SearchProductsQueryDto,
  SearchProductsResponseDto,
} from '../api/product.dto';

@Injectable()
export class ProductService {
  private readonly l = new Logger(ProductService.name);

  constructor(
    private readonly elasticsearchService: ElasticsearchService,
    private readonly dbUtilsService: DbUtilsService,
    private readonly productDtoService: ProductDtoService,
    private readonly outboxService: OutboxService,
    private readonly cache: CacheService,
    private readonly redis: RedisService,
    @InjectModel(Product) private readonly productModel: typeof Product,
  ) {
    this.views = new WriteBehindCounter(this.redis, PRODUCT_VIEWS_COUNTER);
  }

  private readonly views: WriteBehindCounter;

  /**
   * Product detail (SD-34): cache-aside with SWR + negative caching in front
   * of Postgres; invalidated by product events (ProductCacheInvalidator in
   * apps/projector). The view is counted write-behind - no DB write per view.
   */
  public async findById(id: string): Promise<ProductDetailDto | null> {
    const product = await this.cache.getOrLoad<ProductDetailDto>(
      productCacheKey(id),
      async () => {
        const row = await this.productModel.findByPk(id, {
          raw: true,
          attributes: [
            'id',
            'sellerId',
            'title',
            'description',
            'brand',
            'category',
            'price',
            'rating',
            'tags',
            'quantity',
            'version',
            'viewCount',
          ],
        });
        return row
          ? {
              ...row,
              price: Number(row.price),
              viewCount: Number(row.viewCount),
              inStock: row.quantity > 0,
            }
          : null;
      },
      { ttlMs: 60_000, swrMs: 5 * 60_000, negativeTtlMs: 10_000 },
    );

    if (product) void this.views.increment(id).catch(() => undefined);
    return product;
  }

  public async search(
    query: SearchProductsQueryDto,
  ): Promise<SearchProductsResponseDto> {
    return this.elasticsearchService.searchProducts({
      q: query.q,
      priceMin: query.priceMin,
      priceMax: query.priceMax,
      ratingMin: query.ratingMin,
      category: query.category,
      brand: query.brand,
      facets: query.facets ?? false,
      semantic: query.semantic ?? false,
      sort: query.sort,
      size: query.size ?? 20,
      from: query.from ?? 0,
    });
  }

  public async create(
    params: CreateProductDto,
    sellerId: string,
    shopId?: string,
  ): Promise<ProductRawDto> {
    return await this.dbUtilsService.wrapInTransaction(async (tx) => {
      const product = await this.productDtoService.create({
        params: {
          title: params.title,
          description: params.description,
          brand: params.brand,
          category: params.category,
          price: params.price,
          rating: params.rating ?? 0,
          tags: params.tags ?? [],
          quantity: params.quantity ?? 0,
          sellerId,
          ...(shopId && { shopId }),
        },
        tx,
      });

      await this.outboxService.append(productChanged(product.id), tx);

      return product as unknown as ProductRawDto;
    });
  }
}
