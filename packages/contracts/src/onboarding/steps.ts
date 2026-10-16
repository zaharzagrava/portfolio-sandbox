import { z } from 'zod';

/** S04 seller onboarding questionnaire (specs/domains/S04-kyc-onboarding FR-001, contracts/http.md). */
export const ONBOARDING_COUNTRIES = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;

export const ONBOARDING_STEP_NAMES = [
  'business',
  'tax',
  'catalog',
  'policies',
] as const;
export const onboardingStepParamSchema = z.enum(ONBOARDING_STEP_NAMES);
export type OnboardingStepName = z.infer<typeof onboardingStepParamSchema>;

/** One strict schema per step: an unknown field is refused. */
export const onboardingStepSchemas = {
  business: z.strictObject({
    legalForm: z.enum([
      'SOLE_TRADER',
      'PARTNERSHIP',
      'LIMITED_COMPANY',
      'OTHER',
    ]),
    businessName: z.string().trim().min(2).max(200),
    country: z.enum(ONBOARDING_COUNTRIES),
    registrationNumber: z.string().trim().min(2).max(50),
  }),
  tax: z.strictObject({
    vatRegistered: z.boolean(),
    // A blank number is no number.
    vatNumber: z
      .string()
      .trim()
      .max(20)
      .nullable()
      .transform((v) => v || null),
  }),
  catalog: z.strictObject({
    categories: z.array(z.string().trim().min(2).max(60)).min(1).max(10),
    expectedMonthlyOrders: z.enum([
      'UNDER_100',
      'UNDER_1000',
      'UNDER_10000',
      'OVER_10000',
    ]),
  }),
  policies: z.strictObject({
    returnsDays: z.number().int().min(14).max(365),
    shipsFrom: z.enum(ONBOARDING_COUNTRIES),
  }),
} as const;

export type OnboardingAnswers = {
  [K in OnboardingStepName]: z.infer<(typeof onboardingStepSchemas)[K]>;
};

/** Saved steps so far (a draft) or all of them (submitted). */
export const onboardingDraftAnswersSchema = z.strictObject({
  business: onboardingStepSchemas.business.optional(),
  tax: onboardingStepSchemas.tax.optional(),
  catalog: onboardingStepSchemas.catalog.optional(),
  policies: onboardingStepSchemas.policies.optional(),
});
