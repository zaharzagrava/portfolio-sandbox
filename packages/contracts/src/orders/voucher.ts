import { z } from 'zod';

/** J03: a booking voucher issued by orders for a confirmed launch-event booking (`GET /orders/vouchers`). */
export const VOUCHER_PAGE_LIMITS = { min: 1, max: 100, default: 20 } as const;

export const voucherStatusSchema = z.enum(['ISSUED']);

export const voucherSchema = z.object({
  voucherId: z.uuid(),
  holdId: z.uuid(),
  launchEventId: z.uuid(),
  shopId: z.uuid(),
  seatCount: z.number().int().min(1),
  status: voucherStatusSchema,
  createdAt: z.iso.datetime(),
});

export const voucherPageSchema = z.object({
  items: z.array(voucherSchema),
  nextCursor: z.string().nullable(),
});

export const voucherListQuerySchema = z.object({
  launchEventId: z.uuid().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(VOUCHER_PAGE_LIMITS.min)
    .max(VOUCHER_PAGE_LIMITS.max)
    .default(VOUCHER_PAGE_LIMITS.default),
  cursor: z.string().min(1).optional(),
});

export type Voucher = z.infer<typeof voucherSchema>;
export type VoucherPage = z.infer<typeof voucherPageSchema>;
