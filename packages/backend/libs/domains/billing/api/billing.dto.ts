import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SubscribeDto {
  @ApiProperty() @IsUUID() priceId: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity?: number;
  @ApiPropertyOptional({ description: 'Stripe PaymentMethod id' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  paymentMethodRef?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  trialDays?: number;
}

export class ChangeSubscriptionDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() priceId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity?: number;
}
