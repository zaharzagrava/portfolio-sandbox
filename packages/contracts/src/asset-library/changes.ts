import { z } from 'zod';

export const assetChangeSchema = z
  .object({
    seq: z.number().int().min(1),
    assetId: z.string().uuid(),
    path: z.string(),
    version: z.number().int().min(0),
    kind: z.enum(['upsert', 'delete']),
  })
  .strict();
export type AssetChange = z.infer<typeof assetChangeSchema>;

export const assetChangePageSchema = z
  .object({
    items: z.array(assetChangeSchema),
    nextCursor: z.string(),
    hasMore: z.boolean(),
  })
  .strict();
export type AssetChangePage = z.infer<typeof assetChangePageSchema>;
