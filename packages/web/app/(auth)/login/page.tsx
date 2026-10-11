import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { authPageRedirect } from '@/lib/auth/guards';
import { safeReturnTo } from '@/lib/auth/return-to';
import { getServerSession } from '@/lib/auth/session.server';
import { AuthBanner } from './auth-banner';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Reads the URL view state (`returnTo`, `notice`, `error`) and the session inside Suspense. A signed-in visitor is
 * redirected before any form is shown (W01 AS-16). `AUTH_OIDC_ENABLED` is read here and passed on as a boolean (FR-045).
 */
async function LoginContent({ searchParams }: { searchParams: SearchParams }) {
  const { returnTo, notice, error } = await searchParams;
  const target = authPageRedirect({ user: await getServerSession(), returnTo, error });
  if (target) redirect(target);
  const returnToValue = safeReturnTo(returnTo);
  return (
    <>
      <AuthBanner notice={notice} error={error} />
      <LoginForm returnTo={returnToValue === '/' ? undefined : returnToValue} oidcEnabled={process.env.AUTH_OIDC_ENABLED === 'true'} />
    </>
  );
}

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <AuthCard title="Sign in" description="Enter your email and password to access your account.">
      <Suspense fallback={<div className="min-h-[20rem]" aria-busy="true" />}>
        <LoginContent searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}
