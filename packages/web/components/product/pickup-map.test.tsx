import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { delay, http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { clustersBody, PRODUCT_ID, problemResponse } from '@/lib/test/msw-handlers';

type Handler = () => void;
const maplibre = vi.hoisted(() => {
  const state = {
    maps: [] as {
      options: Record<string, unknown>;
      handlers: Record<string, Handler[]>;
      bounds: { south: number; west: number; north: number; east: number };
      zoom: number;
      removed: boolean;
    }[],
    markers: [] as { element: HTMLElement; lngLat?: [number, number]; removed: boolean }[],
  };
  class FakeMap {
    options: Record<string, unknown>;
    handlers: Record<string, Handler[]> = {};
    bounds = { south: 52.123456, west: 13.123456, north: 52.987654, east: 13.987654 };
    zoom = 11.6;
    removed = false;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      state.maps.push(this);
    }
    on(event: string, handler: Handler) {
      (this.handlers[event] ??= []).push(handler);
      return this;
    }
    addControl() {}
    resize() {}
    getBounds() {
      const b = this.bounds;
      return { getSouth: () => b.south, getWest: () => b.west, getNorth: () => b.north, getEast: () => b.east };
    }
    getZoom() {
      return this.zoom;
    }
    remove() {
      this.removed = true;
    }
  }
  class FakeMarker {
    element: HTMLElement;
    lngLat?: [number, number];
    removed = false;
    constructor(options: { element: HTMLElement }) {
      this.element = options.element;
      state.markers.push(this);
    }
    setLngLat(lngLat: [number, number]) {
      this.lngLat = lngLat;
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      this.removed = true;
    }
  }
  class FakeNavigationControl {}
  return { state, Map: FakeMap, Marker: FakeMarker, NavigationControl: FakeNavigationControl };
});
vi.mock('maplibre-gl', () => ({
  default: { Map: maplibre.Map, Marker: maplibre.Marker, NavigationControl: maplibre.NavigationControl },
  Map: maplibre.Map,
  Marker: maplibre.Marker,
  NavigationControl: maplibre.NavigationControl,
}));

import { PickupMap } from '@/components/product/pickup-map';

const TILES = 'https://tiles.example/{z}/{x}/{y}.png';
const POINT_ID = '00000000-0000-4000-8000-000000000001';
const CENTER = { lat: 52.52, lng: 13.405 };

const requests: { url: URL; signal: AbortSignal | undefined }[] = [];
const answerClusters = (handler: (url: URL) => Response | Promise<Response> = () => HttpResponse.json(clustersBody())) =>
  server.use(http.get('*/api/pickup-points/clusters', ({ request }) => handler(new URL(request.url))));

beforeEach(() => {
  maplibre.state.maps.length = 0;
  maplibre.state.markers.length = 0;
  requests.length = 0;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname.endsWith('/clusters')) requests.push({ url, signal: init?.signal ?? undefined });
    return real(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

function Harness({ tileUrl, onClose }: { tileUrl?: string; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <QueryClientProvider client={applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } }))}>
      <button type="button" onClick={() => setOpen(true)}>
        Show map
      </button>
      {open ? (
        <PickupMap
          productId={PRODUCT_ID}
          center={CENTER}
          points={[{ id: POINT_ID, name: 'Mitte Locker' }]}
          tileUrl={tileUrl}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        />
      ) : null}
    </QueryClientProvider>
  );
}

/** Opens the map from its trigger; `null` is "no tile source configured". */
async function open(tileUrl: string | null = TILES, onClose?: () => void) {
  const user = userEvent.setup();
  render(<Harness tileUrl={tileUrl ?? undefined} onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'Show map' }));
  return user;
}

/** The map reports where it is: set the bounds the fake map answers with and fire the event. */
const moveTo = (bounds: { south: number; west: number; north: number; east: number }, zoom: number, event = 'moveend') => {
  const map = maplibre.state.maps.at(-1)!;
  map.bounds = bounds;
  map.zoom = zoom;
  act(() => map.handlers[event]?.forEach((handler) => handler()));
};
const whenMapReady = () => waitFor(() => expect(maplibre.state.maps).toHaveLength(1));

describe('PickupMap', () => {
  it('W02 AS-42: the request goes out after a 300 ms pause with bounds to four decimals as top,left,bottom,right and an integer zoom', async () => {
    answerClusters();
    await open();
    await whenMapReady();
    const started = performance.now();
    moveTo({ south: 52.123456, west: 13.123456, north: 52.987654, east: 13.987654 }, 11.6, 'load');
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(performance.now() - started).toBeGreaterThanOrEqual(280);
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({
      bbox: '52.9877,13.1235,52.1235,13.9877',
      zoom: '12',
      productId: PRODUCT_ID,
    });
  });

  it('W02 AS-42: a burst of moves sends one request for the last view, and a superseded request in flight is aborted', async () => {
    answerClusters(async () => {
      await delay(400);
      return HttpResponse.json(clustersBody());
    });
    await open();
    await whenMapReady();
    moveTo({ south: 10, west: 10, north: 11, east: 11 }, 5);
    moveTo({ south: 20, west: 20, north: 21, east: 21 }, 6);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.url.searchParams.get('bbox')).toBe('21,20,20,21');
    const first = requests[0]!.signal;
    moveTo({ south: 30, west: 30, north: 31, east: 31 }, 7);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.url.searchParams.get('bbox')).toBe('31,30,30,31');
    await waitFor(() => expect(first?.aborted).toBe(true));
    expect(requests[1]!.signal?.aborted).toBe(false);
  });

  it('W02 AS-42: the map uses the configured tile address and no other host', async () => {
    answerClusters();
    await open();
    await whenMapReady();
    const style = maplibre.state.maps[0]!.options.style as { sources: Record<string, { tiles: string[] }> };
    const hosts = Object.values(style.sources).flatMap((source) => source.tiles.map((tile) => new URL(tile.replace(/\{[xyz]\}/g, '0')).origin));
    expect(hosts).toEqual(['https://tiles.example']);
  });

  it('W02 AS-42: one marker per cell, named by its offers and pickup points, or by the point name when the list has it', async () => {
    answerClusters();
    await open();
    await whenMapReady();
    moveTo({ south: 52, west: 13, north: 53, east: 14 }, 10, 'load');
    await waitFor(() => expect(maplibre.state.markers.filter((marker) => !marker.removed)).toHaveLength(2));
    const labels = maplibre.state.markers.map((marker) => marker.element.getAttribute('aria-label'));
    expect(labels).toEqual(['12 offers at 3 pickup points', 'Mitte Locker']);
    for (const marker of maplibre.state.markers) expect(marker.element.tagName).toBe('BUTTON');
    expect(maplibre.state.markers[0]!.lngLat).toEqual([13.4, 52.52]);
  });

  it('W02 AS-42: a single-point cell that is not in the list is named by its counts', async () => {
    answerClusters(() =>
      HttpResponse.json(clustersBody({ cells: [{ cellId: 'x', offers: 1, pickupPoints: 1, lat: 52.5, lng: 13.4, pickupPointId: '00000000-0000-4000-8000-000000000099' }] })),
    );
    await open();
    await whenMapReady();
    moveTo({ south: 52, west: 13, north: 53, east: 14 }, 10, 'load');
    await waitFor(() => expect(maplibre.state.markers).toHaveLength(1));
    expect(maplibre.state.markers[0]!.element.getAttribute('aria-label')).toBe('1 offer at 1 pickup point');
  });

  it('W02 AS-42: when the answer is truncated a note says to zoom in', async () => {
    answerClusters(() => HttpResponse.json(clustersBody({ truncated: true })));
    await open();
    await whenMapReady();
    moveTo({ south: 52, west: 13, north: 53, east: 14 }, 3, 'load');
    expect(await screen.findByText('Zoom in to see all areas.')).toBeInTheDocument();
  });

  it('W02 AS-42: List view shows the same cells as text', async () => {
    answerClusters();
    const user = await open();
    await whenMapReady();
    moveTo({ south: 52, west: 13, north: 53, east: 14 }, 10, 'load');
    await waitFor(() => expect(maplibre.state.markers).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'List view' }));
    const list = screen.getByRole('list', { name: 'Pickup areas' });
    expect(within(list).getByText('Area near 52.52, 13.40: 3 pickup points, 12 offers')).toBeInTheDocument();
    expect(within(list).getByText('Area near 52.51, 13.38: 1 pickup point, 2 offers')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Map view' }));
    expect(screen.queryByRole('list', { name: 'Pickup areas' })).not.toBeInTheDocument();
  });

  it('W02 AS-42: with no tile source List view is the only view: no map code, no view switch, the request still goes out', async () => {
    answerClusters();
    await open(null);
    const list = await screen.findByRole('list', { name: 'Pickup areas' });
    expect(within(list).getByText('Area near 52.52, 13.40: 3 pickup points, 12 offers')).toBeInTheDocument();
    expect(maplibre.state.maps).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Map view' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'List view' })).not.toBeInTheDocument();
    expect(requests).toHaveLength(1);
    // The first view is the area around the shared position at a city zoom.
    const [top, left, bottom, right] = requests[0]!.url.searchParams.get('bbox')!.split(',').map(Number);
    expect(top).toBeGreaterThan(CENTER.lat);
    expect(bottom).toBeLessThan(CENTER.lat);
    expect(left).toBeLessThan(CENTER.lng);
    expect(right).toBeGreaterThan(CENTER.lng);
  });

  it('W02 AS-42: a failed request shows the pickup failure with Try again, in the panel only', async () => {
    answerClusters(() => problemResponse(503, 'search_unavailable', { requestId: 'req-5' }));
    await open(null);
    expect(await screen.findByText('Pickup availability is temporarily unavailable. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('W02 AS-42: Close removes the map and returns focus to Show map', async () => {
    answerClusters();
    const onClose = vi.fn();
    const user = await open(TILES, onClose);
    await whenMapReady();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(maplibre.state.maps[0]!.removed).toBe(true);
    expect(screen.getByRole('button', { name: 'Show map' })).toHaveFocus();
  });

  it('W02 AS-42: Escape closes the map the same way', async () => {
    answerClusters();
    const user = await open(null);
    await screen.findByRole('list', { name: 'Pickup areas' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Pickup map' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show map' })).toHaveFocus();
  });
});
