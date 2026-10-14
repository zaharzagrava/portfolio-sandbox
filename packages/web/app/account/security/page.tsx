import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SecurityTabs } from './security-tabs';
import { parseTab } from './tab-ids';
import { SessionsPanel } from './sessions-panel';
import { SignInMethodsPanel } from './sign-in-methods-panel';
import { TwoStepPanel } from './two-step-panel';

export const metadata: Metadata = { title: 'Account security' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);

/** Reads the URL view state (`tab`, `linked`, `error`) inside Suspense; unknown values are ignored downstream (W01 FR-025). */
async function SecurityContent({ searchParams }: { searchParams: SearchParams }) {
  const { tab, linked, error } = await searchParams;
  return (
    <SecurityTabs
      initialTab={parseTab(tab)}
      panels={{
        'two-step': <TwoStepPanel />,
        sessions: <SessionsPanel />,
        methods: <SignInMethodsPanel oidcEnabled={process.env.AUTH_OIDC_ENABLED === 'true'} linked={one(linked)} error={one(error)} />,
      }}
    />
  );
}

/** Guarded by `app/account/layout.tsx`; every call the panels make is authorised again by the API. */
export default function SecurityPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Account security</h1>
      <Suspense fallback={<div className="min-h-[20rem]" aria-busy="true" />}>
        <SecurityContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
