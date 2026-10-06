/**
 * Hook for seller-defined discounts at checkout (SD-40). Optional: without an
 * implementation registered, checkout charges catalogue prices. Returns the
 * new UNIT price per line (same order), never higher than the input price.
 */
export interface DiscountableLine {
  productId: string;
  shopId: string | null;
  category: string;
  quantity: number;
  unitPrice: number;
}

export abstract class CheckoutDiscounts {
  abstract unitPrices(lines: DiscountableLine[]): Promise<number[]>;
}
