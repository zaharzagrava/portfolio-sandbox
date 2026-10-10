import { Injectable, Optional } from '@nestjs/common';
import { CheckoutDiscounts } from '../domain/checkout-discounts.port';
import type { DiscountLine, ShopDiscountsPort } from '../domain/ports';

/**
 * Bridges today's per-line `CheckoutDiscounts` (shop-functions) to the per-shop amounts checkout works with:
 * `Σ (gross − discounted unit) × quantity` per shop, floored at 0. Without a bound source there are no discounts.
 * The caller applies the time box, validates the amounts and counts every fallback.
 */
@Injectable()
export class LegacyCheckoutDiscountsAdapter implements ShopDiscountsPort {
  constructor(@Optional() private readonly source?: CheckoutDiscounts) {}

  async evaluate(
    lines: DiscountLine[],
  ): Promise<Array<{ shopId: string; discountMinor: number }>> {
    if (!this.source) return [];
    const prices = await this.source.unitPrices(
      lines.map((l) => ({
        productId: l.productId,
        shopId: l.shopId,
        category: l.category,
        quantity: l.quantity,
        unitPrice: l.unitPriceMinor,
      })),
    );
    const byShop = new Map<string, number>();
    lines.forEach((l, i) => {
      const unit = prices[i] ?? l.unitPriceMinor;
      const off = Math.max(0, (l.unitPriceMinor - unit) * l.quantity);
      byShop.set(l.shopId, (byShop.get(l.shopId) ?? 0) + off);
    });
    return [...byShop].map(([shopId, discountMinor]) => ({
      shopId,
      discountMinor,
    }));
  }
}
