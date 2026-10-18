'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { clearPrivateState, dropPrivateQueries } from '@/hooks/use-auth-actions';
import { sessionEndedDescription } from '@/lib/admin/flags/dirty';
import { setSessionPresence } from '@/lib/api/session-presence';
import { COPY } from '@/lib/auth/copy';
import { safeReturnTo } from '@/lib/auth/return-to';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { subscribeAuth } from '@/lib/auth/session-sync';
import { queryKeys } from '@/lib/query-keys';

/**
 * Connects the framework-free auth pieces to React (mounted once inside `Providers`): tells the shared API client whether
 * a member is signed in, runs the session-ended flow (W01 AS-26) and applies sign-in/out announced by other tabs (AS-22).
 * Renders nothing.
 */
export function SessionLifecycle() {
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    setSessionPresence(() => Boolean(queryClient.getQueryData(queryKeys.auth.session())));

    setSessionEndHandler(() => {
      const here = safeReturnTo(`${window.location.pathname}${window.location.search}`);
      clearPrivateState(queryClient);
      router.refresh();
      const signIn = `/login?returnTo=${encodeURIComponent(here)}&notice=session_expired`;
      // W06 AS-49: an open flag editor says its unsaved edits are lost (only while dirty).
      toast(COPY.sessionEnded, { description: sessionEndedDescription(), action: { label: 'Sign in', onClick: () => router.push(signIn) } });
    });

    const unsubscribe = subscribeAuth((type) => {
      if (type === 'signed-out') {
        dropPrivateQueries(queryClient);
        router.refresh();
      } else {
        rearmSessionEnd();
        void queryClient.invalidateQueries();
      }
    });

    return () => {
      unsubscribe();
      setSessionEndHandler(null);
      setSessionPresence(() => false);
    };
  }, [queryClient, router]);

  return null;
}
