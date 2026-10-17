import type { Metadata } from 'next';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { requireSellerSession } from '@/components/dashboard/shop-frame';
import { Skeleton } from '@/components/ui/skeleton';
import { loginHref } from '@/lib/auth/return-to';
import { readCursor, type RawSearchParams } from '@/lib/seller/search-params';
import { SELLER_HOME } from '@/lib/seller/nav';
import { readMyShops } from '@/lib/server/seller.server';
import { OpenShopForm } from './open-shop-form';
import { ShopPicker } from './shop-picker';
import { StartSellingNav } from './start-selling-nav';

export const metadata: Metadata = { title: 'Your shops', robots: { index: false, follow: false } };

/**
 * `/dashboard/seller` (W04 FR-016, AS-01, AS-08, AS-09): no shop shows the open-shop form, exactly one redirects on the
 * server to its overview, several show the picker. Being a seller means being a member of a shop, never the session's role
 * claim. The session is required first, with the full address as `returnTo`.
 */
async function SellerIndex({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const raw = await searchParams;
  await requireSellerSession(SELLER_HOME, raw);
  const cursor = readCursor(raw.cursor);
  const result = await readMyShops(cursor);
  if (!result.ok) {
    if (result.status === 401) redirect(loginHref(SELLER_HOME));
    throw new Error('shops_unavailable');
  }
  const { items, nextCursor } = result.data;
  if (items.length === 0 && !cursor)
    return (
      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="shrink-0 lg:w-56">
          <StartSellingNav />
        </aside>
        <div className="min-w-0 flex-1">
          <OpenShopForm />
        </div>
      </div>
    );
  if (items.length === 1 && !cursor && !nextCursor) redirect(`${SELLER_HOME}/${encodeURIComponent(items[0]!.id)}`);
  return <ShopPicker shops={items} nextCursor={nextCursor} cursor={cursor} />;
}

export default function Page({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  return (
    <div className="mx-auto w-full max-w-3xl p-4 md:p-8">
      <Suspense fallback={<Skeleton aria-hidden="true" className="h-64 w-full max-w-lg rounded-xl" />}>
        <SellerIndex searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
