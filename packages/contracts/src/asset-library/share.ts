import { z } from 'zod';

export const shareLinkCreateRequestSchema = z
  .object({
    expiresInHours: z.number().int().min(1).max(720),
    maxDownloads: z.number().int().min(1).max(10000).optional(),
  })
  .strict();
export type ShareLinkCreateRequest = z.infer<
  typeof shareLinkCreateRequestSchema
>;

/** The only response that carries the token. */
export const shareLinkSchema = z
  .object({
    id: z.string().uuid(),
    token: z.string().min(32),
    url: z.string(),
    expiresAt: z.string(),
    maxDownloads: z.number().int().nullable(),
    createdAt: z.string(),
  })
  .strict();

export const SHARE_LINK_STATUSES = [
  'ACTIVE',
  'EXPIRED',
  'EXHAUSTED',
  'REVOKED',
] as const;
export const shareLinkListItemSchema = z
  .object({
    id: z.string().uuid(),
    expiresAt: z.string(),
    maxDownloads: z.number().int().nullable(),
    downloads: z.number().int().min(0),
    status: z.enum(SHARE_LINK_STATUSES),
    createdBy: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export const shareLinkListSchema = z
  .object({ items: z.array(shareLinkListItemSchema) })
  .strict();

export const shareLinkPreviewSchema = z
  .object({
    fileName: z.string(),
    sizeBytes: z.number().int().min(0),
    expiresAt: z.string(),
    remainingDownloads: z.number().int().min(0).nullable(),
  })
  .strict();

export const shareRedeemSchema = z
  .object({
    url: z.string(),
    expiresAt: z.string(),
    fileName: z.string(),
    sizeBytes: z.number().int().min(0),
  })
  .strict();
