import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { CART_LIMITS } from '@marketplace-sandbox/contracts';

/** Body of `PUT /cart/items/:productId` (contract: `setCartLineRequestSchema`). Unknown properties are rejected globally. */
export class SetCartLineDto {
  @ApiProperty({
    minimum: 0,
    maximum: CART_LIMITS.maxQuantity,
    description: '0 removes the line',
  })
  @IsInt()
  @Min(0)
  @Max(CART_LIMITS.maxQuantity)
  quantity!: number;
}
