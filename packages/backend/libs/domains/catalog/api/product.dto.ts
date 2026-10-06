import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ArrayMaxSize,
} from 'class-validator';
import { IntersectionType } from '@nestjs/swagger';
import { IdField, TimestampsFields } from '@app/common/types';

export class CreateProductDto {
  @ApiProperty()
  @IsString()
  title: string;

  @ApiProperty()
  @IsString()
  description: string;

  @ApiProperty()
  @IsString()
  brand: string;

  @ApiProperty()
  @IsString()
  category: string;

  @ApiProperty({ description: 'Price in cents' })
  @IsInt()
  @Min(0)
  price: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(32)
  tags?: string[];

  @ApiPropertyOptional({ description: 'Stock quantity', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;
}

export class ProductRawDto extends IntersectionType(
  CreateProductDto,
  IntersectionType(TimestampsFields, IdField),
) {
  @ApiProperty({ description: 'OCC version for stock updates' })
  version: number;
}

export class SearchProductsQueryDto {
  @ApiPropertyOptional({ description: 'Search text (typos OK)' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'Min price in cents' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMin?: number;

  @ApiPropertyOptional({ description: 'Max price in cents' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMax?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  ratingMin?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional({ description: 'Include facet aggregations' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  facets?: boolean;

  @ApiPropertyOptional({ description: 'Use dense-vector k-NN instead of lexical search' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  semantic?: boolean;

  @ApiPropertyOptional({ description: 'Sort criteria', enum: ['relevance', 'price-asc', 'price-desc', 'newest'] })
  @IsOptional()
  @IsString()
  sort?: 'relevance' | 'price-asc' | 'price-desc' | 'newest';

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  from?: number;
}

export class SearchProductsResponseDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  hits: {
    id: string;
    score: number;
    source: Record<string, any>;
  }[];

  @ApiProperty({ type: [String] })
  suggestions: string[];

  @ApiPropertyOptional()
  facets?: {
    categories: { key: string; count: number }[];
    brands: { key: string; count: number }[];
    priceRanges: { key: string; count: number }[];
    avgRating: number | null;
  };
}

export class ListProductsResponseDto {
  @ApiProperty()
  products: ProductRawDto[];
}
