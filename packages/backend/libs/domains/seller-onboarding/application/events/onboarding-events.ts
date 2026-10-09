import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

export const OnboardingSubmitted = defineEvent(
  'shop.onboarding_submitted',
  'shops',
  1,
  z.object({
    shopId: z.string(),
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
    shopId: z.string(),
    verifiedAt: z.string(),
  }),
);
