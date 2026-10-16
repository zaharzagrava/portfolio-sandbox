import { z } from 'zod';
import {
  ONBOARDING_COUNTRIES,
  ONBOARDING_STEP_NAMES,
  onboardingStepSchemas,
} from '@marketplace-sandbox/contracts';
import { isValidVat } from './validators';

export const EU_COUNTRIES = ONBOARDING_COUNTRIES;

/**
 * The staged questionnaire (S04 FR-001, A15, A16). The four step schemas are the strict contract schemas (an unknown
 * field is refused; each step is valid on its own so it can be saved half-way through the flow); this module adds the
 * cross-step rules that need the whole set, applied again on submit.
 */
export const STEPS = onboardingStepSchemas;

export type StepName = keyof typeof STEPS;
export const STEP_NAMES: StepName[] = [...ONBOARDING_STEP_NAMES];

export type Answers = { [K in StepName]: z.infer<(typeof STEPS)[K]> };

/**
 * All four steps plus the cross-step rules: a VAT number is present exactly when VAT registered, and it is valid for
 * the business country. Messages never contain the submitted values.
 */
export const AnswersSchema = z.strictObject(STEPS).superRefine((a, ctx) => {
  const { vatRegistered, vatNumber } = a.tax;
  if (vatRegistered && !vatNumber)
    ctx.addIssue({
      code: 'custom',
      path: ['tax', 'vatNumber'],
      message: 'VAT number is required when VAT registered',
    });
  else if (!vatRegistered && vatNumber)
    ctx.addIssue({
      code: 'custom',
      path: ['tax', 'vatNumber'],
      message: 'VAT number requires VAT registration',
    });
  else if (vatNumber && !isValidVat(a.business.country, vatNumber))
    ctx.addIssue({
      code: 'custom',
      path: ['tax', 'vatNumber'],
      message: 'VAT number is not valid for the business country',
    });
});

export interface FieldIssue {
  path: string;
  message: string;
}

/** `{path, message}` list of a zod failure; messages are fixed text (never a submitted value); an unknown field is named by its truncated key. */
export function fieldIssues(error: z.ZodError, prefix?: string): FieldIssue[] {
  const at = (path: PropertyKey[]) =>
    [...(prefix ? [prefix] : []), ...path.map(String)].join('.');
  return error.issues.flatMap((i): FieldIssue[] =>
    i.code === 'unrecognized_keys'
      ? i.keys.map((key) => ({
          path: at([...i.path, key.slice(0, 60)]),
          message: 'Unknown field',
        }))
      : [{ path: at(i.path), message: i.message }],
  );
}

/** Per-step and cross-step problems of a full answer set; empty when valid. */
export function answerIssues(answers: unknown): FieldIssue[] {
  const parsed = AnswersSchema.safeParse(answers);
  return parsed.success ? [] : fieldIssues(parsed.error);
}

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
