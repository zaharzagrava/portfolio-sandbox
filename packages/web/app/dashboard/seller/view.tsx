'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Activity, DollarSign, ShoppingCart, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { apiErrorMessage } from '@/lib/api/errors';
import { SHOP_SLUG, slugify, useCreateShop, useMyShops, useSellerStats } from '@/lib/api/shops';
import { formatMoney } from '@/lib/utils';

/** Buyers open a shop here; that makes them a SELLER, and the page turns into the seller overview. */
function OpenShop() {
  const { refreshSession } = useAuth();
  const createShop = useCreateShop();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const effectiveSlug = slug || slugify(name);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    createShop.mutate(
      { name: name.trim(), slug: effectiveSlug },
      {
        onSuccess: async () => {
          await refreshSession(); // new token with the SELLER role
          toast.success('Your shop is open');
        },
        onError: (error) => toast.error(apiErrorMessage(error, 'Could not open the shop.')),
      },
    );
  };

  return (
    <Card className="max-w-lg">
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle>Open your shop</CardTitle>
          <CardDescription>Start selling on the marketplace. You become the shop&apos;s owner.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="shop-name">Shop name</Label>
            <Input id="shop-name" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={80} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="shop-slug">Handle</Label>
            <Input id="shop-slug" value={effectiveSlug} onChange={(e) => setSlug(e.target.value)} placeholder="my-shop" />
            {effectiveSlug && !SHOP_SLUG.test(effectiveSlug) && (
              <p className="text-xs text-destructive">3-40 lowercase letters, digits or dashes.</p>
            )}
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={createShop.isPending || name.trim().length < 2 || !SHOP_SLUG.test(effectiveSlug)}>
            {createShop.isPending ? 'Opening…' : 'Open shop'}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export function SellerOverviewView() {
  const { user } = useAuth();
  const isSeller = user?.role === 'SELLER';
  const shops = useMyShops();
  const stats = useSellerStats(isSeller);
  const shop = shops.data?.[0];

  if (shops.isLoading) return <div className="flex h-full items-center justify-center">Loading...</div>;

  if (!shop || !isSeller) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Seller Dashboard</h1>
        <OpenShop />
      </div>
    );
  }

  const summary = stats.data?.summary;
  const cards = [
    { title: 'Revenue (30d)', value: summary ? formatMoney(summary.revenueCents) : '…', icon: DollarSign },
    { title: 'Orders', value: summary?.orders ?? '…', icon: ShoppingCart },
    { title: 'Unique Buyers', value: summary?.uniqueBuyers ?? '…', icon: Users },
    { title: 'Units Sold', value: summary?.unitsSold ?? '…', icon: Activity },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="seller-shop-name">{shop.name}</h1>
          <p className="text-muted-foreground">
            @{shop.slug} · {shop.plan} plan · you are {shop.role}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/dashboard/seller/inventory">Inventory</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={`/dashboard/seller/${shop.id}/developers/api-keys`}>API keys</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={`/dashboard/seller/${shop.id}/developers/webhooks`}>Webhooks</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
              <card.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{card.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top products (30 days)</CardTitle>
          <CardDescription>From the ClickHouse sales rollup (SD-31); updates within seconds of a paid order.</CardDescription>
        </CardHeader>
        <CardContent>
          {stats.isError ? (
            <p className="text-sm text-destructive">Stats are unavailable right now.</p>
          ) : !stats.data?.topProducts.length ? (
            <p className="text-sm text-muted-foreground">No sales yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {stats.data.topProducts.map((p) => (
                <li key={p.productId} className="flex justify-between">
                  <Link href={`/products/${p.productId}`} className="hover:underline font-mono">
                    {p.productId.slice(0, 8)}
                  </Link>
                  <span>
                    {p.unitsSold} sold · {formatMoney(p.revenueCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
