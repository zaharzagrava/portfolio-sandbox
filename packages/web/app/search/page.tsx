import type { Metadata } from 'next';
import { Suspense } from 'react';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { CanonicalUrl } from '@/components/search/canonical-url';
import { SearchBox } from '@/components/search/search-box';
import { SearchResults } from '@/components/search/search-results';
import { SearchShellSkeleton } from '@/components/search/search-skeleton';
import { getSearchFirstView } from '@/lib/server/search.server';
import { queryKeys } from '@/lib/query-keys';
import { parseSearchView, withoutPickup, type RawSearchParams } from '@/lib/search/search-view';

type SearchParams = Promise<Exclude<RawSearchParams, URLSearchParams | null | undefined>>;

/**
 * Titles and robots rules (W02 FR-025): an address with a query, a filter, meaning search, pickup mode or a cursor is
 * `noindex, follow`; plain `/search` is indexable.
 */
export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const { view } = parseSearchView(await searchParams);
  const plain = !view.q && !view.category && !view.brand && view.minPriceMinor === undefined && view.maxPriceMinor === undefined && view.minRating === undefined && !view.inStock && !view.semantic && !view.near && !view.cursor;
  return {
    // The root layout's title template adds " · Marketplace".
    title: view.near ? 'Pickup near you' : view.q ? `${view.q} – Search` : 'Search',
    robots: plain ? { index: true, follow: true } : { index: false, follow: true },
  };
}

/** The first view is read on the server and handed to the client's query cache, so the results need no second request. */
async function FirstView({ searchParams }: { searchParams: SearchParams }) {
  const { view } = parseSearchView(await searchParams);
  const effective = withoutPickup(view);
  const first = await getSearchFirstView(effective);
  const client = new QueryClient();
  if (first) client.setQueryData(queryKeys.search.results(effective), first);
  return (
    <HydrationBoundary state={dehydrate(client)}>
      <SearchResults />
      <CanonicalUrl />
    </HydrationBoundary>
  );
}

export default function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6">
      <div className="mb-6 max-w-2xl">
        <SearchBox variant="page" />
      </div>
      <Suspense fallback={<SearchShellSkeleton />}>
        <FirstView searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
