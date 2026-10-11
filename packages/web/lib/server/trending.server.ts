import 'server-only';
import { cacheLife, cacheTag } from 'next/cache';
import { trendingResponseSchema, type TrendingResponse } from '@marketplace-sandbox/contracts';
import { apiUrl } from '@/lib/server/endpoints.server';
import { readPublic, type ReadResult } from '@/lib/server/read.server';

/**
 * The home rail's trending read (W02 FR-002, FR-151): `GET /api/trending?limit=8`, category `all`, shared by every
 * visitor for 30 seconds under the tag `trending`. A failed read is kept five seconds so the next visitor retries soon.
 */
export async function getTrending(): Promise<ReadResult<TrendingResponse>> {
  'use cache';
  cacheTag('trending');
  const result = await readPublic(`${apiUrl()}/api/trending?limit=8`, trendingResponseSchema);
  cacheLife(result.ok ? { stale: 30, revalidate: 30, expire: 60 } : { stale: 30, revalidate: 5, expire: 6 });
  return result;
}
