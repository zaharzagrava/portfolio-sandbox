'use client';

import { Wallet } from 'lucide-react';
import { SectionError } from '@/components/seller/problem-states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useShopBalance } from '@/lib/api/seller-finance';
import { formatInstant } from '@/lib/seller/format-date';
import { formatMoney } from '@/lib/utils';

/** What the shop can be paid out now (S14 `GET /shops/:shopId/balance`); `asOf` says how fresh the number is. */
export function BalanceCard({ shopId }: { shopId: string }) {
  const balance = useShopBalance(shopId);
  const data = balance.data;

  return (
    <Card data-testid="balance-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Available balance</CardTitle>
        <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent className="space-y-1">
        {balance.isError ? (
          <SectionError error={balance.error} onRetry={() => void balance.refetch()} />
        ) : (
          <>
            <div className="text-2xl font-bold tabular-nums" data-testid="balance-amount">
              {data ? formatMoney(data.availableMinor, data.currency) : '…'}
            </div>
            <CardDescription>{data ? `As of ${formatInstant(data.asOf).text}` : 'Loading'}</CardDescription>
          </>
        )}
      </CardContent>
    </Card>
  );
}
