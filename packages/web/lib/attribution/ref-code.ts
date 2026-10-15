/** The referral cookie of S37 attribution (W02 AS-63): name, lifetime and the shape of a code. Pure; usable in the browser. */
export const REF_COOKIE = '__Host-ref';
export const REF_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const REF_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidRefCode(value: unknown): value is string {
  return typeof value === 'string' && REF_CODE_PATTERN.test(value);
}
