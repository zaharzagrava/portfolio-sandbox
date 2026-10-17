import { TriangleAlertIcon } from 'lucide-react';
import { shopWritable } from '@/lib/seller/permissions';

/**
 * The read-only banner of a suspended or closing shop (W04 AS-86, FR-012). It states the reason in words; the same text is
 * the description of every disabled write control (`useShopWritable(shop).reason`). Server-safe: no state.
 */
export function ShopStatusBanner({ shop }: { shop: { status: string } | null | undefined }) {
  const { writable, reason } = shopWritable(shop);
  if (writable || !reason) return null;
  return (
    <div
      role="status"
      aria-label="Shop status"
      className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>{reason}</p>
    </div>
  );
}
