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
  // W05 (FR-073): chat reads follow the decision table; the unread number is the server's, so nothing is kept long. Messages are
  // invalidated by the catch-up (FR-041); the more specific roots below win over nothing (there is no `['chat']` default).
  client.setQueryDefaults(['chat', 'inbox'], { staleTime: 15_000 });
  client.setQueryDefaults(['chat', 'unreadTotal'], { staleTime: 30_000 });
  client.setQueryDefaults(['chat', 'channel'], { staleTime: 60_000 });
  client.setQueryDefaults(['chat', 'byProduct'], { staleTime: 0 });
  client.setQueryDefaults(['chat', 'messages'], { staleTime: 0 });
  client.setQueryDefaults(['chat', 'receipts'], { staleTime: 0 });
  client.setQueryDefaults(['chat', 'presence'], { staleTime: 30_000 });
  client.setQueryDefaults(['assistant', 'conversations'], { staleTime: 60_000 });
  client.setQueryDefaults(['assistant', 'history'], { staleTime: ASSISTANT_HISTORY_STALE_MS });
  client.setQueryDefaults(['assistant', 'usage'], { staleTime: 60_000 });
  return client;
}

const ASSISTANT_HISTORY_STALE_MS = 60_000;

/** `assistant.history` is stale at once while a reply runs (the stream and the history must agree), 60 s otherwise (FR-073). */
export function assistantHistoryStaleTime(replyRunning: boolean): number {
  return replyRunning ? 0 : ASSISTANT_HISTORY_STALE_MS;
}
