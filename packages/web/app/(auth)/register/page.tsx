import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { authPageRedirect } from '@/lib/auth/guards';
import { getServerSession } from '@/lib/auth/session.server';
import { RegisterForm } from './register-form';

export const metadata: Metadata = { title: 'Create account' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Reads the session (and so the request) inside Suspense; a signed-in visitor never sees the form (W01 AS-16). */
async function RegisterContent({ searchParams }: { searchParams: SearchParams }) {
  const { returnTo } = await searchParams;
  const target = authPageRedirect({ user: await getServerSession(), returnTo });
  if (target) redirect(target);
  return <RegisterForm />;
}

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <AuthCard title="Create account" description="Enter your email and choose a password to create your account.">
      <Suspense fallback={<div className="min-h-[24rem]" aria-busy="true" />}>
        <RegisterContent searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}
