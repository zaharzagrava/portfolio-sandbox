'use client';

import type { SellerOverviewResponse } from '@/lib/api/seller';
import { formatMoney } from '@/lib/utils';
import { SALES_UNAVAILABLE, SectionFrame, SectionUnavailable } from './section-frame';

type Stats = NonNullable<SellerOverviewResponse['stats']>;

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div data-tile className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{children}</p>
    </div>
  );
}

/** Above 1,000 unique buyers the count is approximate (W04 AS-11). */
const buyers = (count: number) => `${count > 1000 ? '≈' : ''}${count.toLocaleString('en-US')}`;

/** The period summary tiles (W04 AS-11): every amount from its minor-unit value and the response's own currency. */
export function Tiles({ stats, days, busy, onRetry }: { stats: Stats | null; days: number; busy: boolean; onRetry: () => void }) {
  const title = `Last ${stats?.days ?? days} days`;
  if (!stats) {
    return (
      <SectionFrame title={title}>
        <SectionUnavailable text={SALES_UNAVAILABLE} onRetry={onRetry} />
      </SectionFrame>
    );
  }
  const { summary, currency } = stats;
  const money = (minor: number) => formatMoney(minor, currency);
  return (
    <SectionFrame title={title} busy={busy}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Revenue">{money(summary.revenueMinor)}</Tile>
        <Tile label="Net revenue">{money(summary.netRevenueMinor)}</Tile>
        <Tile label="Refunded">{`${summary.refundsCount.toLocaleString('en-US')} · ${money(summary.refundedMinor)}`}</Tile>
        <Tile label="Orders">{summary.orders.toLocaleString('en-US')}</Tile>
        <Tile label="Units sold">{summary.unitsSold.toLocaleString('en-US')}</Tile>
        <Tile label="Unique buyers">{buyers(summary.uniqueBuyers)}</Tile>
        <Tile label="Average order value">{money(summary.avgOrderValueMinor)}</Tile>
      </div>
    </SectionFrame>
  );
}
