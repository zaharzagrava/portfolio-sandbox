'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OrdersTable } from '@/components/dashboard/orders-table';
import { useOrders } from '@/lib/api/orders';

export function OrdersView() {
  const { data: orders = [], isLoading, isError } = useOrders();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Orders</h1>
        <p className="text-muted-foreground">Track your orders; unpaid ones can still be cancelled.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Order History</CardTitle>
          <CardDescription>Newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : isError ? (
            <p className="text-sm text-destructive">Could not load your orders.</p>
          ) : (
            <OrdersTable orders={orders} allowCancel />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
