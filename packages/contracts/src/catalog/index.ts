import { z } from 'zod';

/**
 * S05 contracts (specs/domains/S05-products/contracts/http.md and events.md). Response and event schemas are strict:
 * a field added on the server without a contract change (`sellerId`, `embedding`, exact stock in the public view) fails
 * the e2e parse. The limits are shared with the backend DTOs.
 */
export const PRODUCT_LIMITS = {
  title: { min: 1, max: 200 },
  description: { min: 0, max: 4_000 },
  brand: { min: 1, max: 100 },
  category: { min: 1, max: 100 },
  priceMinor: { min: 1, max: 10_000_000_000 },
  quantity: { min: 0, max: 1_000_000_000 },
  tags: { max: 32, itemMin: 1, itemMax: 50 },
  externalSku: { min: 1, max: 128 },
  stockDelta: { max: 1_000_000 },
  stockOperationsPerCall: 100,
  importItemsPerCall: 500,
  idsPerQuery: 500,
  batchRouteIds: 100,
  pageLimit: { min: 1, max: 100, default: 20 },
} as const;

export const PRODUCT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export const productStatusSchema = z.enum(PRODUCT_STATUSES);
export type ProductStatus = z.infer<typeof productStatusSchema>;

export const PRODUCT_CHANGED_FIELDS = [
  'title',
  'description',
  'brand',
  'category',
  'priceMinor',
  'currency',
  'quantity',
  'tags',
  'shopId',
] as const;

/** Length in code points, not UTF-16 units. */
const codePoints = (value: string) => [...value].length;

const text = (limits: { min: number; max: number }) =>
  z
    .string()
    .transform((s) => s.trim())
    .refine(
      (s) => codePoints(s) >= limits.min && codePoints(s) <= limits.max,
      { message: `length must be ${limits.min}..${limits.max}` },
    );

const tag = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine(
    (s) =>
      codePoints(s) >= PRODUCT_LIMITS.tags.itemMin &&
      codePoints(s) <= PRODUCT_LIMITS.tags.itemMax,
    { message: 'tag length must be 1..50' },
  );

/** Trimmed, lower-cased, de-duplicated with the first occurrence kept; the 32-tag limit counts before de-duplication. */
export const productTagsSchema = z
  .array(tag)
  .max(PRODUCT_LIMITS.tags.max)
  .transform((all) => [...new Set(all)]);
const tags = productTagsSchema;

const priceMinor = z
  .number()
  .int()
  .min(PRODUCT_LIMITS.priceMinor.min)
  .max(PRODUCT_LIMITS.priceMinor.max);
const quantity = z
  .number()
  .int()
  .min(PRODUCT_LIMITS.quantity.min)
  .max(PRODUCT_LIMITS.quantity.max);
const currency = z.string().regex(/^[A-Z]{3}$/);
const expectedVersion = z.number().int().positive();

export const productCreateRequestSchema = z
  .object({
    title: text(PRODUCT_LIMITS.title),
    description: text(PRODUCT_LIMITS.description).optional(),
    brand: text(PRODUCT_LIMITS.brand),
    category: text(PRODUCT_LIMITS.category),
    priceMinor,
    currency: currency.optional(),
    quantity: quantity.optional(),
    tags: tags.optional(),
  })
  .strict();
export type ProductCreateRequest = z.infer<typeof productCreateRequestSchema>;

export const productUpdateRequestSchema = z
  .object({
    expectedVersion,
    title: text(PRODUCT_LIMITS.title).optional(),
    description: text(PRODUCT_LIMITS.description).optional(),
    brand: text(PRODUCT_LIMITS.brand).optional(),
    category: text(PRODUCT_LIMITS.category).optional(),
    priceMinor: priceMinor.optional(),
    currency: currency.optional(),
    quantity: quantity.optional(),
    tags: tags.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((k) => k !== 'expectedVersion'), {
    message: 'at least one field besides expectedVersion',
  });
export type ProductUpdateRequest = z.infer<typeof productUpdateRequestSchema>;

export const productTransitionRequestSchema = z
  .object({ expectedVersion })
  .strict();

const productBase = {
  id: z.string().uuid(),
  shopId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  brand: z.string(),
  category: z.string(),
  priceMinor: z.number().int(),
  currency: z.string(),
  rating: z.number(),
  tags: z.array(z.string()),
  inStock: z.boolean(),
  version: z.number().int().nonnegative(),
  viewCount: z.number().int().nonnegative(),
};

export const productMemberSchema = z
  .object({
    ...productBase,
    quantity: z.number().int(),
    status: productStatusSchema,
    externalSku: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ProductMemberView = z.infer<typeof productMemberSchema>;

/** Public detail: carries `id` and `version` for `VersionEtagInterceptor`; no `sellerId`, no `quantity`. */
export const productPublicSchema = z
  .object({ ...productBase, updatedAt: z.string() })
  .strict();
export type ProductPublicView = z.infer<typeof productPublicSchema>;

export const productBatchItemSchema = z
  .object({
    id: z.string().uuid(),
    shopId: z.string().uuid(),
    title: z.string(),
    priceMinor: z.number().int(),
    currency: z.string(),
    inStock: z.boolean(),
    category: z.string(),
    rating: z.number(),
  })
  .strict();
export type ProductBatchItem = z.infer<typeof productBatchItemSchema>;

export const productPageSchema = z
  .object({
    items: z.array(productMemberSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ProductPage = z.infer<typeof productPageSchema>;

const snapshotFields = {
  productId: z.string().uuid(),
  shopId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  brand: z.string(),
  category: z.string(),
  priceMinor: z.number().int(),
  currency: z.string(),
  rating: z.number(),
  tags: z.array(z.string()),
  quantity: z.number().int(),
  inStock: z.boolean(),
  status: productStatusSchema,
  isSandbox: z.boolean(),
  externalSku: z.string().nullable(),
  productVersion: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  changedFields: z.array(z.enum(PRODUCT_CHANGED_FIELDS)),
};
export const productSnapshotSchema = z.object(snapshotFields).strict();
export type ProductSnapshot = z.infer<typeof productSnapshotSchema>;

export const productDeletedPayloadSchema = z
  .object({
    productId: z.string().uuid(),
    shopId: z.string().uuid(),
    productVersion: z.number().int().positive(),
  })
  .strict();

/** Payload schema per event type of `products.events`. */
export const productEventSchemas = {
  'catalog.product_created': productSnapshotSchema,
  'catalog.product_updated': productSnapshotSchema,
  'catalog.product_archived': productSnapshotSchema,
  'catalog.product_restored': productSnapshotSchema,
  'catalog.product_deleted': productDeletedPayloadSchema,
} as const;
export type ProductEventType = keyof typeof productEventSchemas;
