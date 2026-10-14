import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Idempotent } from '@app/infrastructure/idempotency';
import { RateLimit } from '@app/infrastructure/rate-limit';
import type { ShopOrderStatus } from '@app/domains/orders';
import { ApiKeyAuth } from './api-key.guard';
import { contextOf, IDEMPOTENT_WIRE } from './api-support';
import {
  CreateProductDto,
  ListOrdersQuery,
  ListProductsQuery,
  UpdateProductDto,
} from './dto';
import { ApiResource, PublicApiInterceptor } from './public-api.interceptor';
import type { ResourceRequest } from './public-api.interceptor';
import { PublicCatalogService } from '../application/public-catalog.service';
import { PublicOrdersService } from '../application/public-orders.service';
import { ApiError } from '../domain/errors';
import { parseIfMatch } from '../domain/request-rules';

const etag = (res: Response, version: number): void => {
  res.setHeader('ETag', `"${version}"`);
};

/**
 * The public API (FR-035…FR-042, apps/public-api): thin adapters from HTTP to the application services. The shop comes
 * only from the key; the version, the headers and the problem documents are the interceptor's, the guards' and the
 * filter's. Bulk stock and the batch have their own controllers.
 */
@ApiTags('public-api')
@ApiBearerAuth()
@UseInterceptors(PublicApiInterceptor)
@Controller('v1')
export class V1Controller {
  constructor(
    private readonly catalog: PublicCatalogService,
    private readonly orders: PublicOrdersService,
  ) {}

  @ApiKeyAuth('products:read')
  @RateLimit('public-api.default')
  @ApiResource('list', 'product')
  @Get('products')
  listProducts(@Req() req: ResourceRequest, @Query() query: ListProductsQuery) {
    return this.catalog.list(contextOf(req), query, req.apiExpand ?? []);
  }

  @ApiKeyAuth('products:read')
  @RateLimit('public-api.default')
  @ApiResource('product')
  @Get('products/:id')
  async getProduct(
    @Req() req: ResourceRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
  ) {
    const product = await this.catalog.get(
      contextOf(req),
      id,
      req.apiExpand ?? [],
    );
    etag(res, product.version);
    return product;
  }

  @ApiKeyAuth('products:write')
  @RateLimit('public-api.default')
  @ApiResource('product', undefined, { upgrade: 'productWrite' })
  @Idempotent({
    required: true,
    scope: (req) =>
      `shop:${(req as ResourceRequest).apiKey?.shopId}:POST /v1/products`,
    wire: IDEMPOTENT_WIRE,
  })
  @Post('products')
  @Header('Cache-Control', 'no-store')
  async createProduct(
    @Req() req: ResourceRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() body: CreateProductDto,
  ) {
    const product = await this.catalog.create(contextOf(req), body);
    res.status(201);
    res.setHeader('Location', `/v1/products/${product.id}`);
    etag(res, product.version);
    return product;
  }

  @ApiKeyAuth('products:write')
  @RateLimit('public-api.default')
  @ApiResource('product', undefined, { upgrade: 'productWrite' })
  @Patch('products/:id')
  async updateProduct(
    @Req() req: ResourceRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() body: UpdateProductDto,
  ) {
    const expectedVersion = parseIfMatch(
      req.headers['if-match'] as string | undefined,
    );
    if (Object.keys(body).length === 0)
      throw new ApiError(
        'validation_failed',
        'At least one field to change is required.',
        {
          errors: [{ field: 'body', code: 'empty' }],
        },
      );
    const product = await this.catalog.update(
      contextOf(req),
      id,
      body,
      expectedVersion,
    );
    etag(res, product.version);
    return product;
  }

  @ApiKeyAuth('products:read')
  @RateLimit('public-api.default')
  @Get('stock/:productId')
  stock(
    @Req() req: Request & ResourceRequest,
    @Param('productId') productId: string,
  ) {
    return this.catalog.stock(contextOf(req), productId);
  }

  /** Deprecated 2026-10-01, sunset 2027-04-01: the announcement and the 410 are the middleware's. */
  @ApiKeyAuth('products:read')
  @RateLimit('public-api.default')
  @Get('products/:id/stock')
  deprecatedStock(@Req() req: ResourceRequest, @Param('id') id: string) {
    return this.catalog.stock(contextOf(req), id);
  }

  @ApiKeyAuth('orders:read')
  @RateLimit('public-api.default')
  @ApiResource('list', 'order')
  @Get('orders')
  listOrders(@Req() req: ResourceRequest, @Query() query: ListOrdersQuery) {
    return this.orders.list(contextOf(req), {
      limit: query.limit,
      cursor: query.cursor,
      status: query.status as ShopOrderStatus | undefined,
    });
  }

  @ApiKeyAuth('orders:read')
  @RateLimit('public-api.default')
  @ApiResource('order')
  @Get('orders/:id')
  getOrder(@Req() req: ResourceRequest, @Param('id') id: string) {
    return this.orders.get(contextOf(req), id);
  }
}
