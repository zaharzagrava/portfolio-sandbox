import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class SellerStatsQueryDto {
  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}

export class SellerStatsSummaryDto {
  @ApiProperty({ description: 'Completed revenue in cents' })
  revenueCents: number;

  @ApiProperty()
  orders: number;

  @ApiProperty()
  unitsSold: number;

  @ApiProperty({ description: 'Approximate (HyperLogLog, uniqCombined)' })
  uniqueBuyers: number;

  @ApiProperty()
  refunds: number;

  @ApiProperty()
  avgOrderValueCents: number;
}

export class SellerStatsDailyPointDto {
  @ApiProperty({ example: '2026-09-01' })
  day: string;

  @ApiProperty()
  revenueCents: number;

  @ApiProperty()
  orders: number;
}

export class SellerStatsTopProductDto {
  @ApiProperty()
  productId: string;

  @ApiProperty()
  revenueCents: number;

  @ApiProperty()
  unitsSold: number;
}

export class SellerStatsResponseDto {
  @ApiProperty()
  sellerId: string;

  @ApiProperty()
  days: number;

  @ApiProperty()
  summary: SellerStatsSummaryDto;

  @ApiProperty({ type: [SellerStatsDailyPointDto] })
  daily: SellerStatsDailyPointDto[];

  @ApiProperty({ type: [SellerStatsTopProductDto] })
  topProducts: SellerStatsTopProductDto[];
}
