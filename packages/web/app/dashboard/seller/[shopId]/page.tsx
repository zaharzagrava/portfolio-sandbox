import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { OverviewView } from '@/components/seller/overview/overview-view';
import { OverviewSkeleton } from '@/components/seller/page-skeletons';
import { loginHref } from '@/lib/auth/return-to';
import { DEFAULT_OVERVIEW_DAYS, readDays, type RawSearchParams } from '@/lib/seller/search-params';
import { readOverview } from '@/lib/server/seller.server';

export const metadata: Metadata = { title: 'Overview' };

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/**
 * The overview of a shop (W04 FR-017, AS-10..AS-18). The composed answer is read on the server as the signed-in member and
 * handed to the client query as `initialData`; the sidebar frame is already on screen while it streams. A `days` that is not
 * 7, 30 or 90 (or the default written out) is replaced by the canonical address.
 */
async function Overview({ params, searchParams }: Props) {
  const { shopId } = await params;
  const raw = await searchParams;
  const path = `/dashboard/seller/${encodeURIComponent(shopId)}`;
  await requireSellerSession(path, raw);

  const days = readDays(raw.days);
  if (raw.days !== undefined && (typeof raw.days !== 'string' || raw.days !== String(days) || days === DEFAULT_OVERVIEW_DAYS)) {
    redirect(days === DEFAULT_OVERVIEW_DAYS ? path : `${path}?days=${days}`);
  }

  const result = await readOverview(shopId, days);
  if (!result.ok) {
    if (result.status === 401) redirect(loginHref(days === DEFAULT_OVERVIEW_DAYS ? path : `${path}?days=${days}`));
    if (result.status === 404) notFound();
    // Any other failure is the page-level state of AS-18, with "Try again": the client reads it again.
    return <OverviewView key={shopId} shopId={shopId} days={days} />;
  }
  return (
    <PageAccess shop={result.data.shop} page="overview">
      <OverviewView key={shopId} shopId={shopId} days={days} initialData={result.data} />
    </PageAccess>
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <Overview {...props} />
    </Suspense>
  );
}
