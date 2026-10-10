export const MAX_RETURN_PATH = 512;

// eslint-disable-next-line no-control-regex -- the grammar forbids exactly these characters
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * FR-045: a relative path with exactly one leading slash, at most 512 characters, no control characters, no
 * backslash, and no `//` prefix before or after one round of percent-decoding. Returns the input unchanged or `null`;
 * an invalid path is never rewritten into a different one.
 */
export function parseReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_RETURN_PATH) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (CONTROL.test(value) || value.includes('\\')) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return null;
  if (CONTROL.test(decoded) || decoded.includes('\\')) return null;
  return value;
}
