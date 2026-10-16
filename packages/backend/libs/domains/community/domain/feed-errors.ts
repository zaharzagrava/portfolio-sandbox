import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * HTTP-visible errors of the follow graph and the feed (specs/domains/S26-follow-feed/contracts/follow-feed-api.md).
 * Every one is an `AppError` with a stable problem `code`, rendered by the global problem+json filter; none carries a
 * store name, query text or stack in its detail (SC-010). `validation_failed` and `invalid_cursor` are raised with the
 * platform's definition; the rate-limit family (`rate_limited`, `rate_limiter_unavailable`, `rate_limit_cost_exceeded`)
 * belongs to the rate limiter.
 */
type Params = ConstructorParameters<typeof AppError>[0];

export const FEED_OWNED_ERROR_CODES = [
  'account_not_found',
  'cannot_follow_self',
  'following_limit_reached',
  'feed_unavailable',
] as const;
export type FeedOwnedErrorCode = (typeof FEED_OWNED_ERROR_CODES)[number];

interface Definition {
  status: HttpStatus;
  title: string;
  detail: string;
}

const DEFINITIONS: Record<FeedOwnedErrorCode, Definition> = {
  account_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'There is no such account to follow.',
  },
  cannot_follow_self: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'You cannot follow yourself.',
  },
  following_limit_reached: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'You follow as many accounts as is allowed.',
  },
  feed_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    title: 'Service Unavailable',
    detail: 'The feed is temporarily unavailable. Retry shortly.',
  },
};

export class FeedError extends AppError {
  constructor(
    readonly feedCode: FeedOwnedErrorCode,
    extra: Partial<Params> = {},
  ) {
    const d = DEFINITIONS[feedCode];
    super({
      status: d.status,
      code: feedCode,
      title: d.title,
      detail: d.detail,
      area: ErrorArea.DOMAIN,
      ...extra,
    });
  }
}

const RETRY_AFTER_SECONDS = 1;

export const accountNotFound = () => new FeedError('account_not_found');
export const cannotFollowSelf = () => new FeedError('cannot_follow_self');
export const followingLimitReached = (limit: number) =>
  new FeedError('following_limit_reached', { extensions: { limit } });
export const feedUnavailable = () =>
  new FeedError('feed_unavailable', {
    retryAfterSeconds: RETRY_AFTER_SECONDS,
  });

export const invalidFeedCursor = () =>
  new AppError({
    status: HttpStatus.BAD_REQUEST,
    code: 'invalid_cursor',
    title: 'Bad Request',
    detail: 'The cursor is not valid for this list.',
    area: ErrorArea.DOMAIN,
  });

/** A field-level validation failure: platform `validation_failed` with the offending fields (never their values). */
export const feedValidationFailed = (fields: string[]) =>
  new AppError({
    status: HttpStatus.BAD_REQUEST,
    code: 'validation_failed',
    title: 'Bad Request',
    detail: 'The request is not valid.',
    area: ErrorArea.DOMAIN,
    extensions: {
      errors: fields.map((field) => ({ field, code: 'invalid' })),
    },
  });

/** Codes this capability owns, registered at module definition (S54 problem catalog). */
export const FEED_PROBLEMS: ProblemCatalogEntry[] = FEED_OWNED_ERROR_CODES.map(
  (code) => ({
    code,
    status: DEFINITIONS[code].status,
    title: DEFINITIONS[code].title,
    detail: DEFINITIONS[code].detail,
    owner: 'community',
  }),
);
