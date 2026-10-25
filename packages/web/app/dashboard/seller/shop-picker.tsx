import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { ShopListItem } from '@/lib/api/seller';
import { roleLabel, SELLER_HOME } from '@/lib/seller/nav';

const STATUS_LABEL: Record<string, string> = { SUSPENDED: 'Suspended', DELETING: 'Closing', DELETED: 'Closed' };

/**
 * The list of the member's shops (W04 AS-09, FR-016): name, handle, role and a badge when the shop is not active. Choosing
 * one opens its overview. More shops than one page are reached with `cursor` ("Next page"). Server-safe: no state.
 */
export function ShopPicker({ shops, nextCursor, cursor }: { shops: readonly ShopListItem[]; nextCursor: string | null; cursor?: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">Your shops</h1>
      <p className="text-muted-foreground">Choose a shop to open its dashboard.</p>
      {shops.length === 0 && <p className="text-sm text-muted-foreground">There are no more shops on this page.</p>}
      <Card className={shops.length === 0 ? 'hidden' : 'p-0'}>
        <ul aria-label="Your shops" className="divide-y">
          {shops.map((shop) => (
            <li key={shop.id}>
              <Link
                href={`/dashboard/seller/${encodeURIComponent(shop.id)}`}
                className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-muted focus-visible:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{shop.name}</span>
                  <span className="block truncate text-sm text-muted-foreground">@{shop.slug}</span>
                </span>
                <span className="flex items-center gap-1">
                  <Badge variant="secondary">{roleLabel(shop.role)}</Badge>
                  {shop.status !== 'ACTIVE' && <Badge variant="outline">{STATUS_LABEL[shop.status] ?? shop.status}</Badge>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
      <nav aria-label="Pages" className="flex gap-4 text-sm">
        {cursor && (
          <Link href={SELLER_HOME} className="text-primary underline-offset-4 hover:underline">
            First page
          </Link>
        )}
        {nextCursor && (
          <Link href={`${SELLER_HOME}?cursor=${encodeURIComponent(nextCursor)}`} className="text-primary underline-offset-4 hover:underline">
            Next page
          </Link>
        )}
      </nav>
    </div>
  );
}
