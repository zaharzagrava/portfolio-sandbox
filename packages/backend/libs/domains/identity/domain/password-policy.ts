export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const EMAIL_MAX = 254;

/** The one address form used for storage, lookup and throttling keys: trimmed and lower-cased. */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

export type PasswordProblem = 'too_short' | 'too_long' | 'is_email';

/**
 * Registration and reset rules (login only caps the length, so existing shorter passwords still work). The breach
 * lookup is separate: it is a port call and may fail open (FR-005).
 */
export function passwordProblem(
  password: string,
  email: string | null,
): PasswordProblem | null {
  if (password.length > PASSWORD_MAX) return 'too_long';
  if (password.length < PASSWORD_MIN) return 'too_short';
  if (email && password.trim().toLowerCase() === normalizeEmail(email))
    return 'is_email';
  return null;
}
