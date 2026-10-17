import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { InviteGate } from './invite-gate';

export const metadata: Metadata = { title: 'Invitation', robots: { index: false, follow: false } };

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Suspense fallback={<Skeleton aria-hidden="true" className="h-40 w-full" />}>
        <InviteGate params={params} />
      </Suspense>
    </div>
  );
}
