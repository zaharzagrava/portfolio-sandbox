'use client';

import Link from 'next/link';
import { MenuIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { adminPageName } from '@/lib/admin/nav';
import { AdminNav } from './admin-nav';

/**
 * The top bar of the mobile frame (W06 AS-59): "Open menu", the brand and the page name; the menu opens a drawer with
 * exactly the sidebar's content. It closes after choosing an entry, on Escape and when the address changes; focus returns to
 * "Open menu" (the sheet restores it to its trigger).
 */
export function AdminDrawer() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);
  if (open && openedAt !== pathname) setOpen(false);

  return (
    <div role="region" aria-label="Admin bar" className="flex items-center gap-2 border-b bg-background px-2 py-1 lg:hidden">
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
            <SheetTitle>Admin menu</SheetTitle>
            <SheetDescription className="sr-only">Pages of the admin console.</SheetDescription>
          </SheetHeader>
          <AdminNav onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <Link href="/admin" className="min-w-0 truncate text-sm font-semibold">
        Marketplace Admin
      </Link>
      <span className="min-w-0 truncate text-xs text-muted-foreground">{adminPageName(pathname)}</span>
    </div>
  );
}
