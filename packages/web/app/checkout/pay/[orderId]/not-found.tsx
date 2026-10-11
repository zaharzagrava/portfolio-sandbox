import type { Metadata } from 'next';
import Link from 'next/link';
import { NotFoundState } from '@/components/layout/system-states';
import { Button } from '@/components/ui/button';
import { ordersHref } from '@/lib/routes';

export const metadata: Metadata = { title: 'Order not found' };

/** The same page for a malformed id, an unknown order and another member's order (W03 AS-35): never a 403 form. */
export default function PayNotFound() {
  return (
    <NotFoundState
      title="Order not found"
      description="We couldn't find that order. It may not exist, or it may belong to another account."
      actions={
        <Button asChild size="lg">
          <Link href={ordersHref()}>Your orders</Link>
        </Button>
      }
    />
  );
}
