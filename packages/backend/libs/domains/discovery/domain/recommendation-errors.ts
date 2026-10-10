import { AppError, ErrorArea } from '@app/common/errors';

/** `400 validation_failed` naming the offending parameters (never their values), as `errors: [{field, message}]` (S34 FR-002). */
export class RecommendationsValidationError extends AppError {
  constructor(readonly fields: string[]) {
    super({
      status: 400,
      code: 'validation_failed',
      title: 'Bad request',
      detail: 'The request is not valid.',
      area: ErrorArea.DOMAIN,
      extensions: {
        // `code` is what the platform problem schema requires; `message` is what this contract promises (FR-002)
        errors: fields.map((field) => ({
          field,
          code: 'invalid',
          message: 'is not valid',
        })),
      },
    });
  }
}

/** The requested product is unknown, archived, a sandbox product or in a shop that is not active: one identical answer (FR-004). */
export class RecommendationsProductNotFoundError extends AppError {
  constructor() {
    super({
      status: 404,
      code: 'product_not_found',
      title: 'Not found',
      detail: 'The product does not exist.',
      area: ErrorArea.DOMAIN,
    });
  }
}

/** The list store or a lookup failed or ran over its budget: never an unfiltered list, retry later (FR-012). The cause stays in the log, not in the body. */
export class RecommendationsUnavailableError extends AppError {
  constructor() {
    super({
      status: 503,
      code: 'recommendations_unavailable',
      title: 'Service unavailable',
      detail: 'Recommendations are temporarily unavailable.',
      area: ErrorArea.DOMAIN,
      retryAfterSeconds: 5,
    });
  }
}

/** The payload of the build job is not valid; retrying cannot cure it. */
export class InvalidBuildParamsError extends Error {
  constructor(readonly fields: string[]) {
    super(`invalid build parameters: ${fields.join(', ')}`);
    this.name = 'InvalidBuildParamsError';
  }
}
