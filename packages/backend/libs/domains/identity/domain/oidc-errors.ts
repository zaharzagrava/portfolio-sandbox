/** The closed set of codes a failed callback puts in `/login?error=<code>`; provider text is never echoed. */
export const OIDC_CALLBACK_ERRORS = [
  'oidc_state_invalid',
  'oidc_denied',
  'oidc_exchange_failed',
  'oidc_token_invalid',
  'oidc_provider_unavailable',
  'email_not_verified',
  'account_unavailable',
  'link_conflict',
  'identity_already_linked',
] as const;

export type OidcCallbackErrorCode = (typeof OIDC_CALLBACK_ERRORS)[number];

export const isOidcCallbackErrorCode = (
  value: unknown,
): value is OidcCallbackErrorCode =>
  typeof value === 'string' &&
  (OIDC_CALLBACK_ERRORS as readonly string[]).includes(value);

/** Thrown inside the application layer; the callback service turns it into the redirect, it never reaches the filter. */
export class OidcCallbackError extends Error {
  constructor(readonly code: OidcCallbackErrorCode) {
    super(code);
    this.name = 'OidcCallbackError';
  }
}
