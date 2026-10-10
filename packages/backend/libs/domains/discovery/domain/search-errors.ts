import { AppError, ErrorArea } from '@app/common/errors';
import type { AppErrorParams } from '@app/common/errors/error.types';

/** Problem codes of S32 (FR-001, FR-008, FR-014, FR-051, FR-053). Each class has a stable snake_case `code`. */
export const SEARCH_PROBLEM_CODES = [
  'validation_failed',
  'invalid_price_range',
  'invalid_cursor',
  'semantic_requires_query',
  'unsupported_combination',
  'invalid_search_id',
  'search_unavailable',
  'suggestion_timeout',
  'reindex_in_progress',
  'run_not_found',
  'invalid_transition',
  'no_previous_index',
] as const;
export type SearchProblemCode = (typeof SEARCH_PROBLEM_CODES)[number];

const problem = (
  status: number,
  code: SearchProblemCode,
  title: string,
  detail: string,
  extra: Partial<AppErrorParams> = {},
): AppErrorParams => ({
  status,
  code,
  title,
  detail,
  area: ErrorArea.DOMAIN,
  ...extra,
});

/** `400 validation_failed` naming the offending parameters (never their values). */
export class SearchValidationError extends AppError {
  constructor(readonly fields: string[]) {
    super(
      problem(400, 'validation_failed', 'Bad request', 'The request is not valid.', {
        extensions: {
          errors: fields.map((field) => ({ field, code: 'invalid' })),
        },
      }),
    );
  }
}

export class InvalidPriceRangeError extends AppError {
  constructor() {
    super(
      problem(
        422,
        'invalid_price_range',
        'Unprocessable entity',
        'minPriceMinor must not be greater than maxPriceMinor.',
      ),
    );
  }
}

export class InvalidCursorError extends AppError {
  constructor() {
    super(
      problem(
        422,
        'invalid_cursor',
        'Unprocessable entity',
        'The cursor is not valid for this search.',
      ),
    );
  }
}

export class SemanticRequiresQueryError extends AppError {
  constructor() {
    super(
      problem(
        422,
        'semantic_requires_query',
        'Unprocessable entity',
        'semantic search requires a query.',
      ),
    );
  }
}

export class UnsupportedCombinationError extends AppError {
  constructor(readonly parameters: string[]) {
    super(
      problem(
        422,
        'unsupported_combination',
        'Unprocessable entity',
        'This combination of parameters is not supported.',
        { extensions: { parameters } },
      ),
    );
  }
}

export class InvalidSearchIdError extends AppError {
  constructor() {
    super(
      problem(
        422,
        'invalid_search_id',
        'Unprocessable entity',
        'The searchId is not valid or has expired.',
      ),
    );
  }
}

/** The engine cannot answer and no fallback applies: `503` with `Retry-After`. */
export class SearchUnavailableError extends AppError {
  constructor(cause?: Error) {
    super({
      status: 503,
      code: 'search_unavailable',
      title: 'Service Unavailable',
      detail: 'Search is temporarily unavailable. Please retry.',
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds: 1,
      ...(cause ? { causes: [cause] } : {}),
    });
  }
}

/** A suggestion lookup exceeded its budget; callers answer an empty list rather than fail the page. */
export class SuggestionTimeoutError extends AppError {
  constructor(readonly budgetMs: number) {
    super({
      status: 503,
      code: 'suggestion_timeout',
      title: 'Service Unavailable',
      detail: 'Suggestions timed out.',
      area: ErrorArea.TRANSIENT,
      extensions: { budgetMs },
    });
  }
}

/** A run is already queued, building or catching up (single active run, III.6). */
export class ReindexInProgressError extends AppError {
  constructor(readonly runId: string) {
    super(
      problem(409, 'reindex_in_progress', 'Conflict', 'A reindex run is already active.', {
        extensions: { runId },
      }),
    );
  }
}

export class RunNotFoundError extends AppError {
  constructor() {
    super(problem(404, 'run_not_found', 'Not found', 'No such reindex run.'));
  }
}

/** The run is in a status that does not allow the move (a finished run cannot be cancelled). */
export class InvalidRunTransitionError extends AppError {
  constructor(readonly current: string) {
    super(
      problem(409, 'invalid_transition', 'Conflict', 'The run cannot be cancelled in its current status.', {
        extensions: { status: current },
      }),
    );
  }
}

export class NoPreviousIndexError extends AppError {
  constructor() {
    super(
      problem(409, 'no_previous_index', 'Conflict', 'There is no retained previous index to roll back to.'),
    );
  }
}
