import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthCard } from '@/components/auth/auth-card';
import { UnsubscribeConfirm, UnsubscribeInvalid } from '@/components/notifications/unsubscribe-confirm';
import { formatWait } from '@/lib/auth/retry-after';
import { describeUnsubscribe } from '@/lib/server/unsubscribe.server';

// The address carries a signed token: keep it out of search results and out of the Referer of any link.
export const metadata: Metadata = { title: 'Unsubscribe', robots: { index: false, follow: false }, referrer: 'no-referrer' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Anonymous: the signed link is the proof. This read only describes the change; nothing is switched off until the button posts. */
async function UnsubscribeContent({ searchParams }: { searchParams: SearchParams }) {
  const { token } = await searchParams;
  if (typeof token !== 'string' || token.length === 0) return <UnsubscribeInvalid />;
  const result = await describeUnsubscribe(token);
  if (result.ok) return <UnsubscribeConfirm token={token} category={result.data.category} />;
  if (result.status === 400) return <UnsubscribeInvalid />;
  const wait = result.status === 429 ? formatWait(result.retryAfter) : null;
  return (
    <p role="alert" className="text-sm">
      {result.status === 429 ? (wait ? `Too many attempts. Try again in ${wait}.` : 'Too many attempts. Try again later.') : 'We could not check this link right now. Try again in a moment.'}
    </p>
  );
}

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <AuthCard title="Unsubscribe">
        <Suspense fallback={<div className="min-h-[8rem]" aria-busy="true" />}>
          <UnsubscribeContent searchParams={searchParams} />
        </Suspense>
      </AuthCard>
    </div>
  );
}
