import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateAuctionDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsString() @MaxLength(140) title: string;
  @ApiProperty() @IsInt() @Min(1) startingPrice: number;
  @ApiProperty() @IsInt() @Min(1) minIncrement: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) reservePrice?: number;
  @ApiProperty() @IsDateString() startsAt: string;
  @ApiProperty() @IsDateString() endsAt: string;
}

export class PlaceBidDto {
  @ApiProperty({ description: 'Your maximum (proxy) bid in minor units; the visible price rises only as needed' })
  @IsInt()
  @Min(1)
  maxAmount: number;
}
