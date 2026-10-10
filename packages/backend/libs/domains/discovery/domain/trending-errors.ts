import { AppError, ErrorArea } from '@app/common/errors';

/** `400 validation_failed` naming the offending parameters (never their values), as `errors: [{field, message}]` (S35 FR-002). */
export class TrendingValidationError extends AppError {
  constructor(readonly fields: string[]) {
    super({
      status: 400,
      code: 'validation_failed',
      title: 'Bad request',
      detail: 'The request is not valid.',
      area: ErrorArea.DOMAIN,
      extensions: {
        errors: fields.map((field) => ({
          field,
          code: 'invalid',
          message: 'is not valid',
        })),
      },
    });
  }
}

export type TrendingDependency = 'aggregate' | 'product' | 'shop' | 'cache';

/** A named dependency failed or ran over its budget; the service turns it into the one 503 and counts it per dependency. */
export class TrendingDependencyError extends Error {
  constructor(
    readonly dependency: TrendingDependency,
    readonly cause?: unknown,
  ) {
    super(`${dependency} failed`);
    this.name = 'TrendingDependencyError';
  }
}

/** The aggregate store or a lookup failed or ran over its budget: never an unfiltered list, retry later (FR-010). */
export class TrendingUnavailableError extends AppError {
  constructor() {
    super({
      status: 503,
      code: 'trending_unavailable',
      title: 'Service unavailable',
      detail: 'Trending is temporarily unavailable.',
      area: ErrorArea.DOMAIN,
      retryAfterSeconds: 5,
    });
  }
}
