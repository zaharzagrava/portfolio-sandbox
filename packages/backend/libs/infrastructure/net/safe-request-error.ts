/** Failure vocabulary of the SSRF-safe functions (S54 FR-061). */
export type SafeRequestErrorKind =
  | 'blocked_address'
  | 'unresolvable'
  | 'invalid_url'
  | 'redirect_refused'
  | 'redirected_host'
  | 'too_many_redirects'
  | 'unsupported_content_type'
  | 'timeout'
  | 'tls_error'
  | 'network_error';

const MESSAGES: Record<SafeRequestErrorKind, string> = {
  blocked_address: 'the target address is not allowed',
  unresolvable: 'the host name could not be resolved',
  invalid_url: 'the URL is not allowed',
  redirect_refused:
    'the server answered with a redirect, which is not followed',
  redirected_host: 'the server redirected to another host',
  too_many_redirects: 'too many redirects',
  unsupported_content_type: 'the response content type is not accepted',
  timeout: 'the request exceeded its deadline',
  tls_error: 'the TLS handshake or certificate check failed',
  network_error: 'the connection failed',
};

/**
 * The message is fixed per kind: it never carries an address, host, URL, stack or response text, so it is safe to
 * return to a caller or put in a log (S54 AS-114).
 */
export class SafeRequestError extends Error {
  constructor(readonly kind: SafeRequestErrorKind) {
    super(`${kind}: ${MESSAGES[kind]}`);
    this.name = 'SafeRequestError';
  }
}
