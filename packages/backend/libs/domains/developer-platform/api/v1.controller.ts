import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { Idempotent } from '@app/infrastructure/idempotency';
import { ApiKeyAuth } from './api-key.guard';
import type { ApiKeyRequest } from './api-key.guard';
import { ApiResource, PublicApiInterceptor } from './public-api.interceptor';
import {
  pickFields,
  PublicCatalogService,
} from '../application/public-catalog.service';
import { PublicOrdersService } from '../application/public-orders.service';

export class CreateProductBody {
  @ApiProperty() @IsString() @Length(1, 200) title: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 10_000)
  description?: string;
  @ApiProperty({ description: 'Minor units (cents)' })
  @IsInt()
  @Min(0)
  price: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) stock?: number;
  @ApiProperty() @IsString() @Length(1, 60) category: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 60)
  brand?: string;
}

export class UpdateProductBody {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 10_000)
  description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) price?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) stock?: number;
}

class StockItem {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsInt() @Min(0) stock: number;
}

export class BulkStockBody {
  @ApiProperty({ type: [StockItem] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => StockItem)
  items: StockItem[];
}

class BatchOperation {
  @ApiProperty({ enum: ['GET', 'POST', 'PATCH'] })
  @IsIn(['GET', 'POST', 'PATCH'])
  method: 'GET' | 'POST' | 'PATCH';
  @ApiProperty({ example: '/v1/products/0190…' })
  @Matches(/^\/v1\/[\w/-]+$/)
  path: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() body?: Record<
    string,
    unknown
  >;
}

export class BatchBody {
  @ApiProperty({ type: [BatchOperation] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BatchOperation)
  operations: BatchOperation[];
}

const expandOf = (expand?: string) =>
  expand ? expand.split(',').map((e) => e.trim()) : [];

/**
 * Public REST API v1 (apps/public-api). Auth = API key only; tenant = the
 * key's shop; POSTs are idempotent with `Idempotency-Key`; responses are
 * shaped for the caller's API version by PublicApiInterceptor.
 */
@ApiTags('public-api v1')
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
  async listProducts(
    @Req() req: ApiKeyRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('expand') expand?: string,
    @Query('fields') fields?: string,
  ) {
    const list = await this.catalog.list(req.shopId!, {
      cursor,
      limit: limit ? Number(limit) : undefined,
      expand: expandOf(expand),
    });
    return { ...list, data: list.data.map((p) => pickFields(p, fields)) };
  }

  @ApiKeyAuth('products:read')
  @RateLimit('public-api.default')
  @ApiResource('product')
  @Get('products/:id')
  async getProduct(
    @Req() req: ApiKeyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('expand') expand?: string,
    @Query('fields') fields?: string,
  ) {
    return pickFields(
      await this.catalog.get(req.shopId!, id, expandOf(expand)),
      fields,
    );
  }

  @ApiKeyAuth('products:write')
  @RateLimit('public-api.default')
  @ApiResource('product')
  @Idempotent({ required: false })
  @Post('products')
  createProduct(@Req() req: ApiKeyRequest, @Body() body: CreateProductBody) {
    return this.catalog.create(req.shopId!, req.apiKey!.createdBy, body);
  }

  @ApiKeyAuth('products:write')
  @RateLimit('public-api.default')
  @ApiResource('product')
  @Idempotent({ required: false })
  @Patch('products/:id')
  updateProduct(
    @Req() req: ApiKeyRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateProductBody,
  ) {
    return this.catalog.update(req.shopId!, id, body);
  }

  /** Deprecated (see DEPRECATED_ROUTES): returns Deprecation/Sunset/Link headers. Use GET /v1/stock/:productId. */
  @ApiKeyAuth('products:read')
  @RateLimit('public-api.default')
  @Get('products/:id/stock')
  async legacyStock(
    @Req() req: ApiKeyRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      product_id: id,
      stock: (await this.catalog.get(req.shopId!, id)).stock,
    };
  }

  @ApiKeyAuth('products:read')
  @RateLimit('public-api.default')
  @Get('stock/:productId')
  async stock(
    @Req() req: ApiKeyRequest,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    const p = await this.catalog.get(req.shopId!, productId);
    return {
      object: 'stock',
      product_id: p.id,
      stock: p.stock,
      updated_at: p.updated_at,
    };
  }

  @ApiKeyAuth('stock:write')
  @RateLimit('public-api.default')
  @Idempotent({ required: false })
  @Post('stock/bulk')
  @HttpCode(202)
  bulkStock(@Req() req: ApiKeyRequest, @Body() body: BulkStockBody) {
    return this.catalog.bulkStock(req.shopId!, body.items);
  }

  @ApiKeyAuth('stock:write')
  @RateLimit('public-api.default')
  @Get('stock/bulk/:jobId')
  bulkStockStatus(@Req() req: ApiKeyRequest, @Param('jobId') jobId: string) {
    return this.catalog.bulkStockStatus(req.shopId!, jobId);
  }

  @ApiKeyAuth('orders:read')
  @RateLimit('public-api.default')
  @ApiResource('list', 'order')
  @Get('orders')
  listOrders(
    @Req() req: ApiKeyRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.orders.list(req.shopId!, cursor, limit ? Number(limit) : 20);
  }

  @ApiKeyAuth('orders:read')
  @RateLimit('public-api.default')
  @ApiResource('order')
  @Get('orders/:id')
  getOrder(@Req() req: ApiKeyRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(req.shopId!, id);
  }

  /**
   * Up to 50 operations in one round trip (04/01 §2.5). Executed in order,
   * each with its own result - not one transaction (a failed op doesn't undo
   * earlier ones; ERPs retry the failed ones with their own Idempotency-Keys).
   * Each op still needs the key's scope for that operation.
   */
  @ApiKeyAuth()
  @RateLimit('public-api.default')
  @Idempotent({ required: false })
  @Post('batch')
  @HttpCode(200)
  async batch(@Req() req: ApiKeyRequest, @Body() body: BatchBody) {
    const results: { status: number; body: unknown }[] = [];
    for (const op of body.operations) {
      try {
        results.push({
          status: op.method === 'POST' ? 201 : 200,
          body: await this.runOperation(req, op),
        });
      } catch (error) {
        const e = error as {
          getStatus?: () => number;
          getResponse?: () => unknown;
          message: string;
        };
        results.push({
          status: e.getStatus?.() ?? 500,
          body: e.getResponse?.() ?? { message: 'Internal error' },
        });
      }
    }
    return { object: 'batch', results };
  }

  private runOperation(req: ApiKeyRequest, op: BatchOperation) {
    const scopes = req.apiKey!.scopes;
    const need = (scope: (typeof scopes)[number]) => {
      if (!scopes.includes(scope))
        throw new BadRequestException({
          type: 'insufficient_scope',
          message: `Key lacks scope ${scope}`,
        });
    };
    const product = /^\/v1\/products\/([0-9a-f-]{36})$/.exec(op.path);
    if (op.method === 'GET' && product)
      return (need('products:read'), this.catalog.get(req.shopId!, product[1]));
    if (op.method === 'PATCH' && product)
      return (
        need('products:write'),
        this.catalog.update(req.shopId!, product[1], op.body ?? {})
      );
    if (op.method === 'POST' && op.path === '/v1/products')
      return (
        need('products:write'),
        this.catalog.create(
          req.shopId!,
          req.apiKey!.createdBy,
          op.body as unknown as CreateProductBody,
        )
      );
    throw new BadRequestException({
      type: 'unsupported_operation',
      message: `${op.method} ${op.path} is not batchable`,
    });
  }
}
