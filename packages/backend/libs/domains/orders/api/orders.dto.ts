import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, IsUUID, Max, Min } from 'class-validator';
import { MAX_LINE_QUANTITY } from '../infra/cart.repository';

export class SetCartLineDto {
  @ApiProperty({ minimum: 0, maximum: MAX_LINE_QUANTITY, description: '0 removes the line' })
  @IsInt()
  @Min(0)
  @Max(MAX_LINE_QUANTITY)
  quantity: number;
}

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
