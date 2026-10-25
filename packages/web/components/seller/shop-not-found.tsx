import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { StateMessage } from '@/components/layout/system-states';
import { SELLER_HOME } from '@/lib/seller/nav';

/**
 * The one answer for a shop that is unknown, malformed or someone else's (W04 AS-85, FR-011): identical in all three cases,
 * so it reveals nothing about which shops exist. The visited address is never shown.
 */
export function ShopNotFound() {
  return (
    <>
      {/* React puts this in the document head; the layout's own title (Overview, Seller dashboard) would otherwise stay (B-065). */}
      <title>Shop not found · Marketplace</title>
      <StateMessage
      title="We couldn't find that shop."
      description="Check the address, or choose one of your shops."
      actions={
        <Button asChild size="lg">
          <Link href={SELLER_HOME}>Your shops</Link>
        </Button>
      }
      />
    </>
  );
}
