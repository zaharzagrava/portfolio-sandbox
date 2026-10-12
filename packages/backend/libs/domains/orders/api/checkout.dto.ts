import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

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

  @ApiPropertyOptional({
    description:
      'Referral code of the buyer (3-64 characters of [A-Za-z0-9_-])',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,64}$/)
  refCode?: string;
}
