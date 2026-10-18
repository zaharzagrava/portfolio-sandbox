import 'server-only';
import { flagAuditPageSchema, flagPageSchema, flagSchema, staleFlagsSchema, type Flag, type FlagAuditPage, type FlagPage, type StaleFlags } from '@marketplace-sandbox/contracts';
import { readAsMember } from '@/lib/server/member-read.server';
import type { ReadResult } from '@/lib/server/read.server';

const BASE = '/api/bff/f/admin/flags';

/**
 * Server prefetch of the console's first answers as the signed-in admin (W06 FR-003): only the session cookie is forwarded
 * (by `readAsMember`), never a token. A failure comes back as a value; the page then leaves the cache empty and the browser
 * reads again and shows its own state, so no flag data and no error text is cached on the server. Never call these inside
 * `"use cache"`.
 */
export function getFlagPage(params: { status?: string; cursor?: string }): Promise<ReadResult<FlagPage>> {
  const query = new URLSearchParams();
  if (params.status && params.status !== 'all') query.set('status', params.status);
  if (params.status === 'archived') query.set('includeArchived', 'true');
  if (params.cursor) query.set('cursor', params.cursor);
  const text = query.toString();
  return readAsMember(text ? `${BASE}?${text}` : BASE, flagPageSchema);
}

export function getFlagServer(key: string): Promise<ReadResult<Flag>> {
  return readAsMember(`${BASE}/${encodeURIComponent(key)}`, flagSchema);
}

export function getHistoryPage(key: string, params: { cursor?: string }): Promise<ReadResult<FlagAuditPage>> {
  const query = params.cursor ? `?cursor=${encodeURIComponent(params.cursor)}` : '';
  return readAsMember(`${BASE}/${encodeURIComponent(key)}/history${query}`, flagAuditPageSchema);
}

export function getStale(params: { days: number }): Promise<ReadResult<StaleFlags>> {
  return readAsMember(`${BASE}/stale?days=${params.days}`, staleFlagsSchema);
}
