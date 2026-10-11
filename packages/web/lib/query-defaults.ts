import type { QueryClient } from '@tanstack/react-query';

/**
 * The stale-time decision table of W02 (research R-09, AS-71). The app-wide default stays 60 s, no refetch on focus,
 * one retry; these roots override it. Coordinates and pickup answers are never kept (`gcTime: 0`).
 */
export function applyQueryDefaults(client: QueryClient): QueryClient {
  client.setQueryDefaults(['search', 'results'], { staleTime: 60_000 });
  client.setQueryDefaults(['search', 'near'], { staleTime: 0, gcTime: 0 });
  client.setQueryDefaults(['suggest'], { staleTime: 60_000, retry: false });
  client.setQueryDefaults(['rails'], { staleTime: 30_000 });
  client.setQueryDefaults(['product', 'page'], { staleTime: 15_000 });
  client.setQueryDefaults(['pickup'], { staleTime: 0, gcTime: 0 });
  client.setQueryDefaults(['discussions'], { staleTime: 30_000, refetchOnWindowFocus: true });
  client.setQueryDefaults(['share'], { staleTime: Infinity });
  client.setQueryDefaults(['video'], { staleTime: 0 });
  client.setQueryDefaults(['ads'], { staleTime: 30_000 });
  // W03 (FR-057): the cart is re-read on focus (another tab or device may have changed it); orders and payments are
  // fresh while they can still change (the terminal 60 s is applied by the hooks); notifications keep 30 s.
  client.setQueryDefaults(['cart'], { staleTime: 0, refetchOnWindowFocus: true });
  client.setQueryDefaults(['orders', 'list'], { staleTime: 15_000 });
  client.setQueryDefaults(['orders', 'detail'], { staleTime: 0 });
  client.setQueryDefaults(['payments'], { staleTime: 0 });
  client.setQueryDefaults(['notifications'], { staleTime: 30_000, refetchOnWindowFocus: true });
  return client;
}
