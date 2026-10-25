import Link from 'next/link';
import { StateMessage } from '@/components/layout/system-states';
import { Button } from '@/components/ui/button';

/**
 * The one answer for a product that does not exist or belongs to another shop (or whose id is no uuid): the same words in
 * every case, so it reveals nothing about which products exist. A 404 cannot succeed on retry, so there is no "Try again".
 */
export function ProductNotFound({ shopId }: { shopId: string }) {
  return (
    <StateMessage
      title="We couldn't find that product."
      description="Check the address, or choose a product from your inventory."
      actions={
        <Button asChild size="lg">
          <Link href={`/dashboard/seller/${encodeURIComponent(shopId)}/inventory`}>Back to inventory</Link>
        </Button>
      }
    />
  );
}
