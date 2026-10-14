import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';
import type { DefinitionProblem } from './experiment-types';

/**
 * HTTP-visible errors of analytics and experiments (specs/domains/S39-analytics-ab/contracts). Each is an `AppError` with a
 * stable problem `code` rendered by the global problem+json filter; none echoes a body, a prop value or a store text.
 */
interface Definition {
  status: HttpStatus;
  title: string;
  detail: string;
  retryAfterSeconds?: number;
}

const DEFINITIONS = {
  validation_failed: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The request is not valid.',
  },
  not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such experiment.',
  },
  version_conflict: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The experiment changed since you read it. Reload and try again.',
  },
  experiment_immutable: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail:
      'Variants, weights, layer, range, unit and metric cannot change once an experiment has started.',
  },
  illegal_transition: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'The experiment is not in a state that allows this change.',
  },
  layer_range_conflict: {
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail:
      'A running experiment of this layer already owns part of the range.',
  },
  experiment_definition_invalid: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The experiment definition is not valid.',
  },
  experiment_limit_reached: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The maximum number of experiments has been reached.',
  },
  invalid_cursor: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The cursor is not valid for this list.',
  },
  analytics_store_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The analytics store did not answer. Try again shortly.',
    retryAfterSeconds: 5,
  },
  payload_too_large: {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    title: 'Payload Too Large',
    detail: 'The request body is too large.',
  },
  unsupported_media_type: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    title: 'Unsupported Media Type',
    detail: 'The content type must be application/json or text/plain.',
  },
  ingest_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail:
      'The events could not be recorded. Send the same batch again shortly.',
    retryAfterSeconds: 5,
  },
} as const satisfies Record<string, Definition>;

export type ExperimentProblem = keyof typeof DEFINITIONS;

export class ExperimentError extends AppError {
  constructor(
    readonly problem: ExperimentProblem,
    extensions: Record<string, unknown> = {},
  ) {
    const d: Definition = DEFINITIONS[problem];
    super({
      status: d.status,
      code: problem,
      title: d.title,
      detail: d.detail,
      area: ErrorArea.DOMAIN,
      ...(Object.keys(extensions).length > 0 && { extensions }),
      ...(d.retryAfterSeconds && { retryAfterSeconds: d.retryAfterSeconds }),
    });
  }
}

/** The ingest routes' own failures: a batch the stream did not acknowledge, an oversized body, a wrong content type. */
export class IngestError extends ExperimentError {}

export const experimentNotFound = () => new ExperimentError('not_found');
export const versionConflict = (currentVersion: number) =>
  new ExperimentError('version_conflict', { currentVersion });
export const experimentImmutable = () =>
  new ExperimentError('experiment_immutable');
export const illegalTransition = (currentStatus: string) =>
  new ExperimentError('illegal_transition', { currentStatus });
export const layerRangeConflict = (blockingKey: string | null) =>
  new ExperimentError('layer_range_conflict', { blockingKey });
/** `errors[]` carries `path` and `field` (the platform's problem schema requires `field`): the same value. */
export const experimentDefinitionInvalid = (errors: DefinitionProblem[]) =>
  new ExperimentError('experiment_definition_invalid', {
    errors: errors.map((e) => ({ field: e.path, ...e })),
  });
export const experimentLimitReached = () =>
  new ExperimentError('experiment_limit_reached');
export const invalidCursor = () => new ExperimentError('invalid_cursor');
export const analyticsStoreUnavailable = () =>
  new ExperimentError('analytics_store_unavailable');
export const payloadTooLarge = () => new IngestError('payload_too_large');
export const unsupportedMediaType = () =>
  new IngestError('unsupported_media_type');
export const ingestUnavailable = () => new IngestError('ingest_unavailable');

/** A field-level shape failure: platform `validation_failed` with the offending fields (never their values). */
export const validationFailed = (fields: string[]) =>
  new ExperimentError('validation_failed', {
    errors: fields.map((field) => ({ field, code: 'invalid' })),
  });

/**
 * Codes owned by the platform or registered first by another capability with its own wording are not registered again
 * (a second definition with other words would fail startup).
 */
const NOT_OWNED: ExperimentProblem[] = [
  'validation_failed',
  'not_found',
  'payload_too_large',
  'unsupported_media_type',
  'invalid_cursor',
  'version_conflict',
];

export const EXPERIMENT_PROBLEMS: ProblemCatalogEntry[] = (
  Object.keys(DEFINITIONS) as ExperimentProblem[]
)
  .filter((code) => !NOT_OWNED.includes(code))
  .map((code) => ({
    code,
    status: DEFINITIONS[code].status,
    title: DEFINITIONS[code].title,
    detail: DEFINITIONS[code].detail,
    owner: 'experimentation',
  }));
