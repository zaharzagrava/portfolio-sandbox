'use client';

import type { SellerOverviewResponse } from '@/lib/api/seller';
import { formatMoney } from '@/lib/utils';
import { SectionFrame, SectionUnavailable } from './section-frame';

type Today = SellerOverviewResponse['today'];

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

/** The busiest minute of the day, the first one on a tie (W04 AS-26). `null` when no minute has an order. */
function busiest(series: NonNullable<Today>['series']) {
  let best: (typeof series)[number] | null = null;
  for (const point of series) if (point.orders > 0 && (!best || point.orders > best.orders)) best = point;
  return best;
}

/** "Today (UTC)": the UTC day's totals and the per-minute series with its text alternative (W04 AS-26, AS-15). */
export function TodayCard({ today, currency, onRetry }: { today: Today; currency?: string; onRetry: () => void }) {
  if (!today) {
    return (
      <SectionFrame title="Today (UTC)">
        <SectionUnavailable text="Today's numbers are temporarily unavailable." onRetry={onRetry} />
      </SectionFrame>
    );
  }
  const { totals, series } = today;
  if (totals.orders === 0) {
    return (
      <SectionFrame title="Today (UTC)">
        <p className="text-sm text-muted-foreground">No orders yet today.</p>
      </SectionFrame>
    );
  }
  const top = busiest(series);
  const peak = Math.max(1, ...series.map((point) => point.orders));
  const noun = totals.orders === 1 ? 'order' : 'orders';
  const alternative = `${totals.orders} ${noun} today${top ? `, busiest minute ${top.minute.slice(11, 16)} UTC` : ''}`;
  return (
    <SectionFrame title="Today (UTC)">
      <dl className="grid grid-cols-3 gap-3">
        <Stat label="Orders">{totals.orders.toLocaleString('en-US')}</Stat>
        <Stat label="Units">{totals.units.toLocaleString('en-US')}</Stat>
        <Stat label="Revenue">{currency ? formatMoney(totals.revenueMinor, currency) : '—'}</Stat>
      </dl>
      {series.length > 0 && (
        <div role="img" aria-label={alternative} className="flex h-12 items-end gap-0.5">
          {series.map((point) => (
            <div key={point.minute} className="min-w-0.5 flex-1 rounded-t bg-primary" style={{ height: `${Math.max(8, (point.orders / peak) * 100)}%` }} />
          ))}
        </div>
      )}
    </SectionFrame>
  );
}
