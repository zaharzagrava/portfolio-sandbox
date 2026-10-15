import 'server-only';
import { cookies } from 'next/headers';
import { isValidRefCode, REF_COOKIE } from './ref-code';

/**
 * The referral code of the visitor (W02 AS-63, W03 AS-34): the value of the `__Host-ref` cookie when it is a valid code,
 * otherwise `null`. Only server code reads it; the cookie is `HttpOnly`.
 */
export async function getRefCode(): Promise<string | null> {
  const value = (await cookies()).get(REF_COOKIE)?.value;
  return isValidRefCode(value) ? value : null;
}
