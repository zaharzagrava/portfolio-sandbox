import 'server-only';
import { cookies } from 'next/headers';
import { BFF_COOKIES, BFF_CSRF_HEADER, inviteAcceptedSchema } from '@marketplace-sandbox/contracts';
import { bffUrl } from '@/lib/server/endpoints.server';

export type AcceptInviteResult =
  | { ok: true; shopId: string; role: 'OWNER' | 'ADMIN' | 'STAFF' | 'VIEWER'; alreadyMember: boolean }
  | { ok: false; code: 'invite_not_found' | 'rate_limited' | 'unauthenticated' | 'service_unavailable'; retryAfter?: number };

/** Invitation tokens are URL-safe and short; anything else cannot be a token and is never sent. */
const TOKEN = /^[A-Za-z0-9_\-.~]{1,512}$/;

/**
 * `POST /shop-invites/accept` as the signed-in member (W04 AS-80..AS-82): the session and CSRF cookies of the request are
 * forwarded, the token travels in the body only and is never logged. The API never says why an invitation is refused, and
 * neither does this: every other 4xx is `invite_not_found`.
 */
export async function postAcceptInvite(token: string): Promise<AcceptInviteResult> {
  if (!TOKEN.test(token)) return { ok: false, code: 'invite_not_found' };
  const jar = await cookies();
  const session = jar.get(BFF_COOKIES.session)?.value;
  const csrf = jar.get(BFF_COOKIES.csrf)?.value;
  if (!session || !csrf) return { ok: false, code: 'unauthenticated' };

  let response: Response;
  try {
    response = await fetch(`${bffUrl()}/api/bff/f/shop-invites/accept`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie: `${BFF_COOKIES.session}=${session}; ${BFF_COOKIES.csrf}=${csrf}`,
        [BFF_CSRF_HEADER]: csrf,
      },
      body: JSON.stringify({ token }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, code: 'service_unavailable' };
  }

  if (response.ok) {
    const parsed = inviteAcceptedSchema.safeParse(await response.json().catch(() => undefined));
    return parsed.success
      ? { ok: true, shopId: parsed.data.shopId, role: parsed.data.role, alreadyMember: parsed.data.alreadyMember === true }
      : { ok: false, code: 'service_unavailable' };
  }
  if (response.status === 401) return { ok: false, code: 'unauthenticated' };
  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'));
    return { ok: false, code: 'rate_limited', ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}) };
  }
  if (response.status >= 500) return { ok: false, code: 'service_unavailable' };
  return { ok: false, code: 'invite_not_found' };
}
