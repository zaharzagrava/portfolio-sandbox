'use client';

import { OfflineBanner } from '@/components/seller/problem-states';
import { ShopStatusBanner } from '@/components/seller/shop-status-banner';
import { useShop } from '@/lib/api/seller';

/**
 * The banner region above the page body: the offline notice and the suspended / closing banner (W04 AS-86, AS-88). The shop
 * status comes from the shop query, so a refused write (`shop_suspended`) that refetches the shop brings the banner without a reload.
 */
export function Banners({ shop }: { shop: { id: string; status: string } }) {
  const current = useShop(shop.id).data ?? shop;
  return (
    <div className="flex flex-col gap-2 empty:hidden">
      <OfflineBanner />
      <ShopStatusBanner shop={current} />
    </div>
  );
}
