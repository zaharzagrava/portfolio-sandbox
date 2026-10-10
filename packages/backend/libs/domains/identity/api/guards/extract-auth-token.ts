import * as cookie from 'cookie';

export const ACCESS_COOKIE = '__Host-access';

/**
 * The only two credential channels (FR-024): `Authorization: Bearer <jwt>` and the `__Host-access` cookie of cookie
 * delivery. The legacy `x-auth-token` header and cookie, and query-string tokens, are not read.
 */
export function extractAuthToken(request: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const authorization = request.headers['authorization'];
  if (
    typeof authorization === 'string' &&
    authorization.startsWith('Bearer ')
  ) {
    return authorization.slice('Bearer '.length).trim() || undefined;
  }
  const header = request.headers.cookie;
  return (
    cookie.parse(typeof header === 'string' ? header : '')[ACCESS_COOKIE] ||
    undefined
  );
}
