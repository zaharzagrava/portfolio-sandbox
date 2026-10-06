import * as cookie from 'cookie';

/**
 * Accepts the token the same way the edge worker does
 * (`Authorization: Bearer <jwt>`), plus the legacy `x-auth-token` header and
 * cookie so existing clients keep working.
 */
export function extractAuthToken(request: {
  headers: Record<string, string | undefined>;
}): string | undefined {
  const authorization = request.headers['authorization'];
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }

  const tokenInHeader = request.headers['x-auth-token'];
  if (tokenInHeader) {
    return tokenInHeader;
  }

  return cookie.parse(request.headers.cookie || '')['x-auth-token'];
}
