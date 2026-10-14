'use client';

import type { ReactNode } from 'react';
import { useAuth, useHydrated } from '@/hooks/use-auth';

/**
 * Renders its children for signed-in members only, so a visitor mounts (and requests) nothing.
 *
 * `initialMember` is what the server read from the session cookie (`MemberSlot`). While the browser's own session query has no
 * answer yet, the hint decides: the server's markup and the browser's first render then agree, whether or not the server's
 * query cache happened to hold the session when it rendered. Once the browser knows, it follows the live session.
 */
export function MemberOnly({ children, initialMember }: { children: ReactNode; initialMember?: boolean }) {
  const { isAuthenticated, status } = useAuth();
  const hydrated = useHydrated();
  const hinted = initialMember !== undefined && (!hydrated || status === 'loading');
  const member = hinted ? initialMember : isAuthenticated;
  return member ? <>{children}</> : null;
}
