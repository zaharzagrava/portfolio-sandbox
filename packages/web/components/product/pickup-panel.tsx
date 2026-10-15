'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { PickupPointNear } from '@marketplace-sandbox/contracts';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { RadiusControl } from '@/components/search/pickup-mode';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useBrowserLocation } from '@/hooks/use-browser-location';
import { fetchPickupPoints, PICKUP_PAGE_SIZE } from '@/lib/api/pickup';
import { problemFromError } from '@/lib/api/errors';
import { formatDistance, openingStatus, openingText } from '@/lib/pickup/format';
import { LOCATION_MESSAGES } from '@/lib/pickup/location-copy';
import { queryKeys } from '@/lib/query-keys';
import { DEFAULT_RADIUS_KM } from '@/lib/search/search-view';

/** The map and its library are fetched when **Show map** is first pressed, never with the tab (FR-075, FR-077). */
const PickupMap = lazy(() => import('@/components/product/pickup-map').then((module) => ({ default: module.PickupMap })));

/** A page can repeat a point the previous page already had (the index moved); each point shows once, by `id`. */
function uniquePoints(pages: { items: PickupPointNear[] }[] | undefined): PickupPointNear[] {
  const seen = new Set<string>();
  const points: PickupPointNear[] = [];
  for (const page of pages ?? []) {
    for (const point of page.items) {
      if (seen.has(point.id)) continue;
      seen.add(point.id);
      points.push(point);
    }
  }
  return points;
}

function PointItem({ point, now, ref }: { point: PickupPointNear; now: Date; ref?: (node: HTMLLIElement | null) => void }) {
  return (
    <li ref={ref} tabIndex={-1} className="rounded-lg border p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="pickup-point">
      <h3 className="text-base font-medium">{point.name}</h3>
      <p className="text-sm text-muted-foreground">{point.address}</p>
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
        <span>{formatDistance(point.distanceM)}</span>
        {point.quantity !== undefined ? <span>{`${point.quantity} available`}</span> : null}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{openingText(openingStatus(point.openingHours, now))}</p>
    </li>
  );
}

/**
 * **Pickup near me** on the product page (W02 AS-41..AS-44): nothing happens until the shopper presses **Use my location**;
 * then the points that hold this product are listed ten at a time, nearest first, within a radius chosen for the page
 * visit (not in the address). The list is an infinite query keyed by `(productId, radiusKm, coordinates to 3 decimals)`
 * and never cached (`gcTime: 0`, `no-store`); every failure has one visible form and leaves the rest of the page alone.
 */
export function PickupPanel({ productId }: { productId: string }) {
  const location = useBrowserLocation();
  const { status, coords } = location;
  const [radiusKm, setRadiusKm] = useState<number>(DEFAULT_RADIUS_KM);
  const [mapOpen, setMapOpen] = useState(false);

  const query = useInfiniteQuery({
    queryKey: queryKeys.pickup.near(productId, { radiusKm, ...(coords ?? { lat: 0, lng: 0 }) }),
    queryFn: ({ pageParam, signal }) => fetchPickupPoints({ productId, coords: coords!, radiusKm, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: status === 'granted' && coords !== null,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });

  const points = useMemo(() => uniquePoints(query.data?.pages), [query.data]);
  // Opening status is read at the moment the list arrives, never while typing or scrolling.
  const now = useMemo(() => new Date(), [query.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // **Show 10 more** moves focus to the first point it added.
  const items = useRef(new Map<string, HTMLLIElement>());
  const focusAfter = useRef<number | null>(null);
  useEffect(() => {
    if (focusAfter.current === null || points.length <= focusAfter.current) return;
    const target = points[focusAfter.current];
    focusAfter.current = null;
    if (target) items.current.get(target.id)?.focus();
  }, [points]);

  const problem = query.isError ? problemFromError(query.error) : undefined;
  const offline = problem?.status === 0;
  const refetch = query.refetch;
  useEffect(() => {
    if (!offline) return;
    const retry = () => void refetch();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [offline, refetch]);

  const locationFailed = status === 'denied' || status === 'unsupported' || status === 'timeout' || status === 'unavailable';
  const showMore = () => {
    focusAfter.current = points.length;
    void query.fetchNextPage();
  };

  if (status === 'idle') {
    return (
      <div className="space-y-3">
        <p className="text-sm">See which pickup points near you have this product.</p>
        <Button type="button" className="min-h-11" onClick={location.request}>
          Use my location
        </Button>
      </div>
    );
  }
  if (status === 'asking') {
    return (
      <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
        {LOCATION_MESSAGES.asking}
      </p>
    );
  }
  if (locationFailed) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-3 text-sm">
        <p>{location.message}</p>
        {location.canRetry ? (
          <Button type="button" variant="outline" className="min-h-11" onClick={location.request}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4" aria-busy={query.isFetching}>
      <div className="flex flex-wrap items-center gap-3">
        <RadiusControl value={radiusKm} onChange={setRadiusKm} />
        <Button type="button" variant="outline" className="min-h-9 max-sm:min-h-11" aria-expanded={mapOpen} onClick={() => setMapOpen(true)}>
          Show map
        </Button>
      </div>
      {mapOpen && coords ? (
        <Suspense fallback={<p role="status" aria-busy="true" className="text-sm text-muted-foreground">Loading the map…</p>}>
          <PickupMap productId={productId} center={coords} points={points.map(({ id, name }) => ({ id, name }))} onClose={() => setMapOpen(false)} />
        </Suspense>
      ) : null}

      {problem ? (
        <div className="space-y-3">
          <ProblemAlert problem={problem} surface="pickup" />
          {offline ? (
            <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
              Reconnecting…
            </p>
          ) : null}
          <Button type="button" variant="outline" className="min-h-11" disabled={query.isFetching} onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : query.isPending ? (
        <ul className="space-y-3" aria-hidden="true">
          <li>
            <Skeleton className="h-24 w-full rounded-lg" />
          </li>
          <li>
            <Skeleton className="h-24 w-full rounded-lg" />
          </li>
        </ul>
      ) : points.length === 0 ? (
        <p className="text-sm">{`No pickup point within ${radiusKm} km has this product. Try a larger radius.`}</p>
      ) : (
        <>
          <ul className="space-y-3" aria-label="Pickup points">
            {points.map((point) => (
              <PointItem
                key={point.id}
                point={point}
                now={now}
                ref={(node) => {
                  if (node) items.current.set(point.id, node);
                  else items.current.delete(point.id);
                }}
              />
            ))}
          </ul>
          {query.hasNextPage ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={query.isFetchingNextPage} onClick={showMore}>
              {`Show ${PICKUP_PAGE_SIZE} more`}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
