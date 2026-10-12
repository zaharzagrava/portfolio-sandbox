/** Plain read shapes the exported order reads return (FR-051): never a model, never a persistence field. */

export interface OrderLineDto {
  orderId: string;
  shopOrderId: string;
  productId: string;
  shopId: string | null;
  title: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  lineTotalMinor: number;
}

export interface PayableOrderDto {
  orderId: string;
  userId: string;
  totalMinor: number;
  currency: string;
  reservedUntil: string;
  shopAllocations: Array<{ shopId: string | null; subtotalMinor: number }>;
}

/** Most ids one `getOrderLines` call takes. */
export const MAX_ORDER_LINE_IDS = 500;
