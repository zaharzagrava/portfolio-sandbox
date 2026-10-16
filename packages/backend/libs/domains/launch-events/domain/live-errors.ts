import { HttpStatus } from '@nestjs/common';
import { LIVE_ERROR_STATUS } from '@marketplace-sandbox/contracts';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * Problem codes of the live half of `launch-events` (S23 FR-045). Every error is a `LiveError`; the platform filter
 * renders the problem document. Titles and details are fixed text: no comment, user, store error or token is part of
 * one, and 5xx details are generic.
 */
const DEFINITIONS = {
  stream_not_found: [
    HttpStatus.NOT_FOUND,
    'Not found',
    'Live stream not found.',
  ],
  stream_ended: [HttpStatus.CONFLICT, 'Conflict', 'The live stream has ended.'],
  stream_not_live: [
    HttpStatus.CONFLICT,
    'Conflict',
    'The live stream is not live.',
  ],
  user_muted: [
    HttpStatus.FORBIDDEN,
    'Forbidden',
    'You are muted in this live stream.',
  ],
  comment_blocked: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The comment was blocked by moderation.',
  ],
  client_id_reused: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The clientId was already used with a different comment.',
  ],
  live_unavailable: [
    HttpStatus.SERVICE_UNAVAILABLE,
    'Service Unavailable',
    'The live stream is temporarily unavailable. Retry shortly.',
  ],
  gateway_full: [
    HttpStatus.SERVICE_UNAVAILABLE,
    'Service Unavailable',
    'This server cannot take more viewers. Retry shortly.',
  ],
  product_not_pinnable: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'The product cannot be pinned.',
  ],
  cannot_mute_staff: [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Unprocessable Entity',
    'Staff of the shop cannot be muted.',
  ],
  // The same definition as the discussions' code of that name (one process-wide problem catalog).
  comment_not_found: [
    HttpStatus.NOT_FOUND,
    'Not Found',
    'There is no such comment.',
  ],
} as const;

export type LiveProblemCode = keyof typeof DEFINITIONS;
export const LIVE_ERROR_CODES = Object.keys(DEFINITIONS) as LiveProblemCode[];

// The status of every code is written once in the contracts package; keep the two lists in step.
for (const code of LIVE_ERROR_CODES)
  if (Number(DEFINITIONS[code][0]) !== LIVE_ERROR_STATUS[code])
    throw new Error(`live error ${code}: status differs from the contract`);

export class LiveError extends AppError {
  constructor(
    readonly liveCode: LiveProblemCode,
    options: {
      extensions?: Record<string, unknown>;
      retryAfterSeconds?: number;
    } = {},
  ) {
    const [status, title, detail] = DEFINITIONS[liveCode];
    super({
      status,
      code: liveCode,
      title,
      detail,
      area:
        options.retryAfterSeconds !== undefined
          ? ErrorArea.TRANSIENT
          : ErrorArea.DOMAIN,
      extensions: options.extensions,
      retryAfterSeconds: options.retryAfterSeconds,
    });
  }
}

export const LIVE_PROBLEMS: ProblemCatalogEntry[] = LIVE_ERROR_CODES.map(
  (code) => ({
    code,
    status: DEFINITIONS[code][0],
    title: DEFINITIONS[code][1],
    detail: DEFINITIONS[code][2],
    owner: 'launch-events',
  }),
);

export interface LiveFieldIssue {
  field: string;
  code: string;
}

/** `422` with `errors[]` naming the fields (the code is fixed text, never the submitted value). */
export const liveValidationFailed = (errors: LiveFieldIssue[]) =>
  new AppError({
    code: 'validation_failed',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The request is not valid.',
    area: ErrorArea.DOMAIN,
    extensions: { errors },
  });

/** `400` for a malformed identifier in the path. */
export const liveMalformedId = (field: string) =>
  new AppError({
    code: 'validation_failed',
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The request is not valid.',
    area: ErrorArea.DOMAIN,
    extensions: { errors: [{ field, code: 'invalid_uuid' }] },
  });

export const streamNotFound = () => new LiveError('stream_not_found');
export const streamEnded = () => new LiveError('stream_ended');
export const streamNotLive = () => new LiveError('stream_not_live');
export const userMuted = () => new LiveError('user_muted');
export const commentBlocked = (reason: 'link' | 'policy') =>
  new LiveError('comment_blocked', { extensions: { reason } });
export const clientIdReused = () => new LiveError('client_id_reused');
export const liveUnavailable = () =>
  new LiveError('live_unavailable', { retryAfterSeconds: 2 });
export const gatewayFull = () =>
  new LiveError('gateway_full', { retryAfterSeconds: 5 });
export const productNotPinnable = () => new LiveError('product_not_pinnable');
export const cannotMuteStaff = () => new LiveError('cannot_mute_staff');
export const commentNotFound = () => new LiveError('comment_not_found');
