'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, type MouseEvent } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { ProductCard } from '@/components/product/product-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useBrowserLocation } from '@/hooks/use-browser-location';
import { fetchPickupNearSearch } from '@/lib/api/pickup';
import { problemFromError } from '@/lib/api/errors';
import { pickupItemToCard } from '@/lib/product/cards';
import { LOCATION_MESSAGES } from '@/lib/pickup/location-copy';
import { queryKeys } from '@/lib/query-keys';
import { searchHref } from '@/lib/routes';
import { DEFAULT_RADIUS_KM, firstPage, RADIUS_CHOICES, withChange, type SearchView } from '@/lib/search/search-view';
import { cn } from '@/lib/utils';

export const PICKUP_EMPTY = 'No pickup points near you have these products. Try a larger radius.';

/**
 * Pickup mode of `/search` (W02 AS-28..AS-31): the switch, its location state and the radius control. Location is asked
 * for only when the shopper turns the mode on or presses **Try again** - or, after a reload of an address that already has
 * `near=1`, once on load (the browser remembers the permission). The position lives in this hook's memory; the address
 * only ever gets `near` and `radiusKm`.
 */
export function usePickupMode(view: SearchView, setView: (next: SearchView, mode?: 'push' | 'replace') => void) {
  const location = useBrowserLocation();
  const { status, coords, request } = location;
  const near = view.near === 1;
  // The shopper asked for pickup and the answer is still pending; the address changes only once a position exists.
  const intent = useRef(false);

  useEffect(() => {
    if (near && status === 'idle') request();
  }, [near, status, request]);

  useEffect(() => {
    if (status === 'granted' && coords && intent.current) {
      intent.current = false;
      setView(withChange(view, { near: 1 }));
    }
  }, [status, coords, view, setView]);

  const failed = status === 'denied' || status === 'unsupported' || status === 'timeout' || status === 'unavailable';
  useEffect(() => {
    if (!failed) return;
    intent.current = false;
    if (near) setView(withChange(view, { near: undefined, radiusKm: undefined }), 'replace');
  }, [failed, status, near, view, setView]);

  const turnOn = () => {
    intent.current = true;
    request();
  };
  const toggle = () => {
    if (near) {
      intent.current = false;
      setView(withChange(view, { near: undefined, radiusKm: undefined }));
    } else {
      turnOn();
    }
  };

  return { location, near, toggle, retry: turnOn, ready: near && status === 'granted' && coords !== null };
}

/** "Available for pickup near me" (AS-28). */
export function PickupSwitch({ near, onToggle }: { near: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={near}
      onClick={onToggle}
      className="inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring max-sm:min-h-11"
    >
      <span aria-hidden="true" className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', near ? 'bg-primary' : 'bg-input')}>
        <span className={cn('size-4 rounded-full bg-background transition-transform motion-reduce:transition-none', near && 'translate-x-4')} />
      </span>
      Available for pickup near me
    </button>
  );
}

/** The location message of AS-29 (and "Getting your location…" while asking) with **Try again** where retrying can help. */
export function LocationNotice({ status, message, canRetry, onRetry }: { status: string; message: string | null; canRetry: boolean; onRetry: () => void }) {
  if (status === 'asking') {
    return (
      <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
        {LOCATION_MESSAGES.asking}
      </p>
    );
  }
  if (!message) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 text-sm">
      <p>{message}</p>
      {canRetry ? (
        <Button type="button" variant="outline" size="sm" className="min-h-9 max-sm:min-h-11" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** The **Radius** control (1, 2, 5, 10, 20, 50 km; 5 is the default and stays out of the address). */
export function RadiusControl({
  value,
  onChange,
  id: given,
  disabled,
}: {
  value: number;
  onChange: (radiusKm: number) => void;
  id?: string;
  disabled?: boolean;
}) {
  const generated = useId();
  const id = given ?? generated;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        Radius
      </label>
      <select
        id={id}
        value={String(value)}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-9 rounded-md border bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring max-sm:h-11"
      >
        {RADIUS_CHOICES.map((km) => (
          <option key={km} value={km}>{`${km} km`}</option>
        ))}
      </select>
    </div>
  );
}

const SKELETON_CARDS = ['a', 'b', 'c', 'd'] as const;
const isPlainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * The results of pickup mode (AS-28, AS-30): one card per product with the nearest point, the API's order, a failed or
 * empty answer in its own words, and **Next page** by `nextCursor`. The request carries the rounded position and is never
 * cached (`lib/api/pickup.ts`); the query is dropped from the cache as soon as nothing shows it (`gcTime: 0`).
 */
export function PickupResults({
  view,
  coords,
  asking,
  onNavigate,
}: {
  view: SearchView;
  coords: { lat: number; lng: number } | null;
  asking: boolean;
  onNavigate: (href: string) => void;
}) {
  const query = useQuery({
    queryKey: queryKeys.search.near(view, coords ?? { lat: 0, lng: 0 }),
    queryFn: ({ signal }) => fetchPickupNearSearch({ coords: coords!, radiusKm: view.radiusKm ?? DEFAULT_RADIUS_KM, q: view.q, cursor: view.cursor }, { signal }),
    enabled: coords !== null,
    placeholderData: keepPreviousData,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  const data = query.data;
  const problem = query.isError ? problemFromError(query.error) : undefined;
  const busy = asking || (query.isFetching && query.isPlaceholderData);

  const offline = problem?.status === 0;
  const refetch = query.refetch;
  useEffect(() => {
    if (!offline) return;
    const retry = () => void refetch();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [offline, refetch]);

  const items = data?.items ?? [];
  const nextHref = data?.nextCursor ? searchHref({ ...view, cursor: data.nextCursor }) : undefined;
  const firstHref = searchHref(firstPage(view));
  const goTo = (event: MouseEvent, href: string) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    onNavigate(href);
  };

  return (
    <div aria-busy={busy}>
      {problem ? (
        <div className="space-y-3">
          <ProblemAlert problem={problem} surface="pickup-search" />
          {offline ? (
            <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
              Reconnecting…
            </p>
          ) : null}
          <Button type="button" variant="outline" className="min-h-11" disabled={query.isFetching} onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : !data ? (
        asking || query.isPending ? (
          <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4" aria-hidden="true">
            {SKELETON_CARDS.map((name) => (
              <li key={name}>
                <Skeleton className="aspect-[3/4] w-full rounded-xl" />
              </li>
            ))}
          </ul>
        ) : null
      ) : items.length === 0 ? (
        <div className={cn('space-y-2 py-8 text-center', busy && 'opacity-60')} data-testid="search-empty">
          <p className="text-lg font-medium">{PICKUP_EMPTY}</p>
        </div>
      ) : (
        <ul className={cn('grid grid-cols-2 gap-4 transition-opacity motion-reduce:transition-none md:grid-cols-3 lg:grid-cols-4', busy && 'opacity-60')} data-testid="search-results">
          {items.map((item) => (
            <li key={item.productId}>
              <ProductCard {...pickupItemToCard(item)} />
            </li>
          ))}
        </ul>
      )}

      {data && items.length > 0 && (nextHref || view.cursor) ? (
        <nav aria-label="Pages" className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-between">
          {view.cursor ? (
            <a href={firstHref} onClick={(event) => goTo(event, firstHref)} className="inline-flex min-h-11 items-center justify-center rounded-md border px-4 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
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
    </div>
  );
}
