import { z } from 'zod';

export const ASSET_STATUSES = ['ACTIVE', 'DELETED', 'PURGED'] as const;
export const assetStatusSchema = z.enum(ASSET_STATUSES);

export const assetSchema = z
  .object({
    id: z.string().uuid(),
    path: z.string(),
    status: assetStatusSchema,
    currentVersion: z.number().int().min(0),
    sizeBytes: z.number().int().min(0),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
  })
  .strict();
export type AssetDto = z.infer<typeof assetSchema>;

/** `syncCursor` is the newest change number read before listing; it is present on the first page only. */
export const assetPageSchema = z
  .object({
    items: z.array(assetSchema),
    nextCursor: z.string().nullable(),
    syncCursor: z.string().nullable(),
  })
  .strict();
export type AssetPage = z.infer<typeof assetPageSchema>;

export const assetVersionSchema = z
  .object({
    version: z.number().int().min(1),
    sizeBytes: z.number().int().min(0),
    chunkCount: z.number().int().min(0),
    createdBy: z.string().nullable(),
    deviceId: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export const assetVersionPageSchema = z
  .object({
    items: z.array(assetVersionSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type AssetVersionPage = z.infer<typeof assetVersionPageSchema>;
