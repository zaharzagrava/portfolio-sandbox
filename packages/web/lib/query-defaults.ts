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
  return client;
}
