import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

/** Payload of `orders.process-webhook`: what the intake stored for processing (≤ 2 KiB); never the raw body or signature. */
export const processWebhookPayloadSchema = z.object({
  eventId: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  orderId: z.string().max(64).nullable(),
  paymentRef: z.string().max(255).nullable(),
  amountMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().max(8).nullable(),
  /** `charge.refunded`: the amount refunded, when the provider says so. */
  refundedMinor: z.number().int().nonnegative().nullable().optional(),
});
export type ProcessWebhookPayload = z.infer<typeof processWebhookPayloadSchema>;

const clearCartPayloadSchema = z.object({
  cartId: z.string().min(1).max(100),
  consumed: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().positive(),
      }),
    )
    .max(100),
});

// Kept apart from the handlers (infra/order.jobs.ts) so an app that only enqueues (checkout, the orders controller,
// auctions) loads the declarations without the worker code.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'orders.expire-reservation': { orderId: string };
    'orders.sweep-expired-reservations': Record<string, never>;
    'orders.recover-pending': Record<string, never>;
    'orders.release-stock': Record<string, never>;
    'orders.clear-cart': z.infer<typeof clearCartPayloadSchema>;
    'orders.process-webhook': ProcessWebhookPayload;
    'flash-sale.start': { saleId: string };
    'flash-sale.end': { saleId: string };
    'flash-sale.reconcile': { saleId: string };
  }
}

declareJobType({
  name: 'orders.expire-reservation',
  contract: z.object({ orderId: z.string() }),
});
declareJobType({
  name: 'orders.sweep-expired-reservations',
  contract: z.object({}),
});
declareJobType({ name: 'orders.recover-pending', contract: z.object({}) });
declareJobType({ name: 'orders.release-stock', contract: z.object({}) });
declareJobType({
  name: 'orders.clear-cart',
  contract: clearCartPayloadSchema,
  maxAttempts: 5,
});
declareJobType({
  name: 'orders.process-webhook',
  contract: processWebhookPayloadSchema,
  maxAttempts: 8,
});
declareJobType({
  name: 'flash-sale.start',
  contract: z.object({ saleId: z.string() }),
});
declareJobType({
  name: 'flash-sale.end',
  contract: z.object({ saleId: z.string() }),
});
declareJobType({
  name: 'flash-sale.reconcile',
  contract: z.object({ saleId: z.string() }),
});
