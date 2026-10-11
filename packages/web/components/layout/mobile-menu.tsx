'use client';

import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { MobileAccountEntries, MobileLoginLink } from '@/components/auth/account-menu';
import { AssistantLauncher } from '@/components/chat/assistant-launcher';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/use-auth';
import { cartTotals, useCart } from '@/lib/api/cart';

const item = 'flex min-h-11 w-full items-center gap-2 rounded-md px-2 hover:bg-accent';

/** Cart entry with its count; the count is shown only once known and above zero. */
function CartEntry({ onNavigate }: { onNavigate: () => void }) {
  const { data } = useCart();
  const count = data ? cartTotals(data).itemCount : 0;
  return (
    <Link href="/cart" className={item} onClick={onNavigate}>
      Cart{count > 0 ? ` (${count})` : ''}
    </Link>
  );
}

/** Mobile navigation sheet: account entries first, then the "Main" navigation. Closes on navigation by any means. */
export function MobileMenu() {
  const pathname = usePathname();
  const { isAuthenticated } = useAuth();
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);

  // The route changed while open (a link, or Back): close.
  if (open && openedAt !== pathname) setOpen(false);

  const close = () => setOpen(false);

  return (
    <>
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) setOpenedAt(pathname);
        setOpen(next);
      }}
    >
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-lg" className="size-11 lg:hidden" aria-label="Open menu">
          <Menu aria-hidden="true" className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
          <SheetDescription className="sr-only">Account and site navigation</SheetDescription>
        </SheetHeader>
        <div className="grid gap-6 overflow-y-auto px-4 pb-6">
          <MobileAccountEntries />
          <nav aria-label="Main">
            <ul className="grid gap-1 text-base font-medium">
              <li>
                <Link href="/search" className={item} onClick={close}>
                  Browse
                </Link>
              </li>
              <li>
                <CartEntry onNavigate={close} />
              </li>
              {isAuthenticated && (
                <li>
                  <Link href="/chat" className={item} onClick={close}>
                    Chats
                  </Link>
                </li>
              )}
              <li>
                <Link href="/developers/docs" className={item} onClick={close}>
                  Developers
                </Link>
              </li>
              <li onClick={close}>
                <AssistantLauncher variant="menu-item" />
              </li>
            </ul>
          </nav>
        </div>
      </SheetContent>
    </Sheet>
    <MobileLoginLink />
    </>
  );
}
