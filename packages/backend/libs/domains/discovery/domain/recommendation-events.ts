import { z } from 'zod';

/**
 * What this capability needs from `order.paid` (S34 R-5): the fields of `orderEventSchemas['order.paid']` it reads, with the
 * stricter rules a basket depends on (at least one line, UUID product ids, a real `paidAt`). The event itself is declared
 * once by `orders`; this only narrows what the consumer accepts, so anything else is dead-lettered instead of guessed at.
 */
export const paidOrderSchema = z.object({
  orderId: z.string().uuid(),
  userId: z.string().min(1),
  orderVersion: z.number().int().positive(),
  paidAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'not a date' }),
  lines: z.array(z.object({ productId: z.string().uuid() })).min(1),
});
export type PaidOrder = z.infer<typeof paidOrderSchema>;

/** The paid order, or the paths (never the values) that broke the contract. */
export function parsePaidOrder(
  payload: unknown,
): { ok: true; order: PaidOrder } | { ok: false; paths: string[] } {
  const parsed = paidOrderSchema.safeParse(payload);
  if (parsed.success) return { ok: true, order: parsed.data };
  return {
    ok: false,
    paths: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))],
  };
}
