import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
  ValidateNested,
} from 'class-validator';
import {
  PRODUCT_LIMITS,
  SHOP_ORDER_STATUSES,
} from '@marketplace-sandbox/contracts';

export class MoneyDto {
  @ApiProperty({ description: 'Minor units' })
  @IsInt()
  @Min(PRODUCT_LIMITS.priceMinor.min)
  @Max(PRODUCT_LIMITS.priceMinor.max)
  amount: number;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency: string;
}

/** `POST /v1/products` at the latest version; an older version's body is upgraded to this before validation. */
export class CreateProductDto {
  @ApiProperty()
  @IsString()
  @Length(PRODUCT_LIMITS.title.min, PRODUCT_LIMITS.title.max)
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(PRODUCT_LIMITS.description.max)
  description?: string;

  @ApiProperty({ type: MoneyDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  price: MoneyDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(PRODUCT_LIMITS.quantity.min)
  @Max(PRODUCT_LIMITS.quantity.max)
  stock?: number;

  @ApiProperty()
  @IsString()
  @Length(PRODUCT_LIMITS.category.min, PRODUCT_LIMITS.category.max)
  category: string;

  @ApiProperty()
  @IsString()
  @Length(PRODUCT_LIMITS.brand.min, PRODUCT_LIMITS.brand.max)
  brand: string;
}

export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(PRODUCT_LIMITS.title.min, PRODUCT_LIMITS.title.max)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(PRODUCT_LIMITS.description.max)
  description?: string;

  @ApiPropertyOptional({ type: MoneyDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MoneyDto)
  price?: MoneyDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(PRODUCT_LIMITS.quantity.min)
  @Max(PRODUCT_LIMITS.quantity.max)
  stock?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(PRODUCT_LIMITS.category.min, PRODUCT_LIMITS.category.max)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(PRODUCT_LIMITS.brand.min, PRODUCT_LIMITS.brand.max)
  brand?: string;
}

/** `limit` 1…100, no silent clamping (FR-036). */
export class PageQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 512)
  cursor?: string;

  /** Read by the interceptor, which owns the parsing (FR-027, FR-037); declared so the strict pipe accepts them. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fields?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  expand?: string;
}

export class ListProductsQuery extends PageQuery {}

export class ListOrdersQuery extends PageQuery {
  @ApiPropertyOptional({ enum: SHOP_ORDER_STATUSES })
  @IsOptional()
  @IsIn(SHOP_ORDER_STATUSES)
  status?: string;
}

// ---------------------------------------------------------------- bulk stock and batch

export class BulkItemDto {
  @ApiProperty()
  @IsString()
  @Length(1, 128)
  operationId: string;

  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ description: 'Non-zero integer, |delta| <= 1,000,000' })
  @IsInt()
  @Min(-PRODUCT_LIMITS.stockDelta.max)
  @Max(PRODUCT_LIMITS.stockDelta.max)
  @NotEquals(0)
  delta: number;
}

export class BulkStockDto {
  @ApiProperty({ type: [BulkItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10_000)
  @ArrayUnique((i: BulkItemDto) => i.operationId)
  @ValidateNested({ each: true })
  @Type(() => BulkItemDto)
  items: BulkItemDto[];
}

export class BatchOperationDto {
  @ApiProperty({ enum: ['GET', 'POST', 'PATCH'] })
  @IsIn(['GET', 'POST', 'PATCH'])
  method: 'GET' | 'POST' | 'PATCH';

  @ApiProperty({ example: '/v1/products/0190…' })
  @Matches(/^\/v1\/[\w/-]+$/)
  path: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  body?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ifMatch?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 255)
  idempotencyKey?: string;
}

export class BatchDto {
  @ApiProperty({ type: [BatchOperationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BatchOperationDto)
  operations: BatchOperationDto[];
}
