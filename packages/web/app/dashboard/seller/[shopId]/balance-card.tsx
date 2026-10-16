'use client';

import { Wallet } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useShopBalance } from '@/lib/api/finance';
import { formatMoney } from '@/lib/utils';

/** What the shop can be paid out now (S14 `GET /shops/:shopId/balance`); the `asOf` time says how fresh it is. */
export function BalanceCard({ shopId }: { shopId: string }) {
  const balance = useShopBalance(shopId);
  const data = balance.data;

  return (
    <Card data-testid="balance-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Available balance</CardTitle>
        <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid="balance-amount">
          {data ? formatMoney(data.availableMinor, data.currency) : balance.isError ? '—' : '…'}
        </div>
        <CardDescription>
          {data ? `As of ${new Date(data.asOf).toLocaleString()}` : balance.isError ? 'The balance is not available right now.' : 'Loading'}
        </CardDescription>
      </CardContent>
    </Card>
  );
}
