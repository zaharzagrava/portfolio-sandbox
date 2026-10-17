import { z } from 'zod';

/**
 * S06 contracts (specs/domains/S06-collab-editor/contracts/http.md and events-services.md). Requests are strict (unknown
 * fields are refused); responses are strict too, so a field added on the server without a contract change fails the e2e parse.
 */
export const DRAFT_LIMITS = {
  title: { min: 1, max: 120 },
  versionName: { min: 1, max: 80 },
  pageLimit: { min: 1, max: 100, default: 20 },
} as const;

export const DRAFT_STATUSES = [
  'DRAFT',
  'PUBLISHING',
  'PUBLISHED',
  'ARCHIVED',
] as const;
export const draftStatusSchema = z.enum(DRAFT_STATUSES);
export type DraftStatus = z.infer<typeof draftStatusSchema>;

const codePoints = (value: string) => [...value].length;

/** C0 and C1 control characters and the Unicode line and paragraph separators (written as code points to keep the source plain). */
const hasControl = (value: string): boolean => {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    )
      return true;
  }
  return false;
};

const trimmed = (limits: { min: number; max: number }, controls: boolean) =>
  z
    .string()
    .refine((s) => !controls || !hasControl(s), {
      message: 'must not contain control characters',
    })
    .transform((s) => s.trim())
    .refine(
      (s) => codePoints(s) >= limits.min && codePoints(s) <= limits.max,
      { message: `length must be ${limits.min}..${limits.max}` },
    );

export const draftCreateRequestSchema = z
  .object({
    title: trimmed(DRAFT_LIMITS.title, false),
    productId: z.string().uuid().optional(),
  })
  .strict();
export type DraftCreateRequest = z.infer<typeof draftCreateRequestSchema>;

export const draftSchema = z
  .object({
    id: z.string().uuid(),
    shopId: z.string().uuid(),
    productId: z.string().uuid().nullable(),
    title: z.string(),
    status: draftStatusSchema,
    baseProductVersion: z.number().int().positive().nullable(),
    createdBy: z.string().uuid(),
    createdAt: z.string(),
    updatedAt: z.string(),
    publishedAt: z.string().nullable(),
  })
  .strict();
export type Draft = z.infer<typeof draftSchema>;

export const draftPageSchema = z
  .object({
    items: z.array(draftSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type DraftPage = z.infer<typeof draftPageSchema>;

export const draftConnectSchema = z
  .object({
    url: z.string(),
    ticket: z.string(),
    canWrite: z.boolean(),
    expiresAt: z.string(),
  })
  .strict();
export type DraftConnect = z.infer<typeof draftConnectSchema>;

export const draftVersionCreateRequestSchema = z
  .object({ name: trimmed(DRAFT_LIMITS.versionName, true) })
  .strict();
export type DraftVersionCreateRequest = z.infer<
  typeof draftVersionCreateRequestSchema
>;

export const DRAFT_VERSION_KINDS = ['named', 'published'] as const;
export const draftVersionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    kind: z.enum(DRAFT_VERSION_KINDS),
    createdBy: z.string().uuid(),
    createdAt: z.string(),
  })
  .strict();
export type DraftVersion = z.infer<typeof draftVersionSchema>;

export const draftContentSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    priceMinor: z.number().int().nullable(),
    brand: z.string().nullable(),
    category: z.string().nullable(),
    quantity: z.number().int().nullable(),
    specs: z.record(z.string(), z.string()),
  })
  .strict();
export type DraftContent = z.infer<typeof draftContentSchema>;

export const draftVersionDetailSchema = draftVersionSchema
  .extend({ content: draftContentSchema })
  .strict();
export type DraftVersionDetail = z.infer<typeof draftVersionDetailSchema>;

export const draftVersionPageSchema = z
  .object({
    items: z.array(draftVersionSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type DraftVersionPage = z.infer<typeof draftVersionPageSchema>;

export const draftPublishRequestSchema = z
  .object({ acknowledgeProductVersion: z.number().int().positive().optional() })
  .strict();
export type DraftPublishRequest = z.infer<typeof draftPublishRequestSchema>;

export const draftPublishResultSchema = z
  .object({
    productId: z.string().uuid(),
    productVersion: z.number().int().positive(),
    versionId: z.string().uuid(),
  })
  .strict();
export type DraftPublishResult = z.infer<typeof draftPublishResultSchema>;

export const draftPublishedPayloadSchema = z
  .object({
    draftId: z.string().uuid(),
    shopId: z.string().uuid(),
    productId: z.string().uuid(),
    productVersion: z.number().int().positive(),
    versionId: z.string().uuid(),
    publishedBy: z.string().uuid(),
  })
  .strict();

/** Payload schema per event type of `drafts.events`. */
export const draftEventSchemas = {
  'catalog.draft_published': draftPublishedPayloadSchema,
} as const;
export type DraftEventType = keyof typeof draftEventSchemas;

/** `errors` of a `422 listing_invalid` problem. */
export const listingInvalidErrorsSchema = z.array(
  z.object({ field: z.string(), code: z.string() }).strict(),
);
