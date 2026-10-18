import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { requireAdminPage } from '@/components/admin/admin-guard';
import { EditorSkeleton } from '@/components/admin/flags/editor-skeleton';
import { FlagEditor } from '@/components/admin/flags/flag-editor';
import { FlagHistory } from '@/components/admin/flags/flag-history';
import { FlagPageTabs } from '@/components/admin/flags/flag-tabs';
import { adminReturnTo } from '@/lib/admin/access';
import { getFlagServer, getHistoryPage } from '@/lib/api/admin-flags.server';
import { flagHref, isFlagKey, LIST_PATH, parseFlagTab, parseHistoryParams, type RawParams } from '@/lib/admin/flags/params';
import { queryKeys } from '@/lib/query-keys';

/** A segment that is not valid percent-encoding cannot be a key: it is kept as is and fails the key pattern. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

type Props = { params: Promise<{ key: string }>; searchParams: Promise<RawParams> };

export const metadata = { title: 'Feature flag · Marketplace Admin' };

/**
 * The editor or the history of one flag, inside `<Suspense>` (W06 FR-002, AS-31, AS-54). The key is checked against the
 * contracts' pattern before anything else, so a malformed key is the not-found page with no request. Then the guard, then the
 * first answer is read on the server and handed to the browser's query cache; an unknown key is the not-found page.
 */
async function Content({ params, searchParams }: Props) {
  const [{ key: raw }, query] = await Promise.all([params, searchParams]);
  const key = safeDecode(raw);
  // The guard first: a visitor who may not look learns nothing, not even whether a key is well formed.
  if (!(await requireAdminPage(adminReturnTo(flagHref(key), query)))) return null;
  if (!isFlagKey(key)) notFound();

  const client = new QueryClient();
  const tab = parseFlagTab(query);
  if (tab === 'history') {
    const { cursor } = parseHistoryParams(query);
    const read = await getHistoryPage(key, { cursor });
    if (!read.ok && read.status === 404) notFound();
    if (read.ok) client.setQueryData(queryKeys.admin.flags.history(key, { cursor }), read.data);
    return (
      <HydrationBoundary state={dehydrate(client)}>
        <h1 className="font-mono text-2xl font-semibold tracking-tight break-all">{key}</h1>
        <FlagPageTabs flagKey={key} current="history" />
        <FlagHistory flagKey={key} cursor={cursor} />
      </HydrationBoundary>
    );
  }

  const read = await getFlagServer(key);
  if (!read.ok && read.status === 404) notFound();
  if (read.ok) client.setQueryData(queryKeys.admin.flags.detail(key), read.data);
  return (
    <HydrationBoundary state={dehydrate(client)}>
      <FlagEditor flagKey={key} tabs={<FlagPageTabs flagKey={key} current="definition" />} />
    </HydrationBoundary>
  );
}

export default function FlagPage(props: Props) {
  return (
    <div className="space-y-4">
      <Link href={LIST_PATH} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
        Back to flags
      </Link>
      <Suspense fallback={<EditorSkeleton />}>
        <Content {...props} />
      </Suspense>
    </div>
  );
}
