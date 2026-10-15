'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PickupClusterCell } from '@marketplace-sandbox/contracts';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { fetchPickupClusters } from '@/lib/api/pickup';
import { problemFromError } from '@/lib/api/errors';
import { clampZoom, roundBounds, type Bounds, type Coords } from '@/lib/pickup/coords';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

type Viewport = { bounds: Bounds; zoom: number };

const PAUSE_MS = 300;
const START_ZOOM = 12;

/** The area around the shared position at a city zoom: the first view, and the only one when there is no map. */
const around = ({ lat, lng }: Coords): Viewport => ({
  bounds: { south: lat - 0.06, west: lng - 0.1, north: lat + 0.06, east: lng + 0.1 },
  zoom: START_ZOOM,
});

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const cellLabel = (cell: PickupClusterCell, names: ReadonlyMap<string, string>) =>
  (cell.pickupPointId && names.get(cell.pickupPointId)) || `${plural(cell.offers, 'offer', 'offers')} at ${plural(cell.pickupPoints, 'pickup point', 'pickup points')}`;
const cellText = (cell: PickupClusterCell) =>
  `Area near ${cell.lat.toFixed(2)}, ${cell.lng.toFixed(2)}: ${plural(cell.pickupPoints, 'pickup point', 'pickup points')}, ${plural(cell.offers, 'offer', 'offers')}`;

const PHONE = '(max-width: 640px)';
const subscribePhone = (onChange: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/** The libraries' marker element: a focusable button named by what it stands for. */
function markerElement(cell: PickupClusterCell, label: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.setAttribute('aria-label', label);
  element.className =
    'flex min-h-8 min-w-8 items-center justify-center rounded-full border-2 border-background bg-primary px-2 text-xs font-semibold text-primary-foreground shadow focus-visible:outline-2 focus-visible:outline-ring';
  element.textContent = String(cell.offers);
  return element;
}

type MapHandle = { remove: () => void; resize: () => void; getBounds: () => { getSouth: () => number; getWest: () => number; getNorth: () => number; getEast: () => number }; getZoom: () => number };
type MarkerHandle = { remove: () => void };
type MapLibre = {
  Map: new (options: Record<string, unknown>) => MapHandle & { on: (event: string, handler: () => void) => unknown; addControl: (control: unknown, position?: string) => unknown };
  Marker: new (options: { element: HTMLElement }) => { setLngLat: (lngLat: [number, number]) => { addTo: (map: unknown) => MarkerHandle } };
  NavigationControl: new () => unknown;
};

/**
 * The map view of the product page's pickup list (W02 AS-42, FR-075): the clusters of the visible area for this product,
 * asked 300 ms after the map stops moving with the previous request aborted, one focusable marker per cell, and a text
 * list of the same cells (**List view**) that is the only view when no tile source is configured. The map library is
 * imported when this component first mounts (so only after **Show map**); tiles come from the configured address only.
 * Inline on wide screens, a full-screen dialog on phones; **Close** (or Escape) returns focus to the control that opened it.
 */
export function PickupMap({
  productId,
  center,
  points,
  tileUrl = process.env.NEXT_PUBLIC_MAP_TILE_URL || undefined,
  onClose,
}: {
  productId: string;
  center: Coords;
  /** The listed points, to name a single-point cell. */
  points: { id: string; name: string }[];
  tileUrl?: string;
  onClose: () => void;
}) {
  const dialog = useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  const closeRef = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapHandle | null>(null);

  const [mapFailed, setMapFailed] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const mapMode = Boolean(tileUrl) && !mapFailed;
  const [view, setView] = useState<'map' | 'list'>('map');
  const showing = mapMode ? view : 'list';

  // What the shopper is looking at, and what was last still for 300 ms.
  const [pending, setPending] = useState<Viewport | null>(() => (tileUrl ? null : around(center)));
  const [active, setActive] = useState<Viewport | null>(null);
  if (mapFailed && pending === null) setPending(around(center));
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setActive(pending), PAUSE_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const bounds = active ? roundBounds(active.bounds) : null;
  const zoom = active ? clampZoom(active.zoom) : 0;
  const query = useQuery({
    queryKey: queryKeys.pickup.clusters(productId, bounds ?? { south: 0, west: 0, north: 0, east: 0 }, zoom),
    queryFn: ({ signal }) => fetchPickupClusters({ productId, bounds: bounds!, zoom }, { signal }),
    enabled: bounds !== null,
    placeholderData: keepPreviousData,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  const cells = query.data?.cells;
  const problem = query.isError ? problemFromError(query.error) : undefined;

  const names = useRef(new Map<string, string>());
  // Declared before the marker effect, so effects run in order and the marker effect reads the current names.
  useEffect(() => {
    names.current = new Map(points.map((point) => [point.id, point.name]));
  }, [points]);

  // The map itself: created once the library is in, removed with the component.
  useEffect(() => {
    if (!tileUrl || !container.current) return;
    let cancelled = false;
    let map: MapHandle | null = null;
    const node = container.current;
    (async () => {
      try {
        const loaded = (await import('maplibre-gl')) as unknown as MapLibre & { default?: MapLibre };
        const lib: MapLibre = loaded.Map ? loaded : (loaded.default as MapLibre);
        if (cancelled) return;
        const created = new lib.Map({
          container: node,
          style: {
            version: 8,
            sources: { tiles: { type: 'raster', tiles: [tileUrl], tileSize: 256 } },
            layers: [{ id: 'tiles', type: 'raster', source: 'tiles' }],
          },
          center: [center.lng, center.lat],
          zoom: START_ZOOM,
        });
        map = created;
        mapRef.current = created;
        created.addControl(new lib.NavigationControl(), 'top-right');
        const report = () => {
          const b = created.getBounds();
          setPending({ bounds: { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, zoom: created.getZoom() });
        };
        created.on('load', report);
        created.on('moveend', report);
        setMapReady(true);
      } catch {
        if (!cancelled) setMapFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      mapRef.current = null;
      setMapReady(false);
      map?.remove();
    };
    // The map is created once per tile source; later moves of `center` do not rebuild it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileUrl]);

  // One marker per cell.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !cells) return;
    let cancelled = false;
    const placed: MarkerHandle[] = [];
    void import('maplibre-gl').then((loaded) => {
      if (cancelled) return;
      const lib = loaded as unknown as MapLibre & { default?: MapLibre };
      const { Marker } = lib.Marker ? lib : (lib.default as MapLibre);
      for (const cell of cells) {
        placed.push(new Marker({ element: markerElement(cell, cellLabel(cell, names.current)) }).setLngLat([cell.lng, cell.lat]).addTo(map));
      }
    });
    return () => {
      cancelled = true;
      for (const marker of placed) marker.remove();
    };
  }, [cells, mapReady]);

  // A list view hides the map; showing it again needs its size recomputed.
  useEffect(() => {
    if (showing === 'map') mapRef.current?.resize();
  }, [showing]);

  const close = useCallback(() => {
    onClose();
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  }, [onClose, opener]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => {
    if (dialog) closeRef.current?.focus();
  }, [dialog]);

  const busy = query.isFetching || (bounds === null && !problem);

  return (
    <section
      aria-label="Pickup map"
      role={dialog ? 'dialog' : 'region'}
      aria-modal={dialog ? true : undefined}
      aria-busy={busy}
      className={cn('flex flex-col gap-3 bg-background', dialog ? 'fixed inset-0 z-50 overflow-y-auto p-4' : 'rounded-lg border p-4')}
    >
      <div className="flex flex-wrap items-center gap-2">
        {mapMode ? (
          <div className="flex gap-1" role="group" aria-label="Map or list">
            <Button type="button" size="sm" variant={showing === 'map' ? 'default' : 'outline'} aria-pressed={showing === 'map'} className="min-h-9 max-sm:min-h-11" onClick={() => setView('map')}>
              Map view
            </Button>
            <Button type="button" size="sm" variant={showing === 'list' ? 'default' : 'outline'} aria-pressed={showing === 'list'} className="min-h-9 max-sm:min-h-11" onClick={() => setView('list')}>
              List view
            </Button>
          </div>
        ) : null}
        <Button ref={closeRef} type="button" size="sm" variant="outline" className="ml-auto min-h-9 max-sm:min-h-11" onClick={close}>
          Close
        </Button>
      </div>

      {mapMode ? <div ref={container} hidden={showing !== 'map'} className="h-[60vh] min-h-72 w-full overflow-hidden rounded-md bg-muted" /> : null}

      {problem ? (
        <div className="space-y-3">
          <ProblemAlert problem={problem} surface="pickup" />
          <Button type="button" variant="outline" className="min-h-11" disabled={query.isFetching} onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : null}

      {query.data?.truncated ? (
        <p role="status" className="text-sm text-muted-foreground">
          Zoom in to see all areas.
        </p>
      ) : null}

      {showing === 'list' && cells ? (
        cells.length === 0 ? (
          <p className="text-sm">No pickup points in this area.</p>
        ) : (
          <ul aria-label="Pickup areas" className="space-y-2 text-sm">
            {cells.map((cell) => (
              <li key={cell.cellId} className="rounded-md border px-3 py-2">
                {cellText(cell)}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
