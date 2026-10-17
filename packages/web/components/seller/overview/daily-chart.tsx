'use client';

import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import type { SellerOverviewResponse } from '@/lib/api/seller';
import { formatMoney } from '@/lib/utils';
import { SALES_UNAVAILABLE, SectionFrame, SectionUnavailable, formatDay } from './section-frame';

type Stats = NonNullable<SellerOverviewResponse['stats']>;

/**
 * Revenue per day (W04 AS-14, FR-018): a bar chart for the eye, a text summary and a table for everyone else. The chart is
 * hidden from assistive technology; the summary and the table carry the same numbers. The toggle is local state, not URL.
 */
export function DailyChart({ stats, days, busy, onRetry }: { stats: Stats | null; days: number; busy: boolean; onRetry: () => void }) {
  const [asTable, setAsTable] = useState(false);
  const title = `Revenue per day, last ${stats?.days ?? days} days`;
  if (!stats) {
    return (
      <SectionFrame title={title}>
        <SectionUnavailable text={SALES_UNAVAILABLE} onRetry={onRetry} />
      </SectionFrame>
    );
  }
  const { daily, currency } = stats;
  const money = (minor: number) => formatMoney(minor, currency);
  let best: (typeof daily)[number] | null = null;
  for (const entry of daily) if (entry.revenueMinor > 0 && (!best || entry.revenueMinor > best.revenueMinor)) best = entry;
  const summary = best ? `Best day: ${formatDay(best.day)}, ${money(best.revenueMinor)}` : 'No sales in this period yet.';

  return (
    <SectionFrame title={title} busy={busy}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{summary}</p>
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" onClick={() => setAsTable((on) => !on)}>
          {asTable ? 'View as chart' : 'View as table'}
        </Button>
      </div>
      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">Day</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Revenue</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Orders</th>
                <th scope="col" className="py-1.5 font-medium">Refunded</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((entry) => (
                <tr key={entry.day} className="border-b last:border-0">
                  <td className="py-1.5 pr-3">{formatDay(entry.day)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{money(entry.revenueMinor)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{entry.orders}</td>
                  <td className="py-1.5 tabular-nums">{money(entry.refundedMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div aria-hidden="true" className="h-60 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={daily} accessibilityLayer={false} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} strokeOpacity={0.3} />
              <XAxis dataKey="day" tickFormatter={(day: string) => formatDay(day, true)} interval="preserveStartEnd" minTickGap={24} tickLine={false} />
              <YAxis width={72} tickLine={false} axisLine={false} tickFormatter={(minor: number) => money(minor)} />
              <Tooltip formatter={(value) => money(Number(value))} labelFormatter={(day) => formatDay(String(day))} />
              <Bar dataKey="revenueMinor" name="Revenue" fill="currentColor" className="text-primary" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </SectionFrame>
  );
}
