import { z } from 'zod';
import {
  ONBOARDING_STEP_NAMES,
  onboardingDraftAnswersSchema,
} from './steps.ts';

/** S04 seller onboarding HTTP shapes (specs/domains/S04-kyc-onboarding/contracts/http.md). All strict. */

export const ONBOARDING_DOCUMENT_KINDS = [
  'BUSINESS_REGISTRATION',
  'VAT_CERTIFICATE',
  'BANK_STATEMENT',
] as const;
export const onboardingDocumentKindSchema = z.enum(ONBOARDING_DOCUMENT_KINDS);
export type OnboardingDocumentKind = z.infer<
  typeof onboardingDocumentKindSchema
>;

export const ONBOARDING_DOCUMENT_STATUSES = [
  'AWAITING_UPLOAD',
  'QUEUED',
  'EXTRACTING',
  'NEEDS_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
] as const;
export const onboardingDocumentStatusSchema = z.enum(
  ONBOARDING_DOCUMENT_STATUSES,
);
export type OnboardingDocumentStatus = z.infer<
  typeof onboardingDocumentStatusSchema
>;

/** `SUPERSEDED` documents are never shown to a seller. */
const sellerVisibleStatus = onboardingDocumentStatusSchema.exclude([
  'SUPERSEDED',
]);

export const ONBOARDING_APPLICATION_STATUSES = [
  'NOT_STARTED',
  'DRAFT',
  'SUBMITTED',
  'VERIFIED',
  'REJECTED',
] as const;
export const onboardingApplicationStatusSchema = z.enum(
  ONBOARDING_APPLICATION_STATUSES,
);

/** A document as a seller sees it: public columns only (no storage key, values, model or issue codes). */
export const onboardingDocumentSchema = z.strictObject({
  id: z.string().uuid(),
  kind: onboardingDocumentKindSchema,
  status: onboardingDocumentStatusSchema,
  rejectionReason: z.string().max(500).nullable(),
});
export type OnboardingDocument = z.infer<typeof onboardingDocumentSchema>;

export const onboardingViewSchema = z.strictObject({
  status: onboardingApplicationStatusSchema,
  submissionNo: z.number().int().min(1).nullable(),
  answers: onboardingDraftAnswersSchema,
  missingSteps: z.array(z.enum(ONBOARDING_STEP_NAMES)),
  /** One status per required kind; `MISSING` until a document of that kind exists. */
  requiredDocuments: z
    .array(
      z.strictObject({
        kind: onboardingDocumentKindSchema,
        status: z.union([z.literal('MISSING'), sellerVisibleStatus]),
      }),
    )
    .nullable(),
  documents: z.array(
    onboardingDocumentSchema.extend({ status: sellerVisibleStatus }),
  ),
});
export type OnboardingView = z.infer<typeof onboardingViewSchema>;

export const onboardingSubmitResultSchema = z.strictObject({
  submitted: z.literal(true),
  submissionNo: z.number().int().min(1),
  requiredDocuments: z.array(onboardingDocumentKindSchema).min(2).max(3),
});
export type OnboardingSubmitResult = z.infer<
  typeof onboardingSubmitResultSchema
>;

// ---- documents ------------------------------------------------------------------------------------------------

export const ONBOARDING_UPLOAD_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const ONBOARDING_PDF_MAX_BYTES = 10 * 1024 * 1024;
export const ONBOARDING_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export const documentUploadRequestSchema = z
  .strictObject({
    kind: onboardingDocumentKindSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters'),
    size: z.number().int().min(1),
    contentType: z.enum(ONBOARDING_UPLOAD_CONTENT_TYPES),
  })
  .superRefine((v, ctx) => {
    const cap =
      v.contentType === 'application/pdf'
        ? ONBOARDING_PDF_MAX_BYTES
        : ONBOARDING_IMAGE_MAX_BYTES;
    if (v.size > cap)
      ctx.addIssue({
        code: 'custom',
        path: ['size'],
        message: `must not exceed ${cap} bytes for this content type`,
      });
  });
export type DocumentUploadRequest = z.infer<typeof documentUploadRequestSchema>;

export const documentUploadResultSchema = z.strictObject({
  document: onboardingDocumentSchema,
  deduplicated: z.boolean(),
  upload: z
    .strictObject({
      url: z.string().url(),
      method: z.literal('PUT'),
      headers: z.record(z.string(), z.string()),
      expiresAt: z.string().datetime(),
    })
    .nullable(),
});
export type DocumentUploadResult = z.infer<typeof documentUploadResultSchema>;

/** `POST …/documents/:documentId/uploaded`. */
export const documentConfirmResultSchema = onboardingDocumentSchema;
export type DocumentConfirmResult = OnboardingDocument;

// ---- review ---------------------------------------------------------------------------------------------------

export const REVIEW_QUEUE_DEFAULT_LIMIT = 50;
export const REVIEW_QUEUE_MAX_LIMIT = 100;

export const reviewQueueQuerySchema = z.strictObject({
  kind: onboardingDocumentKindSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(REVIEW_QUEUE_MAX_LIMIT)
    .default(REVIEW_QUEUE_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(500).optional(),
});

export const reviewIssueSchema = z.strictObject({
  field: z.string().nullable(),
  code: z.string(),
  escalate: z.boolean(),
});

export const reviewQueueItemSchema = z.strictObject({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  shopId: z.string().uuid(),
  shopName: z.string().nullable(),
  kind: onboardingDocumentKindSchema,
  reasons: z.array(reviewIssueSchema),
  model: z.string().nullable(),
  /** Masked values only. */
  fields: z.record(
    z.string(),
    z.strictObject({
      value: z.string().nullable(),
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
  attempts: z.number().int().min(0).max(2),
  /** A 300 s link, or `null` once the raw file was purged. */
  fileUrl: z.string().url().nullable(),
  createdAt: z.string().datetime(),
});
export type ReviewQueueItem = z.infer<typeof reviewQueueItemSchema>;

export const reviewQueuePageSchema = z.strictObject({
  items: z.array(reviewQueueItemSchema).max(REVIEW_QUEUE_MAX_LIMIT),
  nextCursor: z.string().nullable(),
});
export type ReviewQueuePage = z.infer<typeof reviewQueuePageSchema>;

export const ONBOARDING_REJECTION_REASON_CODES = [
  'DOCUMENTS_INVALID',
  'IDENTITY_MISMATCH',
  'FRAUD_SUSPECTED',
  'OTHER',
] as const;
export const onboardingRejectionReasonCodeSchema = z.enum(
  ONBOARDING_REJECTION_REASON_CODES,
);

/** Fields a reviewer may correct: only those of the document kinds, values bounded. */
export const ONBOARDING_CORRECTABLE_FIELDS = [
  'legalName',
  'registrationNumber',
  'country',
  'registeredAddress',
  'issueDate',
  'vatNumber',
  'accountHolder',
  'iban',
  'bankName',
  'statementDate',
] as const;
export const REVIEW_REASON_MIN = 3;
export const REVIEW_REASON_MAX = 500;

const reasonSchema = z
  .string()
  .trim()
  .min(REVIEW_REASON_MIN)
  .max(REVIEW_REASON_MAX);

export const reviewResolveRequestSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('APPROVE'),
    corrections: z
      .partialRecord(
        z.enum(ONBOARDING_CORRECTABLE_FIELDS),
        z.string().trim().min(1).max(500),
      )
      .optional(),
  }),
  z.strictObject({ decision: z.literal('REJECT'), reason: reasonSchema }),
  z.strictObject({
    decision: z.literal('REJECT_APPLICATION'),
    reasonCode: onboardingRejectionReasonCodeSchema,
    reason: reasonSchema,
  }),
]);
export type ReviewResolveRequest = z.infer<typeof reviewResolveRequestSchema>;

export const reviewResolveResultSchema = z.strictObject({
  status: z.enum(['APPROVED', 'REJECTED', 'APPLICATION_REJECTED']),
  shopVerified: z.boolean(),
});
export type ReviewResolveResult = z.infer<typeof reviewResolveResultSchema>;
