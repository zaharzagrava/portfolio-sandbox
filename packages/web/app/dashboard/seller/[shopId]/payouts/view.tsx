'use client';

import { useParams } from 'next/navigation';
import { format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useShopPayouts, useUpcomingPayout, type PayoutView, type UpcomingPayoutView } from '@/lib/api/finance';
import { formatMoney } from '@/lib/utils';

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

export function PayoutsView() {
  const { shopId } = useParams<{ shopId: string }>();
  const payouts = useShopPayouts(shopId);
  const upcoming = useUpcomingPayout(shopId);
  const next = upcoming.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Payouts</h1>
        <p className="text-muted-foreground">Transfers of your balance to your payout destination.</p>
      </div>

      <Card data-testid="upcoming-payout">
        <CardHeader>
          <CardTitle>Next payout</CardTitle>
          <CardDescription>{next ? `Next run ${format(new Date(next.nextRunAt), 'PPP')}` : upcoming.isError ? 'Not available right now.' : 'Loading'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {next && (
            <>
              <p className="text-2xl font-bold" data-testid="upcoming-estimate">{formatMoney(next.estimatedPayoutMinor, next.currency)}</p>
              <p className="text-muted-foreground">
                Balance {formatMoney(next.availableMinor, next.currency)} · reserve {formatMoney(next.reserveMinor, next.currency)}
              </p>
              {next.blockedReason && <p data-testid="upcoming-blocked">{BLOCKED_COPY[next.blockedReason]}</p>}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          {payouts.isError ? (
            <p className="text-sm text-destructive">Payouts are unavailable right now.</p>
          ) : payouts.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !payouts.data?.items.length ? (
            <p className="text-sm text-muted-foreground" data-testid="payouts-empty">No payouts yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Week of</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Paid</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payouts.data.items.map((payout) => (
                  <TableRow key={payout.id} data-testid="payout-row">
                    <TableCell>{payout.periodStart}</TableCell>
                    <TableCell>{formatMoney(payout.amountMinor, payout.currency)}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(payout.status)}>{STATUS_LABEL[payout.status]}</Badge>
                    </TableCell>
                    <TableCell>{payout.paidAt ? format(new Date(payout.paidAt), 'PPP') : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {payouts.data?.nextCursor && <p className="mt-2 text-xs text-muted-foreground">Showing the latest payouts.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
