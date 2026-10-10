/**
 * The order copy (R3): what payments knows about an order, fed by `orders.events`. The accept path reads it instead of
 * calling orders (S13 questions.md CONTRACT 1).
 */
export type OrderCopyStatus = 'RESERVED' | 'PAID' | 'CANCELLED';

export interface OrderCopy {
  orderId: string;
  userId: string;
  totalMinor: number | null;
  currency: string | null;
  status: OrderCopyStatus;
  reservedUntil: Date | null;
  orderVersion: number;
}

export type PayableCheck =
  | { payable: true; totalMinor: number; currency: string }
  | {
      payable: false;
      reason: 'order_cancelled' | 'order_paid' | 'hold_expired';
    };

/** Payable = `RESERVED`, amounts known, and `now < reservedUntil` (the instant itself is expired). */
export function checkPayable(copy: OrderCopy, now: Date): PayableCheck {
  if (copy.status === 'CANCELLED')
    return { payable: false, reason: 'order_cancelled' };
  if (copy.status === 'PAID') return { payable: false, reason: 'order_paid' };
  if (
    copy.totalMinor === null ||
    copy.currency === null ||
    copy.reservedUntil === null ||
    now.getTime() >= copy.reservedUntil.getTime()
  )
    return { payable: false, reason: 'hold_expired' };
  return {
    payable: true,
    totalMinor: copy.totalMinor,
    currency: copy.currency,
  };
}
