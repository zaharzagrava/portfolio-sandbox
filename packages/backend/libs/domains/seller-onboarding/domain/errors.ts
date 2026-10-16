import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';
import type { FieldIssue } from './questionnaire';

/**
 * Problem codes of seller onboarding (specs/domains/S04-kyc-onboarding FR-100, contracts/http.md). Every error of the
 * capability is an `OnboardingError`; the platform filter renders the problem document. Titles and details are fixed
 * text: no submitted value, document content, reason or model output is ever part of a message.
 *
 * Not defined here, raised with the owner's definition: `invalid_token` (identity), `permission_denied` and
 * `insufficient_role` (guards), `shop_not_found` (tenancy), `rate_limited` (rate limiter). `validation_failed`,
 * `shop_suspended` and `shop_offboarding` use the platform and tenancy wording and are not registered again.
 */
const DEFINITIONS = {
  validation_failed: [
    HttpStatus.BAD_REQUEST,
    'Bad Request',
    'The request is not valid.',
  ],
  shop_suspended: [HttpStatus.FORBIDDEN, 'Forbidden', 'The shop is suspended.'],
  shop_offboarding: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The shop is being closed.',
  ],
  insufficient_role: [
    HttpStatus.FORBIDDEN,
    'Forbidden',
    'Your role does not allow this change.',
  ],
  conflict_of_interest: [
    HttpStatus.FORBIDDEN,
    'Forbidden',
    'You cannot review a shop you are a member of.',
  ],
  document_not_found: [
    HttpStatus.NOT_FOUND,
    'Not found',
    'Document not found.',
  ],
  review_task_not_found: [
    HttpStatus.NOT_FOUND,
    'Not found',
    'Review task not found.',
  ],
  already_submitted: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The application was already submitted and can no longer be edited.',
  ],
  submission_required: [
    HttpStatus.CONFLICT,
    'Conflict',
    'Submit the questionnaire before uploading documents.',
  ],
  resubmission_required: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The application was rejected; submit it again before uploading documents.',
  ],
  already_verified: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The shop is already verified.',
  ],
  document_already_approved: [
    HttpStatus.CONFLICT,
    'Conflict',
    'A document of this kind is already approved.',
  ],
  // Not `document_limit_reached`: that code is the assistant's knowledge-base limit (422) and codes are unique platform-wide.
  onboarding_document_limit_reached: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The maximum number of documents of this kind was reached.',
  ],
  upload_not_received: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The file has not been received yet.',
  ],
  task_already_resolved: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The review task is already resolved.',
  ],
  document_superseded: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The document was replaced by a newer one.',
  ],
  document_not_required: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'This kind of document is not required for this application.',
  ],
  upload_mismatch: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The uploaded file does not match the declared size.',
  ],
  iban_invalid: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The IBAN is not valid.',
  ],
  vat_invalid: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The VAT number is not valid for the business country.',
  ],
  missing_fields: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'Required fields of the document are missing.',
  ],
} as const;

export type OnboardingProblemCode = keyof typeof DEFINITIONS;
export const ONBOARDING_ERROR_CODES = Object.keys(
  DEFINITIONS,
) as OnboardingProblemCode[];

/** Codes whose wording belongs to the platform or to tenancy: raised here, registered by their owner. */
const NOT_OWNED: OnboardingProblemCode[] = [
  'validation_failed',
  'shop_suspended',
  'shop_offboarding',
  'insufficient_role',
];

export class OnboardingError extends AppError {
  constructor(
    readonly onboardingCode: OnboardingProblemCode,
    options: { errors?: FieldIssue[]; missingSteps?: string[] } = {},
  ) {
    const [status, title, detail] = DEFINITIONS[onboardingCode];
    super({
      status,
      code: onboardingCode,
      title,
      detail,
      area: ErrorArea.DOMAIN,
      ...(options.errors || options.missingSteps
        ? {
            extensions: {
              ...(options.errors ? { errors: options.errors } : {}),
              ...(options.missingSteps
                ? { missingSteps: options.missingSteps }
                : {}),
            },
          }
        : {}),
    });
  }
}

export const onboardingProblem = (
  code: OnboardingProblemCode,
  options?: { errors?: FieldIssue[]; missingSteps?: string[] },
) => new OnboardingError(code, options);

/** `400 validation_failed` with `errors: [{path, message}]` (messages are fixed text, never the submitted value). */
export const validationFailed = (
  errors: FieldIssue[],
  missingSteps?: string[],
) => new OnboardingError('validation_failed', { errors, missingSteps });

export const insufficientRole = () => new OnboardingError('insufficient_role');
export const conflictOfInterest = () =>
  new OnboardingError('conflict_of_interest');
export const documentNotFound = () => new OnboardingError('document_not_found');
export const reviewTaskNotFound = () =>
  new OnboardingError('review_task_not_found');
export const alreadySubmitted = () => new OnboardingError('already_submitted');
export const submissionRequired = () =>
  new OnboardingError('submission_required');
export const resubmissionRequired = () =>
  new OnboardingError('resubmission_required');
export const alreadyVerified = () => new OnboardingError('already_verified');
export const documentAlreadyApproved = () =>
  new OnboardingError('document_already_approved');
export const documentLimitReached = () =>
  new OnboardingError('onboarding_document_limit_reached');
export const uploadNotReceived = () =>
  new OnboardingError('upload_not_received');
export const taskAlreadyResolved = () =>
  new OnboardingError('task_already_resolved');
export const documentSuperseded = () =>
  new OnboardingError('document_superseded');
export const documentNotRequired = () =>
  new OnboardingError('document_not_required');
export const uploadMismatch = () => new OnboardingError('upload_mismatch');
export const ibanInvalid = () => new OnboardingError('iban_invalid');
export const vatInvalid = () => new OnboardingError('vat_invalid');
export const missingFields = () => new OnboardingError('missing_fields');

export const ONBOARDING_PROBLEMS: ProblemCatalogEntry[] =
  ONBOARDING_ERROR_CODES.filter((code) => !NOT_OWNED.includes(code)).map(
    (code) => ({
      code,
      status: DEFINITIONS[code][0],
      title: DEFINITIONS[code][1],
      detail: DEFINITIONS[code][2],
      owner: 'seller-onboarding',
    }),
  );
