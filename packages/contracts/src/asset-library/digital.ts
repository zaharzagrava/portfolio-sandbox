import { z } from 'zod';

export const digitalProductLinkSchema = z
  .object({
    productId: z.string(),
    assetId: z.string().uuid(),
    fileName: z.string(),
    sizeBytes: z.number().int().min(0),
    version: z.number().int().min(1),
    linkedAt: z.string(),
  })
  .strict();
export type DigitalProductLink = z.infer<typeof digitalProductLinkSchema>;

export const purchaseSchema = z
  .object({
    entitlementId: z.string().uuid(),
    productId: z.string(),
    shopId: z.string().uuid(),
    orderId: z.string().uuid(),
    title: z.string(),
    fileName: z.string(),
    sizeBytes: z.number().int().min(0),
    grantedAt: z.string(),
  })
  .strict();
export const purchasePageSchema = z
  .object({
    items: z.array(purchaseSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type PurchasePage = z.infer<typeof purchasePageSchema>;
