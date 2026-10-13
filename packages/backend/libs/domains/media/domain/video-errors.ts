import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * Failure codes and HTTP-visible errors of the product videos (S30; data-model.md "failureCode vocabulary",
 * contracts/video-api.md "Problem codes"). Pure: no infra.
 *
 * Exports:
 *  - `RETRYABLE_FAILURE_CODES`, `PERMANENT_FAILURE_CODES`, `FAILURE_CODES`, `FailureCode`, `isFailureCode(x)`,
 *    `isRetryable(code)`: the closed vocabulary stored in `Video.failureCode` (CHECK) and returned to the owner.
 *  - `VIDEO_PROBLEM_CODES`/`VideoProblemCode`: every code of the API contract, `VIDEO_PROBLEM_DEFINITIONS` (code ->
 *    status/title/detail), `VIDEO_PROBLEMS` (catalog entries this domain owns, for `ProblemCatalogModule.forFeature`).
 *  - `VideoError(code, extra?)` and one factory per frequent code. Details are generic: none echoes a key, an
 *    upload id, an encoder message or an id the caller does not own.
 */
export const RETRYABLE_FAILURE_CODES = [
  'transcode_failed',
  'task_timeout',
  'storage_unavailable',
  'processing_timeout',
] as const;

export const PERMANENT_FAILURE_CODES = [
  'not_a_video',
  'no_video_stream',
  'duration_exceeded',
  'duration_too_short',
  'resolution_exceeded',
  'source_size_mismatch',
] as const;

export type RetryableFailureCode = (typeof RETRYABLE_FAILURE_CODES)[number];
export type PermanentFailureCode = (typeof PERMANENT_FAILURE_CODES)[number];

export const FAILURE_CODES = [
  ...RETRYABLE_FAILURE_CODES,
  ...PERMANENT_FAILURE_CODES,
] as const;
export type FailureCode = RetryableFailureCode | PermanentFailureCode;

export const isFailureCode = (value: unknown): value is FailureCode =>
  typeof value === 'string' &&
  (FAILURE_CODES as readonly string[]).includes(value);

/** Only these may be retried by the seller (`POST .../retry`); unknown or missing codes never are. */
export const isRetryable = (
  code: string | null | undefined,
): code is RetryableFailureCode =>
  typeof code === 'string' &&
  (RETRYABLE_FAILURE_CODES as readonly string[]).includes(code);

export const VIDEO_PROBLEM_CODES = [
  'validation_failed',
  'invalid_cursor',
  'permission_denied',
  'shop_suspended',
  'video_not_found',
  'product_not_found',
  'shop_offboarding',
  'product_archived',
  'pending_uploads_limit',
  'upload_incomplete',
  'upload_closed',
  'upload_expired',
  'version_conflict',
  'product_video_limit',
  'not_retryable',
  'retry_limit',
  'source_purged',
  'invalid_state',
  'parts_mismatch',
  'rate_limited',
  'storage_unavailable',
  'service_unavailable',
] as const;
export type VideoProblemCode = (typeof VIDEO_PROBLEM_CODES)[number];

interface Definition {
  status: HttpStatus;
  title: string;
  detail: string;
}

const BAD_REQUEST = { status: HttpStatus.BAD_REQUEST, title: 'Bad Request' };
const FORBIDDEN = { status: HttpStatus.FORBIDDEN, title: 'Forbidden' };
const NOT_FOUND = { status: HttpStatus.NOT_FOUND, title: 'Not Found' };
const CONFLICT = { status: HttpStatus.CONFLICT, title: 'Conflict' };
const UNAVAILABLE = {
  status: HttpStatus.SERVICE_UNAVAILABLE,
  title: 'Service Unavailable',
};

export const VIDEO_PROBLEM_DEFINITIONS: Record<VideoProblemCode, Definition> = {
  validation_failed: { ...BAD_REQUEST, detail: 'The request is not valid.' },
  invalid_cursor: {
    ...BAD_REQUEST,
    detail: 'The cursor is not valid for this list.',
  },
  permission_denied: {
    ...FORBIDDEN,
    detail: 'You do not have permission to do this.',
  },
  shop_suspended: { ...FORBIDDEN, detail: 'The shop is suspended.' },
  video_not_found: { ...NOT_FOUND, detail: 'There is no such video.' },
  product_not_found: { ...NOT_FOUND, detail: 'Product not found.' },
  shop_offboarding: { ...CONFLICT, detail: 'The shop is being closed.' },
  product_archived: {
    ...CONFLICT,
    detail: 'An archived product cannot be edited; restore it first.',
  },
  // same wording as the photos (S29) so the shared catalog entry is identical
  pending_uploads_limit: {
    ...CONFLICT,
    detail:
      'Too many uploads are waiting to be completed. Finish or delete some first.',
  },
  upload_incomplete: {
    ...CONFLICT,
    detail:
      'The file has not arrived in storage yet. Upload it, then confirm again.',
  },
  upload_closed: { ...CONFLICT, detail: 'This upload is already closed.' },
  upload_expired: {
    ...CONFLICT,
    detail: 'This upload expired. Start a new one.',
  },
  version_conflict: {
    ...CONFLICT,
    detail: 'The video was changed by someone else; reload it and retry.',
  },
  product_video_limit: {
    ...CONFLICT,
    detail: 'This product already has the maximum number of videos.',
  },
  not_retryable: {
    ...CONFLICT,
    detail: 'This video cannot be processed again; upload it again.',
  },
  retry_limit: {
    ...CONFLICT,
    detail: 'This video was already retried the maximum number of times.',
  },
  source_purged: {
    ...CONFLICT,
    detail: 'The original file is no longer kept; upload the video again.',
  },
  invalid_state: {
    ...CONFLICT,
    detail: 'The video is not in a state that allows this.',
  },
  parts_mismatch: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The uploaded parts do not match the list you sent.',
  },
  rate_limited: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    title: 'Too Many Requests',
    detail: 'Too many requests. Try again later.',
  },
  storage_unavailable: {
    ...UNAVAILABLE,
    detail: 'Storage is temporarily unavailable. Try again in a moment.',
  },
  service_unavailable: {
    ...UNAVAILABLE,
    detail: 'The service is temporarily unavailable. Try again in a moment.',
  },
};

type Params = ConstructorParameters<typeof AppError>[0];

export class VideoError extends AppError {
  constructor(
    readonly videoCode: VideoProblemCode,
    extra: Partial<Params> = {},
  ) {
    const d = VIDEO_PROBLEM_DEFINITIONS[videoCode];
    super({
      status: d.status,
      code: videoCode,
      title: d.title,
      detail: d.detail,
      area: ErrorArea.DOMAIN,
      ...extra,
    });
  }
}

export const videoNotFound = () => new VideoError('video_not_found');
export const uploadIncomplete = (missingParts: number[]) =>
  new VideoError('upload_incomplete', { extensions: { missingParts } });
/** `status` of a problem document is the HTTP status (RFC 9457): the video's own status travels as `videoStatus`. */
export const uploadClosed = (status: string) =>
  new VideoError('upload_closed', { extensions: { videoStatus: status } });
export const uploadExpired = () => new VideoError('upload_expired');
export const partsMismatch = () => new VideoError('parts_mismatch');
export const invalidState = (status: string) =>
  new VideoError('invalid_state', { extensions: { videoStatus: status } });
export const pendingUploadsLimit = (limit: number, current: number) =>
  new VideoError('pending_uploads_limit', { extensions: { limit, current } });
export const versionConflict = (currentVersion: number) =>
  new VideoError('version_conflict', { extensions: { currentVersion } });
export const productVideoLimit = () => new VideoError('product_video_limit');
export const notRetryable = () => new VideoError('not_retryable');
export const retryLimit = () => new VideoError('retry_limit');
export const sourcePurged = () => new VideoError('source_purged');
export const productNotFound = () => new VideoError('product_not_found');
export const productArchived = () => new VideoError('product_archived');
export const invalidCursor = () => new VideoError('invalid_cursor');
export const storageUnavailable = () => new VideoError('storage_unavailable');
export const serviceUnavailable = () => new VideoError('service_unavailable');
export const validationFailed = (fields: string[]) =>
  new VideoError('validation_failed', {
    extensions: { errors: fields.map((field) => ({ field, code: 'invalid' })) },
  });

/** Codes another capability or the platform already owns: raised here, registered by their owner. */
const NOT_OWNED: VideoProblemCode[] = [
  'validation_failed',
  'invalid_cursor',
  'permission_denied',
  'shop_suspended',
  'shop_offboarding',
  'product_not_found',
  'product_archived',
  'version_conflict',
  'rate_limited',
  'service_unavailable',
];

export const VIDEO_PROBLEMS: ProblemCatalogEntry[] = VIDEO_PROBLEM_CODES.filter(
  (code) => !NOT_OWNED.includes(code),
).map((code) => ({
  code,
  status: VIDEO_PROBLEM_DEFINITIONS[code].status,
  title: VIDEO_PROBLEM_DEFINITIONS[code].title,
  detail: VIDEO_PROBLEM_DEFINITIONS[code].detail,
  owner: 'media',
}));
