'use client';

import { usePathname, useRouter } from 'next/navigation';
import { ProblemPanel } from '@/components/seller/problem-states';
import { ShopNotFound } from '@/components/seller/shop-not-found';
import { problemFromError } from '@/lib/api/errors';
import { useOverview, type SellerOverviewResponse } from '@/lib/api/seller';
import { roleLabel } from '@/lib/seller/nav';
import { buildQuery, DEFAULT_OVERVIEW_DAYS, OVERVIEW_DAYS } from '@/lib/seller/search-params';
import { DailyChart } from './daily-chart';
import { LivePanel } from './live-panel';
import { RankCard } from './rank-card';
import { Tiles } from './tiles';
import { TodayCard } from './today-card';
import { TopProducts } from './top-products';

const titleCase = (value: string) => value.charAt(0) + value.slice(1).toLowerCase();

/**
 * The seller overview (W04 FR-017..FR-019, AS-10..AS-18): one composed answer, rendered as header, live panel, "Today (UTC)",
 * period tiles, rank, daily chart and top products. A section that failed shows its own message and "Try again"; the shop
 * itself failing is a page-level state. The period lives in the URL; the previous period stays on screen while the next loads.
 */
export function OverviewView({ shopId, days, initialData }: { shopId: string; days: number; initialData?: SellerOverviewResponse }) {
  const router = useRouter();
  const pathname = usePathname();
  const overview = useOverview(shopId, days, initialData);
  const data = overview.data;

  if (!data) {
    if (overview.isError) {
      const problem = problemFromError(overview.error);
      if (problem.code === 'shop_not_found') return <ShopNotFound />;
      return <ProblemPanel problem={problem} context={{ kind: 'read', place: 'page' }} onRetry={() => void overview.refetch()} />;
    }
    return null;
  }

  const { shop, stats, today, rank } = data;
  const busy = overview.isPlaceholderData;
  const retry = () => void overview.refetch();
  const choosePeriod = (value: string) => {
    const query = buildQuery({ days: Number(value) }, { days: DEFAULT_OVERVIEW_DAYS });
    router.push(`${pathname ?? `/dashboard/seller/${shopId}`}${query ? `?${query}` : ''}`, { scroll: false });
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-3xl font-bold tracking-tight" data-testid="seller-shop-name">
            {shop.name}
          </h1>
          <p className="text-muted-foreground">{`@${shop.slug} · ${titleCase(shop.plan)} plan · Your role: ${roleLabel(shop.myRole ?? '')}`}</p>
        </div>
        <div className="flex w-full flex-col gap-1 sm:w-auto">
          <label htmlFor="overview-period" className="text-xs text-muted-foreground">
            Period
          </label>
          <select
            id="overview-period"
            value={String(days)}
            onChange={(event) => choosePeriod(event.target.value)}
            className="h-11 rounded-lg border border-input bg-transparent px-2.5 text-sm sm:h-8"
          >
            {OVERVIEW_DAYS.map((option) => (
              <option key={option} value={option}>
                {`Last ${option} days`}
              </option>
            ))}
          </select>
          <span role="status" className="sr-only">
            {busy ? 'Loading…' : ''}
          </span>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <LivePanel shopId={shopId} currency={stats?.currency} />
        <TodayCard today={today} currency={stats?.currency} onRetry={retry} />
      </div>
      <Tiles stats={stats} days={days} busy={busy} onRetry={retry} />
      <RankCard rank={rank} onRetry={retry} />
      <DailyChart stats={stats} days={days} busy={busy} onRetry={retry} />
      <TopProducts stats={stats} busy={busy} onRetry={retry} />
    </div>
  );
}
