/**
 * Stock operations for the catalog's `applyStockDelta` (S10 FR-025, AS-35). The same set of lines always gives the same
 * list: one operation per product, quantities summed, ascending product id (the catalog locks rows in that order too).
 * `operationId = <service>:<aggregate-id>:<step>:<product>`; a release is a new operation, never a replay of the reserve.
 */
export interface StockLine {
  productId: string;
  shopId: string;
  quantity: number;
}

export interface StockOperationInput {
  operationId: string;
  productId: string;
  shopId: string;
  delta: number;
  reason: string;
}

function build(
  orderId: string,
  lines: StockLine[],
  step: 'reserve' | 'release',
  sign: 1 | -1,
): StockOperationInput[] {
  const byProduct = new Map<string, { shopId: string; quantity: number }>();
  for (const l of lines) {
    const current = byProduct.get(l.productId);
    byProduct.set(l.productId, {
      shopId: l.shopId,
      quantity: (current?.quantity ?? 0) + l.quantity,
    });
  }
  return [...byProduct.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([productId, { shopId, quantity }]) => ({
      operationId: `orders:${orderId}:${step}:${productId}`,
      productId,
      shopId,
      delta: sign * quantity,
      reason: `order.${step}`,
    }));
}

export const buildReserveOperations = (orderId: string, lines: StockLine[]) =>
  build(orderId, lines, 'reserve', -1);

export const buildReleaseOperations = (orderId: string, lines: StockLine[]) =>
  build(orderId, lines, 'release', 1);
