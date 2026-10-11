import 'server-only';

/**
 * The seam for the referral code of the order (W03 AS-34, FR-011). W02 owns the `__Host-ref` cookie and will export
 * `getRefCode()` from `lib/attribution/ref.server.ts`; that module is not in the tree yet, so this returns `null` (no code,
 * nothing sent). When it lands, this function becomes `return getRefCode()` and nothing else changes: the order function
 * adds the code to the request only if `checkoutRequestSchema` declares `refCode`. The browser never reads the cookie.
 */
export async function readRefCode(): Promise<string | null> {
  return null;
}
