import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { BFF_COOKIES } from '@marketplace-sandbox/contracts';
import { config } from '@/lib/config';
import { fetchServerSession, type ServerSessionUser } from '@/lib/api/session-server';
import { loginHref } from './return-to';

export type SessionUser = ServerSessionUser;

/**
 * The signed-in user as the BFF sees them, or `null`. Memoized per request. Call it only inside a component under a
 * `<Suspense>` boundary: never at the top of a layout, never inside `"use cache"` (W01 FR-005, AS-62).
 */
export const getServerSession = cache(async (): Promise<SessionUser | null> => {
  const cookieValue = (await cookies()).get(BFF_COOKIES.session)?.value;
  if (!cookieValue) return null;
  return fetchServerSession({ bffUrl: config.bffUrl, cookieName: BFF_COOKIES.session, cookieValue });
});

/** Guard for pages that need a member: anonymous visitors go to `/login?returnTo=…`. Convenience only (VI.5). */
export async function requireServerSession(returnTo: string): Promise<SessionUser> {
  const user = await getServerSession();
  if (!user) redirect(loginHref(returnTo));
  return user;
}
