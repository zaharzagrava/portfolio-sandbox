'use client';

import { SectionError } from '@/components/seller/problem-states';
import { TableRowsSkeleton } from '@/components/seller/page-skeletons';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useShopPayouts, useUpcomingPayout, type PayoutView, type UpcomingPayoutView } from '@/lib/api/seller-finance';
import { formatInstant } from '@/lib/seller/format-date';
import { formatMoney } from '@/lib/utils';
import { BalanceCard } from '../balance-card';

const STATUS_LABEL: Record<PayoutView['status'], string> = {
  PENDING: 'Pending',
  IN_TRANSIT: 'In transit',
  PAID: 'Paid',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const BLOCKED_COPY: Record<NonNullable<UpcomingPayoutView['blockedReason']>, string> = {
  payouts_disabled: 'Payouts are switched off for this shop.',
  destination_missing: 'Add a payout destination to be paid.',
  destination_cooling: 'Your new payout destination is still in its waiting period.',
  below_minimum: 'The balance is below the minimum payout.',
};

function statusVariant(status: PayoutView['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'PAID') return 'default';
  if (status === 'FAILED') return 'destructive';
  return status === 'CANCELLED' ? 'outline' : 'secondary';
}

const columns: Column<PayoutView>[] = [
  { id: 'week', header: 'Week of', primary: true, cell: (payout) => payout.periodStart },
  { id: 'amount', header: 'Amount', cell: (payout) => formatMoney(payout.amountMinor, payout.currency) },
  { id: 'status', header: 'Status', cell: (payout) => <Badge variant={statusVariant(payout.status)}>{STATUS_LABEL[payout.status]}</Badge> },
  { id: 'paid', header: 'Paid', cell: (payout) => (payout.paidAt ? formatInstant(payout.paidAt, { time: false }).text : '—') },
];

/** The balance, the next payout and the payout history of a shop (W04 US10, S14/S15). All text is fixed per status and reason. */
export function PayoutsView({ shopId }: { shopId: string }) {
  const payouts = useShopPayouts(shopId);
  const upcoming = useUpcomingPayout(shopId);
  const next = upcoming.data;
  const items = payouts.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Payouts</h1>
        <p className="text-sm text-muted-foreground">Transfers of your balance to your payout destination.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <BalanceCard shopId={shopId} />
        <Card data-testid="upcoming-payout">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Next payout</CardTitle>
            {next && <CardDescription>{`Next run ${formatInstant(next.nextRunAt, { time: false }).text}`}</CardDescription>}
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {upcoming.isError ? (
              <SectionError error={upcoming.error} onRetry={() => void upcoming.refetch()} />
            ) : !next ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : (
              <>
                <p className="text-2xl font-bold tabular-nums" data-testid="upcoming-estimate">
                  {formatMoney(next.estimatedPayoutMinor, next.currency)}
                </p>
                <p className="text-muted-foreground">
                  Balance {formatMoney(next.availableMinor, next.currency)} · reserve {formatMoney(next.reserveMinor, next.currency)}
                </p>
                {next.blockedReason && <p data-testid="upcoming-blocked">{BLOCKED_COPY[next.blockedReason]}</p>}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <section aria-label="Payout history" className="space-y-3">
        <h2 className="text-lg font-semibold">History</h2>
        {payouts.isError && items.length === 0 ? (
          <SectionError error={payouts.error} onRetry={() => void payouts.refetch()} />
        ) : payouts.isPending ? (
          <TableRowsSkeleton name="payouts" rows={4} />
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm" data-testid="payouts-empty">
            No payouts yet.
          </p>
        ) : (
          <>
            <ResponsiveTable caption="Payouts" captionHidden columns={columns} rows={items} rowKey={(payout) => payout.id} rowTestId="payout-row" />
            {payouts.isError && <SectionError error={payouts.error} onRetry={() => void payouts.fetchNextPage()} />}
            {payouts.hasNextPage && (
              <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={payouts.isFetchingNextPage} onClick={() => void payouts.fetchNextPage()}>
                Show more
              </Button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
