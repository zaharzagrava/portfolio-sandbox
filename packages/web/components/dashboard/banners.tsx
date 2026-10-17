import { OfflineBanner } from '@/components/seller/problem-states';
import { ShopStatusBanner } from '@/components/seller/shop-status-banner';

/** The banner region above the page body: the offline notice and the suspended / closing banner (W04 AS-86, AS-88). */
export function Banners({ shop }: { shop: { status: string } }) {
  return (
    <div className="flex flex-col gap-2 empty:hidden">
      <OfflineBanner />
      <ShopStatusBanner shop={shop} />
    </div>
  );
}
