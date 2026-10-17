/** Half up; `0` without orders. */
export const averageOrderValue = (
  revenueMinor: number,
  orders: number,
): number => (orders > 0 ? Math.floor(revenueMinor / orders + 0.5) : 0);
