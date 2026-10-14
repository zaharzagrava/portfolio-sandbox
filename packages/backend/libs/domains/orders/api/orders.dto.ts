import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { SHOP_ORDER_STATUSES } from '@marketplace-sandbox/contracts';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

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
