'use client';

import { MenuIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import type { ShopListItem } from '@/lib/api/seller';
import { currentPageLabel } from '@/lib/seller/nav';
import { SellerSidebar, type SidebarShop } from './seller-nav';

/**
 * The top bar of the mobile frame (W04 AS-98): "Open menu", the shop name and the page name; the menu opens a drawer with
 * exactly the sidebar's content. It closes after choosing an entry, on Escape and when the address changes, and focus
 * returns to "Open menu" (the sheet restores it to its trigger).
 */
export function MobileDrawer({ shop, shops, nextCursor }: { shop: SidebarShop; shops: readonly ShopListItem[]; nextCursor?: string | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);

  if (open && openedAt !== pathname) setOpen(false);

  return (
    <div role="region" aria-label="Shop bar" className="flex items-center gap-2 border-b bg-background px-2 py-1 lg:hidden">
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (next) setOpenedAt(pathname);
          setOpen(next);
        }}
      >
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon-lg" className="size-11" aria-label="Open menu">
            <MenuIcon aria-hidden="true" className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-80 max-w-[85vw] overflow-y-auto p-4">
          <SheetHeader className="p-0 pb-2">
            <SheetTitle>Seller menu</SheetTitle>
            <SheetDescription className="sr-only">Pages of this shop, developer tools and your account.</SheetDescription>
          </SheetHeader>
          <SellerSidebar shop={shop} shops={shops} nextCursor={nextCursor} onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-sm font-semibold">{shop.name}</p>
        <p className="truncate text-xs text-muted-foreground">{currentPageLabel(pathname, shop.id)}</p>
      </div>
    </div>
  );
}
