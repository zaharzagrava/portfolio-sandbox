import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/** One answer for every way a presented access token can be wrong (FR-021, AS-24); the reason stays server-side. */
export class Domain_InvalidTokenError extends AppError {
  constructor(readonly reason: string = 'invalid') {
    super({
      status: HttpStatus.UNAUTHORIZED,
      code: 'invalid_token',
      title: 'Unauthorized',
      detail: 'The request could not be authenticated.',
      area: ErrorArea.DOMAIN,
      headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
    });
  }
}

export class Domain_InvalidCredentialsError extends AppError {
  constructor() {
    super({
      status: HttpStatus.UNAUTHORIZED,
      code: 'invalid_credentials',
      title: 'Unauthorized',
      detail: 'Invalid email or password.',
      area: ErrorArea.DOMAIN,
    });
  }
}

/** Every refresh failure (unknown, spent, expired, revoked) is this one answer; reuse is audited server-side. */
export class Domain_InvalidRefreshTokenError extends AppError {
  constructor() {
    super({
      status: HttpStatus.UNAUTHORIZED,
      code: 'invalid_refresh_token',
      title: 'Unauthorized',
      detail: 'The refresh token is invalid or expired.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_WeakPasswordError extends AppError {
  constructor(reason: 'too_short' | 'too_long' | 'is_email' | 'breached') {
    super({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'weak_password',
      title: 'Weak password',
      detail:
        reason === 'breached'
          ? 'This password appears in known data breaches. Choose another.'
          : 'The password does not meet the password policy.',
      area: ErrorArea.DOMAIN,
      extensions: { reason },
    });
  }
}

export class Domain_PayloadTooLargeError extends AppError {
  constructor() {
    super({
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      code: 'payload_too_large',
      title: 'Payload Too Large',
      detail: 'The request body is too large.',
      area: ErrorArea.DOMAIN,
    });
  }
}

/** A sensitive route could not check for revocation: refuse rather than guess (FR-025). */
export class Domain_RevocationCheckUnavailableError extends AppError {
  constructor() {
    super({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'overloaded',
      title: 'Service Unavailable',
      detail: 'The service is busy. Retry shortly.',
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds: 1,
    });
  }
}

/** Hash queue full: shed instead of letting the worker pool starve (A12, A13). */
export class Domain_OverloadedError extends AppError {
  constructor() {
    super({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'overloaded',
      title: 'Service Unavailable',
      detail: 'The service is busy. Retry shortly.',
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds: 1,
    });
  }
}
