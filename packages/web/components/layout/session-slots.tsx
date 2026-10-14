import type { ReactNode } from 'react';
import { MobileLoginLink } from '@/components/auth/account-menu';
import { MemberOnly } from '@/components/layout/member-only';
import { getServerSession } from '@/lib/auth/session.server';

/**
 * Header slots that depend on who is signed in, as Server Components (rendered under the navbar's `Suspense`, like
 * `AccountSlot`): they read the session cookie on the server and pass the answer to their client leaf as a prop. The prop
 * is part of the page the browser receives, so the server's markup and the browser's first render cannot disagree.
 */
export async function MobileLoginSlot() {
  const session = await getServerSession();
  return <MobileLoginLink initialAnonymous={session === null} />;
}

export async function MemberSlot({ children }: { children: ReactNode }) {
  const session = await getServerSession();
  return <MemberOnly initialMember={session !== null}>{children}</MemberOnly>;
}
