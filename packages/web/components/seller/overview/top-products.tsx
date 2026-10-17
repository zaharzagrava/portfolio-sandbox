'use client';

import type { SellerOverviewResponse } from '@/lib/api/seller';
import { formatMoney } from '@/lib/utils';
import { SALES_UNAVAILABLE, SectionFrame, SectionUnavailable } from './section-frame';

type Stats = NonNullable<SellerOverviewResponse['stats']>;

/** Up to 5 best sellers of the period, in the order returned (W04 AS-13): the title as recorded on the sale, as plain text. */
export function TopProducts({ stats, busy, onRetry }: { stats: Stats | null; busy: boolean; onRetry: () => void }) {
  if (!stats) {
    return (
      <SectionFrame title="Top products">
        <SectionUnavailable text={SALES_UNAVAILABLE} onRetry={onRetry} />
      </SectionFrame>
    );
  }
  return (
    <SectionFrame title="Top products" busy={busy}>
      {stats.topProducts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sales in this period yet.</p>
      ) : (
        <ol className="space-y-2 text-sm">
          {stats.topProducts.map((product) => (
            <li key={product.productId} className="break-words">
              {`${product.title} — ${product.unitsSold.toLocaleString('en-US')} sold — ${formatMoney(product.revenueMinor, stats.currency)}`}
            </li>
          ))}
        </ol>
      )}
    </SectionFrame>
  );
}
