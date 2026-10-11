import 'server-only';
import { cookies } from 'next/headers';
import { BFF_COOKIES, BFF_CSRF_HEADER } from '@marketplace-sandbox/contracts';
import { postCheckout, type CheckoutResult } from '@/lib/api/checkout';
import { bffUrl } from '@/lib/server/endpoints.server';

/**
 * The server half of Place order (W03 FR-020, AS-34). A Server Function re-checks the session itself (Forms guide): it
 * reads the HttpOnly session cookie and the readable CSRF cookie of the incoming request, refuses without them, and
 * forwards both plus the CSRF value in `X-CSRF-Token` to the BFF forwarder. No token is ever created or held here.
 */
export async function submitCheckout(input: { key: string; expectedTotalMinor?: number; refCode?: string | null }): Promise<CheckoutResult> {
  const jar = await cookies();
  const session = jar.get(BFF_COOKIES.session)?.value;
  if (!session) return { ok: false, status: 401, code: 'unauthenticated' };
  const csrf = jar.get(BFF_COOKIES.csrf)?.value;
  if (!csrf) return { ok: false, status: 403, code: 'csrf_invalid' };
  return postCheckout({
    baseUrl: bffUrl(),
    key: input.key,
    ...(input.expectedTotalMinor !== undefined ? { expectedTotalMinor: input.expectedTotalMinor } : {}),
    ...(input.refCode ? { refCode: input.refCode } : {}),
    headers: {
      cookie: `${BFF_COOKIES.session}=${session}; ${BFF_COOKIES.csrf}=${csrf}`,
      [BFF_CSRF_HEADER]: csrf,
    },
  });
}
