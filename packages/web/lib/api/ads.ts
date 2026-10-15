import { sponsoredSlotsResponseSchema, AD_CATEGORY_PATTERN, AD_SLOTS_MAX, type SponsoredSlot } from '@marketplace-sandbox/contracts';
import { getAnonymousId } from '@/lib/analytics/track';
import { safeHttpsUrl } from '@/lib/safe-url';
import { apiClient } from './client';
import { parseBody } from './parse';

export type { SponsoredSlot };

/** A `clickUrl` is used only as an absolute `https` address or a same-origin path (`/api/ads/click/<token>`); never `//host`. */
export function isSafeClickUrl(value: string): boolean {
  if (/^\/(?![/\\])/.test(value)) return !/[\u0000-\u001f]/.test(value);
  return safeHttpsUrl(value) !== undefined;
}

/**
 * `GET /api/ads/sponsored?category&limit=3` (S36 FR-020; W02 FR-131): at most three slots, parsed with
 * `sponsoredSlotsResponseSchema`. The answer is never cached (`Cache-Control: no-store` on the request, no query cache
 * reuse by the caller) and carries the viewer's anonymous id as `X-Anonymous-Id` (absent under a privacy signal; a signed-in
 * visitor is identified by the session cookie). A `category` that is not a lower-case slug is not sent. Items whose
 * `clickUrl` is unusable are dropped; `clickUrl` itself is returned exactly as given. A failure (429, 503, an invalid body,
 * no network) is thrown; the slot treats every failure as "no ads".
 */
export async function fetchSponsored({ category, signal }: { category?: string; signal?: AbortSignal } = {}): Promise<SponsoredSlot[]> {
  const params: Record<string, string | number> = { limit: AD_SLOTS_MAX };
  if (category && AD_CATEGORY_PATTERN.test(category)) params.category = category;
  const anonymousId = getAnonymousId();
  const { data } = await apiClient.get<unknown>('/api/ads/sponsored', {
    params,
    signal,
    anonymous: true,
    headers: { 'Cache-Control': 'no-store', ...(anonymousId ? { 'X-Anonymous-Id': anonymousId } : {}) },
  });
  return parseBody(sponsoredSlotsResponseSchema, data).items.filter((item) => isSafeClickUrl(item.clickUrl));
}
