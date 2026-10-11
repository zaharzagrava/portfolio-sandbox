import { z } from 'zod';

/** S37 short links (specs/domains/S37-share-links/spec.md FR-011, FR-105). */
export const createShortLinkRequestSchema = z
  .object({
    destination: z.string().min(1).max(2048),
    alias: z
      .string()
      .regex(/^[0-9A-Za-z_-]{3,40}$/)
      .optional(),
    expiresAt: z.string().nullable().optional(),
  })
  .strict();
export type CreateShortLinkRequest = z.infer<
  typeof createShortLinkRequestSchema
>;

/** Exactly the fields S37 publishes; no owner or internal key. */
export const shortLinkSchema = z
  .object({
    code: z.string().min(1),
    shortUrl: z.url(),
    destination: z.string().min(1),
    status: z.enum(['ACTIVE', 'DISABLED']),
    kind: z.enum(['generated', 'custom']),
    createdAt: z.string(),
    updatedAt: z.string(),
    expiresAt: z.string().nullable(),
    disabledAt: z.string().optional(),
  })
  .strict();
export type ShortLink = z.infer<typeof shortLinkSchema>;
