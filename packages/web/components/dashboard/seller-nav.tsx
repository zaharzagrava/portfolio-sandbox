'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { ShopSwitcher } from '@/components/seller/shop-switcher';
import type { ShopListItem } from '@/lib/api/seller';
import { accountNavLinks, isCurrentItem, isCurrentPath, sellerNavItems, type SellerNavItem } from '@/lib/seller/nav';
import { shopCan } from '@/lib/seller/permissions';

export type SidebarShop = { id: string; name: string; myRole?: string; myPermissions?: readonly string[] | null };

const linkClass = (current: boolean) =>
  cn(
    'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-9',
    current ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground',
  );

const heading = 'px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground';

/** Entries the member's permissions allow (presentation only: the API decides on every call). */
export function visibleNavItems(shop: Pick<SidebarShop, 'myPermissions'>, group: SellerNavItem['group']): SellerNavItem[] {
  return sellerNavItems.filter((item) => item.group === group && (!item.requires || shopCan(shop, item.requires)));
}

/**
 * The content of the sidebar and of the drawer, the same in both (W04 AS-98): the shop switcher, the navigation named
 * "Seller" with the groups Shop and Developers, and the Account links. The current entry carries `aria-current="page"`.
 */
export function SellerSidebar({
  shop,
  shops,
  nextCursor,
  onNavigate,
}: {
  shop: SidebarShop;
  shops: readonly ShopListItem[];
  nextCursor?: string | null;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const groups: { id: SellerNavItem['group']; label: string }[] = [
    { id: 'shop', label: 'Shop' },
    { id: 'developers', label: 'Developers' },
  ];

  return (
    <div className="flex flex-col gap-2">
      <ShopSwitcher shops={shops} currentShopId={shop.id} nextCursor={nextCursor} onNavigate={onNavigate} />
      <nav aria-label="Seller" className="flex flex-col">
        {groups.map(({ id, label }) => {
          const items = visibleNavItems(shop, id);
          if (items.length === 0) return null;
          return (
            <section key={id} aria-labelledby={`seller-nav-${id}`}>
              <h2 id={`seller-nav-${id}`} className={heading}>
                {label}
              </h2>
              <ul className="flex flex-col gap-1">
                {items.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={item.href(shop.id)}
                      aria-current={isCurrentItem(item, pathname, shop.id) ? 'page' : undefined}
                      onClick={onNavigate}
                      className={linkClass(isCurrentItem(item, pathname, shop.id))}
                    >
                      <item.icon aria-hidden="true" className="size-4 shrink-0" />
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <section aria-labelledby="seller-nav-account">
          <h2 id="seller-nav-account" className={heading}>
            Account
          </h2>
          <ul className="flex flex-col gap-1">
            {accountNavLinks.map((link) => (
              <li key={link.id}>
                <Link href={link.href} aria-current={isCurrentPath(pathname, link.href) ? 'page' : undefined} onClick={onNavigate} className={linkClass(isCurrentPath(pathname, link.href))}>
                  <link.icon aria-hidden="true" className="size-4 shrink-0" />
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </nav>
    </div>
  );
}
