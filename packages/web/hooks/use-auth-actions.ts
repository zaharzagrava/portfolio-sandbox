'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cartApi } from '@/lib/api/cart';
import { sessionApi, type SessionResult } from '@/lib/api/session';
import { COPY } from '@/lib/auth/copy';
import { safeReturnTo } from '@/lib/auth/return-to';
import { rearmSessionEnd } from '@/lib/auth/session-ended';
import { announceAuth } from '@/lib/auth/session-sync';
import { queryKeys } from '@/lib/query-keys';
import { toSessionUser } from './use-auth';

/** Everything that happens after the BFF accepted a sign-in (W01 FR-007). */
function useSignInEffects(returnTo?: string | null) {
  const queryClient = useQueryClient();
  const router = useRouter();
  return (result: SessionResult) => {
    if (!result.ok || result.kind !== 'session') return;
    rearmSessionEnd();
    queryClient.setQueryData(queryKeys.auth.session(), toSessionUser(result.session));
    // Data cached for the anonymous visitor must not survive: refetch everything except the session itself.
    void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'auth' || query.queryKey[1] !== 'session' });
    void cartApi.mergeGuestCart().catch(() => undefined);
    router.replace(safeReturnTo(returnTo));
    router.refresh();
    announceAuth('signed-in');
  };
}

/** Password sign-in. Resolves with the BFF result; on `session` the sign-in effects have run. `mfa_required` is the caller's to route. */
export function useLogin(returnTo?: string | null) {
  const applySignIn = useSignInEffects(returnTo);
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => sessionApi.login(email, password),
    onSuccess: applySignIn,
  });
}

/** Second step of sign-in: the pending challenge lives in the BFF's HttpOnly cookie. */
export function useVerifyMfa(returnTo?: string | null) {
  const applySignIn = useSignInEffects(returnTo);
  return useMutation({
    mutationFn: (code: string) => sessionApi.verifyMfa(code),
    onSuccess: applySignIn,
  });
}

/** Drops everything cached for the member and tells the other tabs. */
export function clearPrivateState(queryClient: QueryClient) {
  dropPrivateQueries(queryClient);
  announceAuth('signed-out');
}

/**
 * Empties the query cache and records "anonymous". The session query itself is kept (set to `null`), not removed:
 * `queryClient.clear()` would leave mounted `useAuth()` observers attached to a removed query, and the navbar would
 * keep showing the account menu.
 */
export function dropPrivateQueries(queryClient: QueryClient) {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' || query.queryKey[1] !== 'session' });
  queryClient.setQueryData(queryKeys.auth.session(), null);
}

/**
 * Signs out through the BFF. It succeeds only when the request does: on failure the member stays signed in and a toast
 * offers to try again, so the interface never pretends to be signed out while the server session may live (W01 AS-25).
 */
export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const mutation = useMutation({
    mutationFn: () => sessionApi.logout(),
    onSuccess: (result) => {
      if (result.ok) {
        clearPrivateState(queryClient);
        router.replace('/login?notice=signed_out');
        router.refresh();
        return;
      }
      if (result.code === 'csrf_invalid' || result.code === 'origin_not_allowed') {
        toast.error(COPY.logoutFailedCsrf, { action: { label: 'Reload', onClick: () => window.location.reload() } });
        return;
      }
      toast.error(COPY.logoutFailed, { action: { label: 'Try again', onClick: () => mutation.mutate() } });
    },
  });
  return mutation;
}

/** Asks the BFF to re-issue the session so a changed role (a new shop makes the member a seller) shows (W01 AS-23). */
export function useRefreshSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => sessionApi.refresh(),
    onSuccess: (result) => {
      if (result.ok && result.kind === 'session') queryClient.setQueryData(queryKeys.auth.session(), toSessionUser(result.session));
    },
  });
}
