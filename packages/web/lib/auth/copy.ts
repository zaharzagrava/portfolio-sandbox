import type { Problem } from '@/lib/api/errors';
import { waitSentence } from './retry-after';

/**
 * The only source of text for W01 notices and errors (spec FR-040, FR-043, FR-044). Server `title`/`detail` are never
 * rendered; messages come from the stable problem `code` and the HTTP status. Tests assert these exact strings.
 */

export const NOTICES = {
  registered:
    'Thanks for signing up. Sign in with your email and password to continue. If you already had an account, use your existing password or reset it.',
  signed_out: "You've been signed out.",
  signed_out_everywhere: "You've been signed out on all devices.",
  session_expired: 'Your session ended. Sign in again to continue.',
  password_reset: 'Your password was changed. Sign in with your new password.',
} as const;
export type NoticeKey = keyof typeof NOTICES;

export const PROVIDER_ERRORS = {
  oidc_state_invalid: 'That sign-in link is no longer valid. Start again from this page.',
  oidc_denied: 'Google sign-in was cancelled. You can try again or use your email and password.',
  oidc_exchange_failed: "We couldn't complete sign-in with Google. Try again.",
  oidc_token_invalid: "We couldn't verify your Google sign-in. Try again.",
  oidc_provider_unavailable: 'Google sign-in is unavailable right now. Try again in a moment, or use your email and password.',
  email_not_verified: "Google didn't confirm your email address, so we couldn't sign you in with it.",
  account_unavailable: 'This account is unavailable. Contact support if you think this is a mistake.',
  link_conflict: 'This account already has a Google sign-in linked, or that address belongs to a different one.',
  identity_already_linked: 'That Google account is already linked to another user.',
} as const;
export type ProviderErrorKey = keyof typeof PROVIDER_ERRORS;

const own = (table: object, key: unknown): boolean => typeof key === 'string' && Object.hasOwn(table, key);
export const isNotice = (value: unknown): value is NoticeKey => own(NOTICES, value);
export const isProviderError = (value: unknown): value is ProviderErrorKey => own(PROVIDER_ERRORS, value);

export const COPY = {
  invalidCredentials: 'The email or password is incorrect.',
  wrongCode: "That code isn't right. Check your authenticator app and try again.",
  signInTimedOut: 'Your sign-in timed out. Sign in again.',
  invalidResetToken: 'This reset link is invalid or has expired.',
  weakPassword: 'This password has appeared in a known data breach. Choose a different one.',
  verifyRequest: "We couldn't verify this request. Reload the page and try again.",
  slow: 'This is taking longer than expected. Try again in a moment.',
  server: 'Something went wrong on our side. Try again.',
  offline: 'You appear to be offline. Check your connection and try again.',
  lastLoginMethod: 'This is your only way to sign in. Add another sign-in method first.',
  mfaAlreadyEnabled: 'Two-step verification is already on.',
  mfaNotEnabled: "Two-step verification isn't turned on.",
  setupTimedOut: 'Setup timed out. Start again.',
  fallback4xx: "Something didn't work. Check the details and try again.",
  sessionEnded: 'Your session ended. Sign in again to continue.',
  logoutFailed: "We couldn't sign you out. Try again.",
  logoutFailedCsrf: 'Reload the page and try again.',
  checkFields: 'Check the highlighted fields.',
  checkField: 'Check this field.',
} as const;

/** Where a problem is shown decides the wording of a few codes. */
export type ProblemContext =
  | 'login'
  | 'register'
  | 'mfa-login'
  | 'reset-request'
  | 'reset-confirm'
  | 'mfa-setup'
  | 'generic';

const RATE_LIMIT_SUBJECT: Record<ProblemContext, string> = {
  login: 'Too many sign-in attempts',
  register: 'Too many sign-up attempts',
  'mfa-login': 'Too many incorrect codes',
  'mfa-setup': 'Too many incorrect codes',
  'reset-request': 'Too many reset requests',
  'reset-confirm': 'Too many attempts',
  generic: 'Too many attempts',
};

const SLOW_CODES = new Set(['overloaded', 'session_unavailable', 'oidc_provider_unavailable']);

/** The calm, fixed sentence for a failed call. Never contains server text. */
export function problemMessage(problem: Problem, context: ProblemContext = 'generic'): string {
  if (problem.status === 0) return COPY.offline;
  switch (problem.code) {
    case 'invalid_credentials':
      return COPY.invalidCredentials;
    case 'invalid_mfa_code':
    case 'invalid_code':
      return COPY.wrongCode;
    case 'mfa_not_pending':
      return context === 'mfa-setup' ? COPY.setupTimedOut : COPY.signInTimedOut;
    case 'invalid_mfa_challenge':
      return COPY.signInTimedOut;
    case 'invalid_token':
      return context === 'mfa-login' ? COPY.signInTimedOut : COPY.sessionEnded;
    case 'session_expired':
    case 'unauthenticated':
      return COPY.sessionEnded;
    case 'invalid_reset_token':
      return COPY.invalidResetToken;
    case 'weak_password':
      return COPY.weakPassword;
    case 'csrf_invalid':
    case 'origin_not_allowed':
      return COPY.verifyRequest;
    case 'rate_limited':
      return waitSentence(RATE_LIMIT_SUBJECT[context], problem.retryAfterSeconds);
    case 'last_login_method':
      return COPY.lastLoginMethod;
    case 'mfa_already_enabled':
      return COPY.mfaAlreadyEnabled;
    case 'mfa_not_enabled':
      return COPY.mfaNotEnabled;
    case 'validation_failed':
      return COPY.checkFields;
    default:
  }
  if (problem.status === 429) return waitSentence(RATE_LIMIT_SUBJECT[context], problem.retryAfterSeconds);
  if (problem.status === 503 || (problem.code && SLOW_CODES.has(problem.code))) return COPY.slow;
  if (problem.status >= 500) return COPY.server;
  if (problem.status >= 400) return COPY.fallback4xx;
  return COPY.server;
}

/** Codes whose alert is a "reload" situation (the alert offers a Reload button). */
export const needsReload = (problem: Problem): boolean => problem.code === 'csrf_invalid' || problem.code === 'origin_not_allowed';

/** FR-042: a reference id accompanies 5xx (except the 503 "slow" family) and unknown errors. */
export function showsReference(problem: Problem): boolean {
  if (!problem.requestId) return false;
  if (problem.status === 503 || (problem.code && SLOW_CODES.has(problem.code))) return false;
  return problem.status >= 500 || (problem.status !== 0 && !problem.code);
}

/** Text for one `validation_failed` entry, derived from `(field, code)` (R-04); never the server's words. */
export function fieldErrorMessage(field: string, code: string): string {
  if (code === 'weak_password') return COPY.weakPassword;
  if (field === 'email') return 'Enter a valid email address.';
  if (field === 'password') return 'Use 12 to 128 characters.';
  return COPY.checkField;
}

export const SUBMITTING = {
  login: 'Signing in…',
  register: 'Creating your account…',
  mfa: 'Verifying…',
  reset: 'Sending…',
  update: 'Updating…',
} as const;
