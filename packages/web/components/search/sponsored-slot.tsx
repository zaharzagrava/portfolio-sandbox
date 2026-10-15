'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchSponsored } from '@/lib/api/ads';
import { queryKeys } from '@/lib/query-keys';
import { formatMoney } from '@/lib/utils';

/**
 * The sponsored slot above the first page of results (W02 AS-66, FR-131). Off unless the deploy enables it (`enabled`; the
 * page reads `STOREFRONT_ADS_ENABLED` on the server): then no request is made. Up to three cards labelled "Sponsored"; each
 * is a plain anchor to `clickUrl` exactly as given (no router link, so nothing is prefetched, and the answer is never kept:
 * `gcTime` and `staleTime` are 0) with `rel="sponsored nofollow"`. Empty, `429`, `503`, an invalid body and no network
 * render nothing and no message. Titles are text.
 */
export function SponsoredSlot({ enabled = false, category }: { enabled?: boolean; category?: string }) {
  const ads = useQuery({
    queryKey: queryKeys.ads.sponsored(category),
    queryFn: ({ signal }) => fetchSponsored({ category, signal }),
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (!enabled || !ads.data || ads.data.length === 0) return null;

  return (
    <section aria-label="Sponsored" className="mb-4" data-testid="sponsored-slot">
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {ads.data.map((item) => (
          <li key={item.campaignId}>
            <a
              href={item.clickUrl}
              rel="sponsored nofollow"
              className="flex min-h-11 h-full flex-col gap-1 rounded-xl border bg-card p-4 hover:shadow-md focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
            >
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sponsored</span>
              <span className="line-clamp-2 text-base font-medium">{item.title}</span>
              <span className="mt-auto pt-2 text-lg font-semibold">{formatMoney(item.priceMinor, item.currency)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
