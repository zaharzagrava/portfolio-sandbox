import { z } from "zod";

/**
 * S47 knowledge documents (specs/domains/S47-rag-help-center/contracts/knowledge-api.md). Used by the controllers, the
 * e2e specs and the web client. No storage location, content hash, creator or raw error text ever appears in a document.
 */

export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_MARKDOWN_MAX_BYTES = 1024 * 1024;
export const KNOWLEDGE_PDF_MAX_BYTES = 20 * 1024 * 1024;
export const KNOWLEDGE_LIST_LIMIT = { default: 20, max: 100 } as const;

export const KNOWLEDGE_VISIBILITIES = [
  "PUBLIC",
  "SHOP_PRIVATE",
  "PLATFORM",
] as const;
export const KNOWLEDGE_STATUSES = [
  "AWAITING_UPLOAD",
  "QUEUED",
  "PROCESSING",
  "READY",
  "FAILED",
  "DELETED",
] as const;
export const KNOWLEDGE_FAILURE_CODES = [
  "not_a_pdf",
  "unparseable",
  "no_text",
  "too_many_pages",
  "too_many_chunks",
  "size_mismatch",
  "embedding_unavailable",
] as const;

export const KNOWLEDGE_PROBLEM_CODES = [
  "validation_failed",
  "invalid_cursor",
  "unauthenticated",
  "permission_denied",
  "shop_suspended",
  "not_found",
  "product_archived",
  "invalid_transition",
  "upload_missing",
  "shop_offboarding",
  "input_rejected",
  "product_document_must_be_public",
  "document_limit_reached",
  "rate_limit_cost_exceeded",
  "rate_limited",
  "assistant_busy",
  "assistant_unavailable",
  "rate_limiter_unavailable",
] as const;
export type KnowledgeProblemCode = (typeof KNOWLEDGE_PROBLEM_CODES)[number];

export const knowledgeDocumentSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    visibility: z.enum(KNOWLEDGE_VISIBILITIES),
    productId: z.string().uuid().nullable(),
    format: z.enum(["MARKDOWN", "PDF"]),
    status: z.enum(KNOWLEDGE_STATUSES),
    failureCode: z.enum(KNOWLEDGE_FAILURE_CODES).nullable(),
    chunkCount: z.number().int().nonnegative(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

export const knowledgeDocumentPageSchema = z
  .object({
    items: z.array(knowledgeDocumentSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type KnowledgeDocumentPage = z.infer<typeof knowledgeDocumentPageSchema>;

const title = z.string().min(1).max(KNOWLEDGE_TITLE_MAX);
const markdown = z
  .string()
  .refine((v) => v.trim().length > 0, "markdown is empty")
  .refine(
    (v) => new TextEncoder().encode(v).length <= KNOWLEDGE_MARKDOWN_MAX_BYTES,
    "markdown is over 1 MiB",
  );
const pdfSha256 = z.string().regex(/^[0-9a-f]{64}$/);
const pdfSize = z.number().int().min(1).max(KNOWLEDGE_PDF_MAX_BYTES);

/** Exactly one of `markdown` or the pair `pdfSha256` + `pdfSize`. */
const oneForm = (v: {
  markdown?: string;
  pdfSha256?: string;
  pdfSize?: number;
}) => {
  const hasMarkdown = v.markdown !== undefined;
  const hasPdfHash = v.pdfSha256 !== undefined;
  const hasPdfSize = v.pdfSize !== undefined;
  if (hasMarkdown) return !hasPdfHash && !hasPdfSize;
  return hasPdfHash && hasPdfSize;
};
const ONE_FORM_MESSAGE = "provide markdown, or pdfSha256 together with pdfSize";

export const knowledgeCreateRequestSchema = z
  .object({
    title,
    visibility: z.enum(["PUBLIC", "SHOP_PRIVATE"]),
    productId: z.string().uuid().optional(),
    markdown: markdown.optional(),
    pdfSha256: pdfSha256.optional(),
    pdfSize: pdfSize.optional(),
  })
  .strict()
  .refine(oneForm, { message: ONE_FORM_MESSAGE, path: ["markdown"] });
export type KnowledgeCreateRequest = z.infer<
  typeof knowledgeCreateRequestSchema
>;

export const knowledgeAdminCreateRequestSchema = z
  .object({
    title,
    markdown: markdown.optional(),
    pdfSha256: pdfSha256.optional(),
    pdfSize: pdfSize.optional(),
  })
  .strict()
  .refine(oneForm, { message: ONE_FORM_MESSAGE, path: ["markdown"] });
export type KnowledgeAdminCreateRequest = z.infer<
  typeof knowledgeAdminCreateRequestSchema
>;

export const knowledgeUploadGrantSchema = z
  .object({
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string(),
  })
  .strict();
export type KnowledgeUploadGrant = z.infer<typeof knowledgeUploadGrantSchema>;

export const knowledgeCreateResponseSchema = z
  .object({
    document: knowledgeDocumentSchema,
    deduplicated: z.boolean(),
    upload: knowledgeUploadGrantSchema.optional(),
  })
  .strict();
export type KnowledgeCreateResponse = z.infer<
  typeof knowledgeCreateResponseSchema
>;

export const knowledgeListQuerySchema = z
  .object({
    status: z
      .enum(["AWAITING_UPLOAD", "QUEUED", "PROCESSING", "READY", "FAILED"])
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(KNOWLEDGE_LIST_LIMIT.max)
      .default(KNOWLEDGE_LIST_LIMIT.default),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type KnowledgeListQuery = z.infer<typeof knowledgeListQuerySchema>;

export const knowledgeReindexResponseSchema = z
  .object({ enqueued: z.number().int().nonnegative() })
  .strict();
export type KnowledgeReindexResponse = z.infer<
  typeof knowledgeReindexResponseSchema
>;
