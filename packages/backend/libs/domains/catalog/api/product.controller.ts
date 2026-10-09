import {
  Body,
  Get,
  Logger,
  Post,
  Query,
  Controller,
  Param,
  ParseUUIDPipe,
  UseInterceptors,
  Optional,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { SearchQueryLogger } from '@app/domains/discovery';
import { VersionEtagInterceptor } from '@app/infrastructure/cache/etag.interceptor';
import { NotFoundError } from '@app/common/errors';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ProductService } from '../application/product.service';
import { RateLimit } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { ShopScoped } from '@app/domains/tenancy';
import { CreateProductDto, SearchProductsQueryDto } from './product.dto';

@ApiTags('products')
@Controller('products')
export class ProductController {
  private readonly l = new Logger(ProductController.name);

  constructor(
    private readonly productService: ProductService,
    @Optional() private readonly queryLogger?: SearchQueryLogger,
  ) {}

  /**
   * Elasticsearch showcase (#7–11): fuzzy + BM25 boosts + autocomplete
   * suggestions + range/facet filters + optional semantic k-NN.
   *
   * Example: GET /api/products/search?q=iphne&facets=true
   * Example: GET /api/products/search?q=winter%20coat&semantic=true
   */
  @Firewall({ anonymous: true })
  @RateLimit('search.query')
  @Get('search')
  async search(
    @Query() query: SearchProductsQueryDto,
    @Req() req: Request & { user?: { id: string } },
  ) {
    const result = await this.productService.search(query);
    // SD-12: query popularity feeds autocomplete (fire-and-forget, never slows the search).
    this.queryLogger?.log(
      query.q,
      result.total ?? result.hits?.length ?? 0,
      req.user?.id ?? req.ip ?? 'anon',
    );
    return result;
  }

  /**
   * Product detail (SD-34): L1/L2 cache-aside with SWR, negative caching,
   * stampede protection; ETag/304 from the product version.
   */
  @Firewall({ anonymous: true })
  @RateLimit('search.query')
  @UseInterceptors(VersionEtagInterceptor)
  @Get(':id')
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    const product = await this.productService.findById(id);
    if (!product) throw new NotFoundError(`Product ${id} not found`);
    return product;
  }

  /**
   * Creates a product and writes an Outbox row (topic: products.events) in
   * the same transaction — the mailman drains it, the search projector (apps/projector) picks it up
   * and bulk-indexes it into Elasticsearch. The authenticated caller becomes
   * the product's seller (see ChatService#createChannel for why this matters).
   */
  /** SD-02: tenant-scoped creation - any STAFF+ member of the shop, product owned by the shop. */
  @ShopScoped('products.write')
  @Post('/shops/:shopId')
  async createForShop(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: UserRawDto,
    @Body() body: CreateProductDto,
  ) {
    return this.productService.create(body, user.id, shopId);
  }

  @Firewall()
  @Post()
  async create(@User() user: UserRawDto, @Body() body: CreateProductDto) {
    return this.productService.create(body, user.id);
  }
}
