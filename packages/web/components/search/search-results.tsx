'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { FilterChips, chipsOf } from '@/components/search/filter-chips';
import { FilterPanel, type FilterPatch } from '@/components/search/filter-panel';
import { FilterSheet } from '@/components/search/filter-sheet';
import { ResultsGrid } from '@/components/search/results-grid';
import { SortControl } from '@/components/search/sort-control';
import { navigateTo, useSearchView } from '@/hooks/use-search-view';
import { fetchSearch } from '@/lib/api/search';
import { problemFromError } from '@/lib/api/errors';
import { queryKeys } from '@/lib/query-keys';
import { searchHref } from '@/lib/routes';
import { clearFilters, firstPage, withChange, withoutPickup, type SearchView } from '@/lib/search/search-view';
import { cn } from '@/lib/utils';

const FIRST_PAGE_NOTICE = 'That page is no longer available. Showing the first page.';
const SKELETON_CARDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

const countLine = (total: { value: number; exact: boolean }) =>
  total.exact ? (total.value === 1 ? '1 result' : `${total.value.toLocaleString('en-US')} results`) : `${total.value.toLocaleString('en-US')}+ results`;

function ResultsSkeleton() {
  return (
    <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4" aria-hidden="true">
      {SKELETON_CARDS.map((name) => (
        <li key={name}>
          <Skeleton className="aspect-[3/4] w-full rounded-xl" />
        </li>
      ))}
    </ul>
  );
}

/**
 * The view that avoids a refusal the address can fix (W02 AS-24): without the cursor, without the price range, without
 * meaning search. `null` when the code is not one of those or the view has nothing to drop, so the failure is shown.
 */
function fixedView(view: SearchView, code: string | undefined): SearchView | null {
  let next: SearchView | null = null;
  if (code === 'invalid_cursor') next = firstPage(view);
  else if (code === 'invalid_price_range') next = withChange(view, { minPriceMinor: undefined, maxPriceMinor: undefined });
  else if (code === 'semantic_requires_query' || code === 'unsupported_combination') next = withChange(view, { semantic: undefined });
  return next && searchHref(next) !== searchHref(view) ? next : null;
}

const isPlainClick =(event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * The results region of `/search` (W02 FR-020..FR-037): the address is the only view state; the server's first answer is
 * already in the query cache (no skeleton), a later change keeps the previous results dimmed and busy until the new ones
 * arrive, and every failure is one alert with the catalogue's text.
 */
export function SearchResults() {
  const { view, change, set } = useSearchView();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Pickup mode (`near`) belongs to a later story: the search itself ignores it.
  const effective = useMemo(() => withoutPickup(view), [view]);

  const query = useQuery({
    queryKey: queryKeys.search.results(effective),
    queryFn: ({ signal }) => fetchSearch(effective, { signal }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const data = query.data;
  const problem = query.isError ? problemFromError(query.error) : undefined;
  const busy = query.isFetching && query.isPlaceholderData;
  const currency = data?.items[0]?.currency ?? 'USD';
  const chips = chipsOf(view, currency);

  const focusHeading = () => headingRef.current?.focus();
  const apply = (patch: FilterPatch) => {
    setNotice(null);
    change(patch);
  };
  const remove = (patch: FilterPatch) => {
    apply(patch);
    focusHeading();
  };
  const clearAll = () => {
    setNotice(null);
    set(clearFilters(view));
    focusHeading();
  };

  // Failures the address can fix are fixed: the page restarts from page one, or without the part the API refused.
  const errorCode = problem?.status === 422 ? problem.code : undefined;
  const fixed = fixedView(view, errorCode);
  const restartsFromFirstPage = fixed !== null && errorCode === 'invalid_cursor';
  // The notice outlives the failed request, so it is set as soon as the failure is seen (not in an effect).
  if (restartsFromFirstPage && notice !== FIRST_PAGE_NOTICE) setNotice(FIRST_PAGE_NOTICE);
  const fixedHref = fixed ? searchHref(fixed) : null;
  useEffect(() => {
    if (fixedHref) navigateTo(fixedHref, 'replace');
  }, [fixedHref]);

  // A wait asked for by 429 keeps Try again disabled until it has passed; offline retries by itself.
  const waitSeconds = problem?.status === 429 ? (problem.retryAfterSeconds ?? 0) : 0;
  const errorAt = query.errorUpdatedAt;
  const [waitingSince, setWaitingSince] = useState(0);
  const [seenErrorAt, setSeenErrorAt] = useState(0);
  if (seenErrorAt !== errorAt) {
    setSeenErrorAt(errorAt);
    setWaitingSince(waitSeconds > 0 ? errorAt : 0);
  }
  useEffect(() => {
    if (!waitingSince) return;
    const timer = setTimeout(() => setWaitingSince(0), waitSeconds * 1000);
    return () => clearTimeout(timer);
  }, [waitingSince, waitSeconds]);
  const waiting = waitingSince !== 0;
  const offline = problem?.status === 0;
  const refetch = query.refetch;
  useEffect(() => {
    if (!offline) return;
    const retry = () => void refetch();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [offline, refetch]);

  const goTo = (event: MouseEvent, href: string) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    setNotice(null);
    navigateTo(href);
    focusHeading();
  };

  const showError = problem && fixed === null;
  const heading = view.q ? `Results for “${view.q}”` : 'All products';
  const degradedSemantic = data?.degraded.includes('semantic_unavailable') === true;
  const items = data?.items ?? [];
  const nextHref = data?.nextCursor && !view.semantic ? searchHref({ ...view, cursor: data.nextCursor }) : undefined;

  const panel = (
    <FilterPanel view={view} facets={data?.facets} currency={currency} onChange={apply} onClearAll={clearAll} />
  );

  return (
    <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-8">
      <aside className="hidden lg:sticky lg:top-20 lg:block lg:self-start" aria-label="Filter options">
        {panel}
      </aside>

      <section aria-label="Search results" aria-busy={busy || (query.isPending && !data)} className="min-w-0">
        <h1 ref={headingRef} tabIndex={-1} className="mb-2 text-2xl font-heading font-bold tracking-tight outline-none">
          {heading}
        </h1>

        <div role="status" className="min-h-5 text-sm text-muted-foreground">
          {data ? countLine(data.total) : null}
        </div>
        {view.semantic && data ? <p className="text-sm text-muted-foreground">Showing the closest matches</p> : null}
        {notice ? (
          <p role="status" className="mt-2 rounded-md border bg-muted/50 px-3 py-2 text-sm">
            {notice}
          </p>
        ) : null}
        {degradedSemantic ? (
          <p role="status" className="mt-2 rounded-md border bg-muted/50 px-3 py-2 text-sm">
            Meaning search is unavailable right now. Showing keyword results.
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <FilterSheet activeCount={chips.length} resultLabel={data ? countLine(data.total) : 'results'} onClearAll={clearAll}>
            {panel}
          </FilterSheet>
          <SortControl view={view} onChange={(sort) => apply({ sort })} />
          {view.q ? (
            <button
              type="button"
              role="switch"
              aria-checked={view.semantic === true}
              onClick={() => apply({ semantic: view.semantic ? undefined : true })}
              className="inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring max-sm:min-h-11"
            >
              <span aria-hidden="true" className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', view.semantic ? 'bg-primary' : 'bg-input')}>
                <span className={cn('size-4 rounded-full bg-background transition-transform motion-reduce:transition-none', view.semantic && 'translate-x-4')} />
              </span>
              Match by meaning
            </button>
          ) : null}
        </div>

        <div className="mt-3">
          <FilterChips view={view} currency={currency} onRemove={remove} onClearAll={clearAll} />
        </div>

        <div className={cn('mt-4 transition-opacity motion-reduce:transition-none', busy && 'opacity-60')}>
          {showError ? (
            <div className="space-y-3">
              <ProblemAlert problem={problem} surface="search" />
              {offline ? (
                <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
                  Reconnecting…
                </p>
              ) : null}
              <Button type="button" variant="outline" className="min-h-11" disabled={waiting || query.isFetching} onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : !data ? (
            <ResultsSkeleton />
          ) : items.length === 0 ? (
            <div className="space-y-2 py-8 text-center" data-testid="search-empty">
              <p className="text-lg font-medium">No products match your search.</p>
              {view.q ? <p className="text-sm text-muted-foreground">Try a different spelling or fewer words.</p> : null}
            </div>
          ) : (
            <ResultsGrid items={items} searchId={data.searchId} />
          )}
        </div>

        {data && items.length > 0 && (nextHref || view.cursor) ? (
          <nav aria-label="Pages" className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-between">
            {view.cursor ? (
               
              <a href={searchHref(firstPage(view))} onClick={(event) => goTo(event, searchHref(firstPage(view)))} className="inline-flex min-h-11 items-center justify-center rounded-md border px-4 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
                Back to first page
              </a>
            ) : (
              <span />
            )}
            {nextHref ? (
               
              <a href={nextHref} onClick={(event) => goTo(event, nextHref)} className="inline-flex min-h-11 items-center justify-center rounded-md border px-4 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
                Next page
              </a>
            ) : null}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
