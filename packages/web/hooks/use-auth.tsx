'use client';

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import { sessionApi, type SessionRole, type SessionView } from '@/lib/api/session';
import { queryKeys } from '@/lib/query-keys';
import { endSession } from '@/lib/auth/session-ended';

export type SessionUser = { id: string; email: string; role: SessionRole };
export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'unavailable';

export const toSessionUser = (view: SessionView): SessionUser => ({
  id: view.user.id,
  email: view.user.email ?? '',
  role: view.user.role,
});

/**
 * `GET /api/bff/session`: a user, `null` for anonymous (401), or a throw for "could not check" (503, network), in which
 * case TanStack keeps the previous value. A 401 that follows a known user means the session ended (W01 AS-26).
 */
async function fetchSession(queryClient: QueryClient): Promise<SessionUser | null> {
  const result = await sessionApi.current();
  if (result.ok && result.kind === 'session') return toSessionUser(result.session);
  if (!result.ok && result.status === 401) {
    if (queryClient.getQueryData(queryKeys.auth.session())) endSession();
    return null;
  }
  throw new Error('session_unavailable');
}

/**
 * The browser's view of the session: server data, so it lives in TanStack Query (VI.4), never in `useState` or a second
 * context. Read-only: sign-in, sign-out and role refresh are the hooks in `use-auth-actions.ts`.
 */
export function useAuth(): { user: SessionUser | null; status: AuthStatus; isAuthenticated: boolean; isLoading: boolean } {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.auth.session(),
    queryFn: () => fetchSession(queryClient),
    staleTime: 60_000,
    // 'always': a member must see a session ended elsewhere, and recover from "unavailable", even inside the stale window.
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    retry: false,
  });
  const user = query.data ?? null;
  let status: AuthStatus;
  if (query.isError) status = 'unavailable';
  else if (query.data === undefined) status = 'loading';
  else status = user ? 'authenticated' : 'anonymous';
  return { user, status, isAuthenticated: user !== null, isLoading: status === 'loading' };
}

const noSubscription = () => () => {};

/**
 * `false` on the server and during hydration, `true` from the first commit after it. A client leaf that was handed what the
 * server read (`initialAnonymous`, `initialMember`) uses that hint until then, so its first render always equals the server's
 * markup even when the browser's session query answered before this part of the page hydrated.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false);
}

/**
 * Seeds the session query with the value the server already read, so a signed-in member's first paint never passes
 * through "anonymous" (W01 AS-18). Receives only `{id, email, role}`.
 */
export function AuthBootstrap({ user }: { user: SessionUser | null }) {
  const queryClient = useQueryClient();
  // Lazy state initializer: runs once, during the first render, before any sibling reads the session.
  useState(() => {
    if (queryClient.getQueryData(queryKeys.auth.session()) === undefined) {
      queryClient.setQueryData(queryKeys.auth.session(), user);
    }
    return true;
  });
  return null;
}
