import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { SHOP_ORDER_STATUSES } from '@marketplace-sandbox/contracts';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CreateFlashSaleDto {
  @ApiProperty()
  @IsUUID()
  productId: string;

  @ApiProperty({ description: 'Drop price in minor units' })
  @IsInt()
  @Min(1)
  price: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  units: number;

  @ApiProperty({ default: 16 })
  @IsInt()
  @Min(1)
  @Max(256)
  buckets: number = 16;

  @ApiProperty({ default: 2 })
  @IsInt()
  @Min(1)
  @Max(20)
  perUserLimit: number = 2;

  @ApiProperty()
  @IsDateString()
  startsAt: string;

  @ApiProperty()
  @IsDateString()
  endsAt: string;
}

export class ListOrdersQueryDto {
  @ApiProperty({ required: false, default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class ListShopOrdersQueryDto extends ListOrdersQueryDto {
  @ApiProperty({ required: false, enum: SHOP_ORDER_STATUSES })
  @IsOptional()
  @IsIn(SHOP_ORDER_STATUSES)
  status?: (typeof SHOP_ORDER_STATUSES)[number];
}
