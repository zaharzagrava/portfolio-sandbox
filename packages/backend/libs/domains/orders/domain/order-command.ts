import { z } from 'zod';

/**
 * The fixed-price order command other capabilities call (S21 R-04, S10 amendment): an order for one unit whose stock
 * another capability already holds (`EXTERNALLY_HELD`), priced by that capability, not by the catalog.
 */
export const fixedPriceOrderCommandSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
  buyerId: z.string().uuid(),
  shopId: z.string().uuid(),
  productId: z.string().uuid(),
  quantity: z.literal(1),
  /** Checked apart, so that a bad price is the permanent `invalid_price` and not a shape error. */
  unitPriceMinor: z.number(),
  currency: z.string().length(3),
  titleSnapshot: z.string().min(1).max(500),
  reservedUntil: z.string().datetime(),
  origin: z.object({
    kind: z.literal('AUCTION'),
    ref: z.string().min(1).max(128),
    step: z.enum(['winner', 'second-chance']),
  }),
  stockHandling: z.literal('EXTERNALLY_HELD'),
});

export type FixedPriceOrderCommand = z.infer<
  typeof fixedPriceOrderCommandSchema
>;

export interface FixedPriceOrderAnswer {
  orderId: string;
  status: 'RESERVED';
  reservedUntil: string;
  replayed: boolean;
}

export type OrderCommandRejectionCode =
  'buyer_not_eligible' | 'shop_not_eligible' | 'invalid_price';

/** A permanent refusal: retrying the same command cannot succeed. Every other failure of the command is transient. */
export class OrderCommandRejectedError extends Error {
  constructor(readonly code: OrderCommandRejectionCode) {
    super(`order command rejected: ${code}`);
    this.name = 'OrderCommandRejectedError';
  }
}

export const isValidUnitPrice = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;
