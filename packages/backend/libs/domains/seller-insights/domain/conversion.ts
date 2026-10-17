/** Orders per checkout in the same 60 s window, 3 decimals, not capped (a live indicator); `null` without checkouts. */
export const checkoutConversion = (
  checkouts: number,
  orders: number,
): number | null =>
  checkouts > 0 ? Math.round((orders / checkouts) * 1000) / 1000 : null;
