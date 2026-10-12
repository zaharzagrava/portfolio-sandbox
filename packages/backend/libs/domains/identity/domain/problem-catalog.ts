import type { AppError, ProblemCatalogEntry } from '@app/common/errors';
import {
  Domain_CsrfInvalidError,
  Domain_InvalidCredentialsError,
  Domain_InvalidRefreshTokenError,
  Domain_InvalidResetTokenError,
  Domain_InvalidTokenError,
  Domain_OriginNotAllowedError,
  Domain_ServiceCallerNotAllowedError,
  Domain_SessionNotFoundError,
  Domain_UnsupportedMediaTypeError,
  Domain_WeakPasswordError,
} from './errors';

const describe = (error: AppError): ProblemCatalogEntry => ({
  code: error.code,
  status: error.status,
  title: error.title,
  detail: error.message,
  owner: 'identity',
});

/**
 * The stable problem codes of S01 (FR-100). A code is a contract, so each is registered with its definition, taken
 * from the error class itself so the two cannot drift apart. `weak_password` is registered with the generic detail
 * (the breached variant only changes the sentence).
 */
export const identityProblems: ProblemCatalogEntry[] = [
  new Domain_InvalidCredentialsError(),
  new Domain_InvalidTokenError(),
  new Domain_InvalidRefreshTokenError(),
  new Domain_CsrfInvalidError(),
  new Domain_OriginNotAllowedError(),
  new Domain_ServiceCallerNotAllowedError(),
  new Domain_SessionNotFoundError(),
  new Domain_InvalidResetTokenError(),
  new Domain_UnsupportedMediaTypeError(),
  new Domain_WeakPasswordError('too_short'),
].map(describe);
