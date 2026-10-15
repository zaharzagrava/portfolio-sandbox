import { assertNever } from '@app/common/core/assert-never';

/**
 * Invoice statuses (S17 FR-030). `VOID` is storable but nothing in this capability produces it. The store enforces
 * the same edges with `billing_invoice_immutable`.
 */
export const INVOICE_STATUSES = [
  'OPEN',
  'PAID',
  'VOID',
  'UNCOLLECTIBLE',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export function canMoveInvoice(
  from: InvoiceStatus,
  to: InvoiceStatus,
): boolean {
  switch (from) {
    case 'OPEN':
      return to === 'PAID' || to === 'UNCOLLECTIBLE';
    case 'UNCOLLECTIBLE':
      return to === 'PAID';
    case 'PAID':
    case 'VOID':
      return false;
    default:
      return assertNever(from);
  }
}

/** An invoice that still has to be collected: `OPEN`, or written off but payable (late payment). */
export const OWED_STATUSES: readonly InvoiceStatus[] = [
  'OPEN',
  'UNCOLLECTIBLE',
];
