const MAX_LENGTH = 512;
const CONTROL = /[\u0000-\u001f\u007f]/;

function isSameSitePath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !CONTROL.test(value);
}

/**
 * The only way a `returnTo` value is used (W01 AS-07; same rules as S02 FR-045, separate code): one leading `/`, at most
 * 512 characters, no control character, no backslash, checked before and after one round of percent-decoding. A repeated
 * parameter (an array) or anything unsafe becomes `/`.
 */
export function safeReturnTo(raw: string | string[] | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return '/';
  if (!isSameSitePath(raw)) return '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return '/';
  }
  return isSameSitePath(decoded) ? raw : '/';
}

/** `/login?returnTo=<path>` for a guarded page; the plain `/login` when there is nowhere to return to. */
export function loginHref(returnTo: string): string {
  const safe = safeReturnTo(returnTo);
  return safe === '/' ? '/login' : `/login?returnTo=${encodeURIComponent(safe)}`;
}
