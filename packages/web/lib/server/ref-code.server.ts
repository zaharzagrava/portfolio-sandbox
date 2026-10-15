import 'server-only';

import { getRefCode } from '@/lib/attribution/ref.server';

/**
 * The seam for the referral code of the order (W03 AS-34, FR-011). W02 owns the `__Host-ref` cookie and exports
 * `getRefCode()` from `lib/attribution/ref.server.ts`; the order function adds the code to the request only if
 * `checkoutRequestSchema` declares `refCode`. The browser never reads the cookie.
 */
export async function readRefCode(): Promise<string | null> {
  return getRefCode();
}
