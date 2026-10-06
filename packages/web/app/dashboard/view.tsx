'use client';

import Link from 'next/link';
import { CheckCircle, Package, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OrdersTable } from '@/components/dashboard/orders-table';
import { useAuth } from '@/hooks/use-auth';
import { orderStats, useOrders } from '@/lib/api/orders';

export function DashboardOverviewView() {
  const { user } = useAuth();
  const { data: orders = [], isLoading } = useOrders();
  const stats = orderStats(orders);
  const cards = [
    { title: 'Total Orders', value: stats.total, icon: Package, description: 'All time' },
    { title: 'In Progress', value: stats.open, icon: Truck, description: 'Not delivered yet' },
    { title: 'Delivered', value: stats.delivered, icon: CheckCircle, description: 'Completed' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <p className="text-muted-foreground" data-testid="dashboard-account">
          Signed in as {user?.email} ({user?.role})
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {cards.map((card) => (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
              <card.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" data-testid={`stat-${card.title}`}>{isLoading ? '…' : card.value}</div>
              <p className="text-xs text-muted-foreground">{card.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Recent Orders</CardTitle>
            <CardDescription>Your latest purchases.</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard/orders">All orders</Link>
          </Button>
        </CardHeader>
        <CardContent>{isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : <OrdersTable orders={orders.slice(0, 5)} />}</CardContent>
      </Card>
    </div>
  );
}
