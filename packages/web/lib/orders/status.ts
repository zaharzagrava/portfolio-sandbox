import type { OrderDto, OrderPagePayment } from '@marketplace-sandbox/contracts';

type OrderStatus = OrderDto['status'];

/** FR-060: the status is always shown as text, never colour alone. */
const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  PENDING: 'Processing',
  RESERVED: 'Awaiting payment',
  PAID: 'Paid',
  FULFILLING: 'Preparing',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};
export const orderStatusText = (status: OrderStatus): string => ORDER_STATUS_TEXT[status] ?? status;

/** FR-062: the status text of S13 for the payment panel. */
const PAYMENT_STATUS_TEXT: Record<OrderPagePayment['status'], string> = {
  PENDING: 'Processing',
  UNKNOWN: 'Confirming',
  COMPLETED: 'Paid',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REFUND_PENDING: 'Refund on its way',
  REFUNDED: 'Refunded',
};
export const paymentStatusText = (status: OrderPagePayment['status']): string => PAYMENT_STATUS_TEXT[status] ?? status;

const SHOP_ORDER_STATUS_TEXT: Record<string, string> = { PENDING: 'Processing', PAID: 'Paid', CANCELLED: 'Cancelled', REFUNDED: 'Refunded' };
export const shopOrderStatusText = (status: string): string => SHOP_ORDER_STATUS_TEXT[status] ?? status;

/** The first 8 characters of the id, upper-case: a display label only; links always use the full id. */
export const shortOrderId = (orderId: string): string => orderId.slice(0, 8).toUpperCase();

/** Cancel and Pay now are offered only for `RESERVED` (FR-061); buy again only for `CANCELLED`. */
export const canPay = (status: OrderStatus): boolean => status === 'RESERVED';
export const canCancel = (status: OrderStatus): boolean => status === 'RESERVED';
export const canBuyAgain = (status: OrderStatus): boolean => status === 'CANCELLED';
