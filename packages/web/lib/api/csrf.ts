/**
 * Double-submit CSRF (S48 FR-039): the BFF sets a script-readable `__Host-bff-csrf` cookie next to the HttpOnly session
 * cookie, and every cookie-authenticated non-`GET` echoes it in `X-CSRF-Token`. This is the only place that reads
 * `document.cookie`; the cookie is not a credential.
 */
export const CSRF_COOKIE = '__Host-bff-csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === CSRF_COOKIE && rest.length > 0) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** `{ 'X-CSRF-Token': <cookie value> }` when the readable CSRF cookie is present, else nothing. */
export function csrfHeaders(): Record<string, string> {
  const token = csrfToken();
  return token ? { [CSRF_HEADER]: token } : {};
}

export function hasCsrfCookie(): boolean {
  return csrfToken() !== undefined;
}
