import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

/** Body of `POST /checkout` (contract: `checkoutRequestSchema`). Unknown properties are rejected globally. */
export class CheckoutRequestDto {
  @ApiPropertyOptional({
    description:
      'The total the buyer was shown; a different server total answers 409 price_changed',
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedTotalMinor?: number;
}
