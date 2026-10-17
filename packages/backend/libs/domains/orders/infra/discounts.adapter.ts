import { Injectable } from '@nestjs/common';
import { DiscountEvaluationService } from '@app/domains/shop-functions';
import type { DiscountLine, ShopDiscountsPort } from '../domain/ports';

/**
 * Seller discounts from `shop-functions` (S45, R1): one integer amount per shop for the cart. The service never rejects;
 * the caller still applies its own time box, validates the amounts and counts every fallback.
 */
@Injectable()
export class ShopFunctionsDiscountsAdapter implements ShopDiscountsPort {
  constructor(private readonly evaluation: DiscountEvaluationService) {}

  async evaluate(
    lines: DiscountLine[],
    currency: string,
  ): Promise<Array<{ shopId: string; discountMinor: number }>> {
    const { shopDiscounts } = await this.evaluation.evaluateDiscounts({
      currency: currency.toUpperCase(),
      lines: lines.map((l) => ({
        productId: l.productId,
        shopId: l.shopId,
        category: l.category,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
      })),
    });
    return shopDiscounts;
  }
}
