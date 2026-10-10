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

// ---- S02: second factor, OIDC, identities (FR-100 stable codes) ----

class Conflict extends AppError {
  constructor(code: string, detail: string) {
    super({
      status: HttpStatus.CONFLICT,
      code,
      title: 'Conflict',
      detail,
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_MfaAlreadyEnabledError extends Conflict {
  constructor() {
    super('mfa_already_enabled', 'A second factor is already turned on.');
  }
}

export class Domain_MfaNotPendingError extends Conflict {
  constructor() {
    super('mfa_not_pending', 'There is no enrolment waiting for a code.');
  }
}

export class Domain_MfaNotEnabledError extends Conflict {
  constructor() {
    super('mfa_not_enabled', 'No second factor is turned on.');
  }
}

export class Domain_LastLoginMethodError extends Conflict {
  constructor() {
    super(
      'last_login_method',
      'This is the only way to sign in to the account.',
    );
  }
}

/** A wrong code in a management call (confirm, regenerate, disable, link step-up). */
export class Domain_InvalidCodeError extends AppError {
  constructor() {
    super({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'invalid_code',
      title: 'Invalid code',
      detail: 'The code is not valid.',
      area: ErrorArea.DOMAIN,
    });
  }
}

/** A wrong code at login: identical for every kind of mismatch. */
export class Domain_InvalidMfaCodeError extends AppError {
  constructor() {
    super({
      status: HttpStatus.UNAUTHORIZED,
      code: 'invalid_mfa_code',
      title: 'Unauthorized',
      detail: 'The code is not valid.',
      area: ErrorArea.DOMAIN,
    });
  }
}

/** Every defect of a challenge (expired, tampered, spent, burned, wrong user state) is this one answer. */
export class Domain_InvalidMfaChallengeError extends AppError {
  constructor() {
    super({
      status: HttpStatus.UNAUTHORIZED,
      code: 'invalid_mfa_challenge',
      title: 'Unauthorized',
      detail: 'The sign-in step expired. Sign in again.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_OriginNotAllowedError extends AppError {
  constructor() {
    super({
      status: HttpStatus.FORBIDDEN,
      code: 'origin_not_allowed',
      title: 'Forbidden',
      detail: 'This origin is not allowed.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_UnsupportedMediaTypeError extends AppError {
  constructor() {
    super({
      status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      code: 'unsupported_media_type',
      title: 'Unsupported Media Type',
      detail: 'The request body must be application/json.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_OidcProviderNotFoundError extends AppError {
  constructor() {
    super({
      status: HttpStatus.NOT_FOUND,
      code: 'oidc_provider_not_found',
      title: 'Not Found',
      detail: 'No such sign-in provider.',
      area: ErrorArea.DOMAIN,
    });
  }
}

export class Domain_OidcProviderUnavailableError extends AppError {
  constructor() {
    super({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'oidc_provider_unavailable',
      title: 'Service Unavailable',
      detail: 'The sign-in provider is not reachable. Try again shortly.',
      area: ErrorArea.TRANSIENT,
      retryAfterSeconds: 5,
    });
  }
}

export class Domain_IdentityNotFoundError extends AppError {
  constructor() {
    super({
      status: HttpStatus.NOT_FOUND,
      code: 'identity_not_found',
      title: 'Not Found',
      detail: 'No such linked sign-in method.',
      area: ErrorArea.DOMAIN,
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
