import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { authPageRedirect } from '@/lib/auth/guards';
import { safeReturnTo } from '@/lib/auth/return-to';
import { getServerSession } from '@/lib/auth/session.server';
import { MfaForm } from './mfa-form';

export const metadata: Metadata = { title: 'Two-step verification' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page cannot tell whether a sign-in is pending (the server decides when the code is posted); it only keeps signed-in visitors out. */
async function MfaContent({ searchParams }: { searchParams: SearchParams }) {
  const { returnTo } = await searchParams;
  const target = authPageRedirect({ user: await getServerSession(), returnTo });
  if (target) redirect(target);
  const safe = safeReturnTo(returnTo);
  return <MfaForm returnTo={safe === '/' ? undefined : safe} />;
}

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <AuthCard title="Two-step verification" description="Confirm it's you to finish signing in.">
      <Suspense fallback={<div className="min-h-[16rem]" aria-busy="true" />}>
        <MfaContent searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}
