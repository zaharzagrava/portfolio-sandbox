import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * S04 events (contracts/events.md): topic `shops.events` (aggregate `shops`), key `shopId`. The only registration of
 * these types: tenancy reads them without `defineEvent` (a second definition would throw DuplicateEventDefinitionError).
 * The contract version stays 1 (tenancy matches only v1); the numeric argument of `create` is the aggregate version,
 * 2n-1 for the submit of round n and 2n for its outcome, so the stream of a shop is ordered across rounds.
 */
const ShopId = z.string().uuid();

export const OnboardingSubmitted = defineEvent(
  'shop.onboarding_submitted',
  'shops',
  1,
  z.object({
    shopId: ShopId,
    submissionNo: z.number().int().min(1),
    country: z.string(),
    legalForm: z.string(),
    requiredDocuments: z.array(z.string()),
  }),
);

export const ShopVerified = defineEvent(
  'shop.verified',
  'shops',
  1,
  z.object({
    shopId: ShopId,
    submissionNo: z.number().int().min(1),
    verifiedAt: z.string(),
  }),
);

export const ShopRejected = defineEvent(
  'shop.rejected',
  'shops',
  1,
  z.object({
    shopId: ShopId,
    submissionNo: z.number().int().min(1),
    rejectedAt: z.string(),
    reasonCode: z.enum([
      'DOCUMENTS_INVALID',
      'IDENTITY_MISMATCH',
      'FRAUD_SUSPECTED',
      'OTHER',
    ]),
  }),
);

export const OnboardingDocumentRejected = defineEvent(
  'shop.onboarding_document_rejected',
  'shops',
  1,
  z.object({
    shopId: ShopId,
    documentId: z.string().uuid(),
    kind: z.enum([
      'BUSINESS_REGISTRATION',
      'VAT_CERTIFICATE',
      'BANK_STATEMENT',
    ]),
    reason: z.string(),
  }),
);

export const submittedVersion = (submissionNo: number) => 2 * submissionNo - 1;
export const outcomeVersion = (submissionNo: number) => 2 * submissionNo;
