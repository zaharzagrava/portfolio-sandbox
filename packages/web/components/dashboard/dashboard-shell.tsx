import type { ReactNode } from 'react';
import type { ShopListItem } from '@/lib/api/seller';
import { Banners } from './banners';
import { MobileDrawer } from './mobile-drawer';
import { PendingContent } from './navigation-pending';
import { SellerSidebar, type SidebarShop } from './seller-nav';

/**
 * The frame of every `/dashboard/seller/{shopId}/**` page (W04 FR-011, AS-98): a persistent sidebar from 1024 px, a top bar
 * with a drawer below. A Server Component: it holds no session, reads no role claim and has no client guard; the layout
 * has already required the session and resolved the shop, and the entries follow the shop's `myPermissions` (see
 * `seller-nav.tsx`). The banner region sits above the page body (offline, suspended, closing).
 */
export function DashboardShell({
  shop,
  shops,
  nextCursor,
  children,
}: {
  shop: SidebarShop & { status: string };
  shops: readonly ShopListItem[];
  nextCursor?: string | null;
  children: ReactNode;
}) {
  const sidebarShop = { id: shop.id, name: shop.name, myRole: shop.myRole, myPermissions: shop.myPermissions };
  return (
    <div className="flex min-h-[calc(100svh-3.5rem)] flex-col lg:flex-row">
      <aside className="hidden w-64 shrink-0 border-r bg-muted/40 p-4 lg:block">
        <SellerSidebar shop={sidebarShop} shops={shops} nextCursor={nextCursor} />
      </aside>
      <MobileDrawer shop={sidebarShop} shops={shops} nextCursor={nextCursor} />
      <div className="min-w-0 flex-1 space-y-4 p-4 [overflow-wrap:anywhere] md:p-6 lg:p-8">
        <Banners shop={shop} />
        <PendingContent>{children}</PendingContent>
      </div>
    </div>
  );
}
