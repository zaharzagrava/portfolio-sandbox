import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { requireSellerSession } from '@/components/dashboard/shop-frame';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { legacyInventoryTarget, SELLER_HOME } from '@/lib/seller/nav';
import { readMyShops } from '@/lib/server/seller.server';

/**
 * The legacy address of the inventory: a member of exactly one shop lands on that shop's inventory, anyone else on the shop
 * picker (W04 FR-013, AS-08). The session is required first; the redirect is a value of the member's shop list.
 */
async function LegacyInventoryRedirect(): Promise<never> {
  await requireSellerSession('/dashboard/seller/inventory');
  const shops = await readMyShops();
  redirect(shops.ok ? legacyInventoryTarget(shops.data.items) : SELLER_HOME);
}

export default function Page() {
  return (
    <Suspense fallback={<ListPageSkeleton />}>
      <LegacyInventoryRedirect />
    </Suspense>
  );
}
