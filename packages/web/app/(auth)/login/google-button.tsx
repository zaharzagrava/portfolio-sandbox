'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { listOidcProviders, startOidc } from '@/lib/api/account';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query-keys';

/**
 * Continue with Google (W01 AS-58). Rendered by the form only when `AUTH_OIDC_ENABLED` is on (FR-045); it also needs the
 * provider list to offer `google`. No provider or a failing list means no button and no other change.
 */
export function GoogleButton({ returnTo }: { returnTo: string }) {
  const providers = useQuery({ queryKey: queryKeys.auth.oidcProviders(), queryFn: listOidcProviders, retry: false, staleTime: 5 * 60_000 });
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  if (!providers.data?.some((provider) => provider.id === 'google')) return null;

  async function start() {
    if (pending) return;
    setPending(true);
    setProblem(null);
    try {
      const { authorizationUrl } = await startOidc(returnTo);
      const protocol = new URL(authorizationUrl).protocol;
      if (protocol !== 'https:' && protocol !== 'http:') throw new Error('unexpected_url');
      window.location.assign(authorizationUrl);
    } catch (error) {
      setProblem(problemFromError(error));
      setPending(false);
    }
  }

  return (
    <div className="grid gap-3">
      {problem && <ProblemAlert problem={problem} context="login" />}
      <Button type="button" variant="outline" size="lg" className="min-h-11 w-full" disabled={pending} aria-busy={pending} onClick={start}>
        {pending ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <svg className="size-4" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 488 512">
            <path
              fill="currentColor"
              d="M488 261.8C488 403.3 391.1 504 248 504 110.8 504 0 393.2 0 256S110.8 8 248 8c66.8 0 123 24.5 166.3 64.9l-67.5 64.9C258.5 52.6 94.3 116.6 94.3 256c0 86.5 69.1 156.6 153.7 156.6 98.2 0 135-70.4 140.8-106.9H248v-85.3h236.1c2.3 12.7 3.9 24.9 3.9 41.4z"
            />
          </svg>
        )}
        Continue with Google
      </Button>
    </div>
  );
}
