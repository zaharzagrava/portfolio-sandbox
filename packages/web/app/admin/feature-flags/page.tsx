import Link from 'next/link';
import { Suspense } from 'react';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { ListTabs } from '@/components/admin/flags/flag-tabs';
import { FlagList } from '@/components/admin/flags/flag-list';
import { FlagListSkeleton } from '@/components/admin/flags/flag-list-skeleton';
import { StaleReport } from '@/components/admin/flags/stale-report';
import { requireAdminPage } from '@/components/admin/admin-guard';
import { Button } from '@/components/ui/button';
import { getFlagPage, getStale } from '@/lib/api/admin-flags.server';
import { adminReturnTo } from '@/lib/admin/access';
import { LIST_PATH, NEW_FLAG_PATH, parseListParams, parseListTab, parseStaleParams, type RawParams } from '@/lib/admin/flags/params';
import { queryKeys } from '@/lib/query-keys';

export const metadata = { title: 'Feature flags · Marketplace Admin' };

/**
 * The guard and the first answer, inside `<Suspense>` (W06 FR-002, FR-003): an anonymous visitor goes to sign-in with this very
 * address as `returnTo` before anything is read; a non-admin gets nothing requested; an admin's first page (or stale report)
 * is read on the server and handed to the browser's query cache. A failed read is left out and the browser reads again and
 * shows its own state (AS-07). Nothing here is cached: the data is private and per user.
 */
async function Content({ searchParams }: { searchParams: Promise<RawParams> }) {
  const raw = await searchParams;
  if (!(await requireAdminPage(adminReturnTo(LIST_PATH, raw)))) return null;
  const tab = parseListTab(raw);
  const client = new QueryClient();

  if (tab === 'stale') {
    const { days } = parseStaleParams(raw);
    const read = await getStale({ days });
    if (read.ok) client.setQueryData(queryKeys.admin.flags.stale({ days }), read.data);
    return (
      <HydrationBoundary state={dehydrate(client)}>
        <ListTabs current="stale" />
        <StaleReport days={days} />
      </HydrationBoundary>
    );
  }

  const { status, cursor } = parseListParams(raw);
  const read = await getFlagPage({ status, cursor });
  if (read.ok) client.setQueryData(queryKeys.admin.flags.list({ status, cursor }), read.data);
  return (
    <HydrationBoundary state={dehydrate(client)}>
      <ListTabs current="flags" />
      <FlagList status={status} cursor={cursor} />
    </HydrationBoundary>
  );
}

export default function FeatureFlagsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Feature flags</h1>
        <Button asChild className="min-h-11 max-sm:w-full sm:min-h-8">
          <Link href={NEW_FLAG_PATH}>New flag</Link>
        </Button>
      </div>
      <Suspense fallback={<FlagListSkeleton />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
