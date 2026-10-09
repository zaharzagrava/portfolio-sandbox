import { z } from 'zod';

export const EU_COUNTRIES = [
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

/**
 * The staged questionnaire (10/02 Example 6): every step validates on its
 * own (so a step can be saved half-way through the flow), and the whole set
 * is re-validated together on submit (cross-step rules).
 */
export const STEPS = {
  business: z.object({
    legalForm: z.enum([
      'SOLE_TRADER',
      'PARTNERSHIP',
      'LIMITED_COMPANY',
      'OTHER',
    ]),
    businessName: z.string().trim().min(2).max(200),
    country: z.enum(EU_COUNTRIES),
    registrationNumber: z.string().trim().min(2).max(50),
  }),
  tax: z.object({
    vatRegistered: z.boolean(),
    vatNumber: z.string().trim().max(20).nullable(),
  }),
  catalog: z.object({
    categories: z.array(z.string().trim().min(2).max(60)).min(1).max(10),
    expectedMonthlyOrders: z.enum([
      'UNDER_100',
      'UNDER_1000',
      'UNDER_10000',
      'OVER_10000',
    ]),
  }),
  policies: z.object({
    returnsDays: z.number().int().min(14).max(365),
    shipsFrom: z.enum(EU_COUNTRIES),
  }),
} as const;

export type StepName = keyof typeof STEPS;
export const STEP_NAMES = Object.keys(STEPS) as StepName[];

export type Answers = { [K in StepName]: z.infer<(typeof STEPS)[K]> };

export const AnswersSchema = z
  .object(STEPS)
  .refine((a) => !a.tax.vatRegistered || !!a.tax.vatNumber, {
    message: 'VAT number is required when VAT registered',
    path: ['tax', 'vatNumber'],
  });

export type DocumentKind =
  'BUSINESS_REGISTRATION' | 'VAT_CERTIFICATE' | 'BANK_STATEMENT';

/** What must be APPROVED before the shop is verified - derived from the answers, not hard-coded per plan. */
export function requiredDocuments(answers: Answers): DocumentKind[] {
  return [
    'BUSINESS_REGISTRATION',
    'BANK_STATEMENT',
    ...(answers.tax.vatRegistered ? (['VAT_CERTIFICATE'] as const) : []),
  ];
}
