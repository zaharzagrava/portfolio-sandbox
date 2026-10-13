import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';
import type { ProblemCatalogEntry } from '@app/common/errors';

/**
 * HTTP-visible errors of notifications (specs/domains/S28-notifications/contracts/http.md). Every one is an `AppError`
 * with a stable `code`; none carries a token, address, phone number or code in its detail.
 */
type Params = ConstructorParameters<typeof AppError>[0];

const domainError = (
  status: HttpStatus,
  code: string,
  title: string,
  detail: string,
  extra: Partial<Params> = {},
): Params => ({
  status,
  code,
  title,
  detail,
  area: ErrorArea.DOMAIN,
  ...extra,
});

export const NOTIFICATION_ERROR_CODES = [
  'invalid_cursor',
  'invalid_unsubscribe_token',
  'phone_not_verified',
  'phone_missing',
  'quiet_hours_incomplete',
  'quiet_hours_invalid',
  'code_invalid',
  'code_expired',
  'code_not_requested',
  'phone_unreachable',
  'verification_locked',
  'device_not_found',
  'rate_limited',
] as const;
export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number];

interface Definition {
  status: HttpStatus;
  title: string;
  detail: string;
}

const DEFINITIONS: Record<NotificationErrorCode, Definition> = {
  invalid_cursor: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The cursor is not valid for this list.',
  },
  invalid_unsubscribe_token: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Bad Request',
    detail: 'The unsubscribe link is not valid.',
  },
  phone_not_verified: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'Verify your phone number before turning on SMS.',
  },
  phone_missing: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'Add a phone number first.',
  },
  quiet_hours_incomplete: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'Quiet hours need both a start and an end.',
  },
  quiet_hours_invalid: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The quiet hours start and end must differ.',
  },
  code_invalid: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The verification code is wrong.',
  },
  code_expired: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The verification code has expired.',
  },
  code_not_requested: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'No verification code was requested.',
  },
  phone_unreachable: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    title: 'Unprocessable Entity',
    detail: 'The phone number cannot receive messages.',
  },
  verification_locked: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    title: 'Too Many Requests',
    detail: 'Too many wrong codes; try again later.',
  },
  device_not_found: {
    status: HttpStatus.NOT_FOUND,
    title: 'Not Found',
    detail: 'Device not found.',
  },
  rate_limited: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    title: 'Too Many Requests',
    detail: 'Too many requests; try again later.',
  },
};

export class NotificationError extends AppError {
  constructor(
    readonly reason: NotificationErrorCode,
    extra: Partial<Params> = {},
  ) {
    const d = DEFINITIONS[reason];
    super(domainError(d.status, reason, d.title, d.detail, extra));
  }
}

export const invalidCursor = () => new NotificationError('invalid_cursor');
export const invalidUnsubscribeToken = () =>
  new NotificationError('invalid_unsubscribe_token');
export const phoneNotVerified = () =>
  new NotificationError('phone_not_verified');
export const phoneMissing = () => new NotificationError('phone_missing');
export const quietHoursIncomplete = () =>
  new NotificationError('quiet_hours_incomplete');
export const quietHoursInvalid = () =>
  new NotificationError('quiet_hours_invalid');
export const codeInvalid = (attemptsLeft: number) =>
  new NotificationError('code_invalid', { extensions: { attemptsLeft } });
export const codeExpired = () => new NotificationError('code_expired');
export const codeNotRequested = () =>
  new NotificationError('code_not_requested');
export const phoneUnreachable = () =>
  new NotificationError('phone_unreachable');
export const verificationLocked = (retryAfterSeconds: number) =>
  new NotificationError('verification_locked', { retryAfterSeconds });
export const deviceNotFound = () => new NotificationError('device_not_found');

/** `invalid_cursor` is shared with other domains and `rate_limited` belongs to the rate limiter: neither is registered here. */
const NOT_OWNED: NotificationErrorCode[] = ['invalid_cursor', 'rate_limited'];

/** Codes this domain owns, registered at module definition (S54 problem catalog). */
export const NOTIFICATION_PROBLEMS: ProblemCatalogEntry[] =
  NOTIFICATION_ERROR_CODES.filter((code) => !NOT_OWNED.includes(code)).map(
    (code) => ({
      code,
      status: DEFINITIONS[code].status,
      title: DEFINITIONS[code].title,
      detail: DEFINITIONS[code].detail,
      owner: 'notifications',
    }),
  );
