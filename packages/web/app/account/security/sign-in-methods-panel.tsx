'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { federatedIdentitySchema } from '@marketplace-sandbox/contracts';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { getMfaStatus, listIdentities, listOidcProviders, startOidcLink, unlinkIdentity } from '@/lib/api/account';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { COPY, PROVIDER_ERRORS, isProviderError, problemMessage } from '@/lib/auth/copy';
import { queryKeys } from '@/lib/query-keys';
import { CodeDialog } from './code-dialog';

type Identity = z.infer<typeof federatedIdentitySchema>;

const RETURN_TO = '/account/security?tab=methods';
const providerName = (id: string) => (id === 'google' ? 'Google' : id.charAt(0).toUpperCase() + id.slice(1));
const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium' });

/** Only an http(s) address is ever navigated to, whatever the server sent. */
function goTo(authorizationUrl: string) {
  const protocol = new URL(authorizationUrl).protocol;
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error('unexpected_url');
  window.location.assign(authorizationUrl);
}

/**
 * The "Sign-in methods" tab (W01 US10, AS-61). The Google parts render only when `oidcEnabled` (FR-045) and the provider
 * list offers `google`; while it is off no OIDC request is made. `linked` and `error` are the URL view state of the return
 * from Google: only the known values are shown, the rest is ignored.
 */
export function SignInMethodsPanel({ oidcEnabled, linked, error }: { oidcEnabled: boolean; linked?: string; error?: string }) {
  const queryClient = useQueryClient();
  const identities = useQuery({ queryKey: queryKeys.auth.identities(), queryFn: listIdentities });
  const providers = useQuery({ queryKey: queryKeys.auth.oidcProviders(), queryFn: listOidcProviders, enabled: oidcEnabled, retry: false, staleTime: 5 * 60_000 });
  const mfa = useQuery({ queryKey: queryKeys.auth.mfaStatus(), queryFn: getMfaStatus, enabled: oidcEnabled });
  const [unlinking, setUnlinking] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [asking, setAsking] = useState(false);
  const [startProblem, setStartProblem] = useState<Problem | null>(null);

  const without = (id: string) =>
    queryClient.setQueryData<Identity[]>(queryKeys.auth.identities(), (list) => list?.filter((item) => item.id !== id));

  async function unlink(id: string) {
    if (unlinking.has(id)) return;
    setUnlinking((set) => new Set(set).add(id));
    setNotice(null);
    try {
      await unlinkIdentity(id);
      without(id);
    } catch (failure) {
      const problem = problemFromError(failure);
      if (problem.code === 'identity_not_found') without(id);
      else if (problem.code === 'last_login_method') setNotice(COPY.lastLoginMethod);
      else toast.error(problemMessage(problem));
    } finally {
      setUnlinking((set) => {
        const next = new Set(set);
        next.delete(id);
        return next;
      });
    }
  }

  async function start(code?: string) {
    const { authorizationUrl } = await startOidcLink({ returnTo: RETURN_TO, ...(code ? { code } : {}) });
    goTo(authorizationUrl);
  }

  async function linkGoogle() {
    if (linking) return;
    if (mfa.data?.state === 'enabled') {
      setAsking(true);
      return;
    }
    setLinking(true);
    setStartProblem(null);
    try {
      await start();
    } catch (failure) {
      setStartProblem(problemFromError(failure));
      setLinking(false);
    }
  }

  const banner = (
    <>
      {linked === 'google' && (
        <p role="status" className="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/60 dark:text-green-100">
          Google account linked.
        </p>
      )}
      {isProviderError(error) && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          {PROVIDER_ERRORS[error]}
        </p>
      )}
    </>
  );

  if (identities.isPending) {
    return (
      <div className="grid gap-3">
        {banner}
        <div data-testid="methods-skeleton" aria-busy="true" className="grid gap-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </div>
    );
  }

  if (identities.isError) {
    return (
      <div className="grid gap-3">
        {banner}
        <p role="alert">We couldn&apos;t load this section.</p>
        <div>
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" onClick={() => void identities.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const list = identities.data;
  const offersGoogle = oidcEnabled && !!providers.data?.some((provider) => provider.id === 'google') && !list.some((item) => item.provider === 'google');

  return (
    <section aria-labelledby="methods-heading" className="grid gap-4">
      <h2 id="methods-heading" className="text-lg font-semibold">
        Sign-in methods
      </h2>
      {banner}
      {notice && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          {notice}
        </p>
      )}
      {list.length === 0 ? (
        <p>No sign-in methods linked yet.</p>
      ) : (
        <ul className="grid gap-3">
          {list.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
              <div className="grid gap-1">
                <p className="font-medium">{providerName(item.provider)}</p>
                <p className="text-sm">{item.email ?? 'No e-mail shared'}</p>
                <p className="text-sm text-muted-foreground">{`Linked ${formatDate(item.linkedAt)}`}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                aria-label={`Unlink ${providerName(item.provider)}`}
                className="min-h-11 sm:min-h-0"
                disabled={unlinking.has(item.id)}
                onClick={() => void unlink(item.id)}
              >
                {unlinking.has(item.id) && <Loader2 className="animate-spin" aria-hidden="true" />}
                Unlink
              </Button>
            </li>
          ))}
        </ul>
      )}
      {offersGoogle && (
        <div className="grid gap-3">
          {startProblem && <ProblemAlert problem={startProblem} context="generic" />}
          <div>
            <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" disabled={linking} aria-busy={linking} onClick={() => void linkGoogle()}>
              {linking && <Loader2 className="animate-spin" aria-hidden="true" />}
              Link Google
            </Button>
          </div>
        </div>
      )}
      {asking && (
        <CodeDialog
          title="Link Google"
          description="Enter the current code from your authenticator app before you continue to Google."
          label="Authentication code"
          mode="totp"
          submitLabel="Continue"
          onClose={() => setAsking(false)}
          onStale={() => {
            setAsking(false);
            void queryClient.invalidateQueries({ queryKey: queryKeys.auth.mfaStatus() });
          }}
          run={start}
        />
      )}
    </section>
  );
}
