export const CONVERSION_STORE = Symbol('CONVERSION_STORE');

export type ConversionStatus = 'CONFIRMED' | 'REVERSED' | 'PENDING_REFUND';

export interface ConversionRow {
  id: string;
  linkCode: string;
  ownerId: string;
  /** Internal: never in a route, an event or a log. */
  orderId: string;
  amountMinor: number;
  currency: string;
  status: ConversionStatus;
  refundedMinor: number;
  orderVersion: number;
  paidAt: Date | null;
}

export interface ConversionTotals {
  conversions: number;
  convertedMinor: number;
}

export interface ConversionStore {
  /** The row of an order, locked for the transaction. */
  lockByOrder(orderId: string): Promise<ConversionRow | null>;
  insert(row: ConversionRow, now: Date): Promise<boolean>;
  update(row: ConversionRow, now: Date): Promise<void>;
  page(
    linkCode: string,
    limit: number,
    after: { paidAt: string; id: string } | null,
  ): Promise<ConversionRow[]>;
  totals(linkCode: string): Promise<ConversionTotals>;
}
