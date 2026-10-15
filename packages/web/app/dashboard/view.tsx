'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { ordersHref } from '@/lib/routes';

/** The buyer's orders live at `/orders` (W03 AS-60); the dashboard keeps the account line and a way there. */
export function DashboardOverviewView() {
  const { user } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <p className="text-muted-foreground">
          Signed in as {user?.email} ({user?.role})
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your orders</CardTitle>
          <CardDescription>Follow, pay for or cancel your purchases.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" asChild>
            <Link href={ordersHref()}>View orders</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
