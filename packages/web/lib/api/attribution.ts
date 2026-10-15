import { isValidRefCode } from '@/lib/attribution/ref-code';

/**
 * Asks the web app's own endpoint to remember the referral code of a share link (W02 AS-63). Same origin, no body but the
 * code, never throws: a refused or failed call changes nothing and shows nothing. The cookie it sets is `HttpOnly`.
 */
export async function captureRef(code: string): Promise<boolean> {
  if (!isValidRefCode(code)) return false;
  try {
    const response = await fetch('/api/attribution/ref', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  }
}
