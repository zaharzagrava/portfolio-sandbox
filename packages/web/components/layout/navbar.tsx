import { ShoppingBag } from 'lucide-react';
import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import { AccountSlot, AccountSlotSkeleton } from '@/components/auth/account-slot';
import { CartBadge } from '@/components/cart/cart-badge';
import { AssistantLauncher } from '@/components/chat/assistant-launcher';
import { MainNav } from '@/components/layout/main-nav';
import { MemberOnly } from '@/components/layout/member-only';
import { MobileMenu } from '@/components/layout/mobile-menu';
import { SearchRow } from '@/components/layout/search-row';
import { SlotBoundary } from '@/components/layout/slot-boundary';
import { ThemeControl } from '@/components/layout/theme-control';
import { NotificationsPopover } from '@/components/notifications-popover';
import { SearchBox } from '@/components/search/search-box';

/** A slot owned by another capability: a fixed-size fallback while it loads, nothing at all if it fails. */
function Slot({ fallback, children }: { fallback?: ReactNode; children: ReactNode }) {
  return (
    <SlotBoundary>
      <Suspense fallback={fallback ?? null}>{children}</Suspense>
    </SlotBoundary>
  );
}

const FixedBox = ({ className }: { className: string }) => <div aria-hidden="true" className={className} />;

/**
 * The header (Server Component; the stateful parts are client islands). At >= 1024 px: logo, "Main" navigation, search,
 * then assistant, theme, cart, bell (members) and account. Below that: menu button, logo, then search, theme, cart, bell.
 * Slots take no data from here, so a change inside one (a cart count) re-renders only that slot.
 */
export function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto flex h-14 items-center gap-1 px-4 md:px-6">
        <div className="lg:hidden">
          <MobileMenu />
        </div>
        <Link href="/" data-slot="logo" aria-label="Marketplace home" className="flex items-center gap-2 rounded-md text-xl font-bold">
          <ShoppingBag aria-hidden="true" className="h-6 w-6" />
          <span aria-hidden="true">Marketplace</span>
        </Link>
        <MainNav />
        <div className="mx-4 hidden max-w-md flex-1 lg:flex">
          <Slot fallback={<FixedBox className="h-9 w-full" />}>
            <SearchBox variant="navbar" />
          </Slot>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <div className="lg:hidden">
            <SearchRow />
          </div>
          <div className="hidden lg:block">
            <Slot fallback={<FixedBox className="size-9" />}>
              <AssistantLauncher variant="icon" />
            </Slot>
          </div>
          <ThemeControl />
          <Slot fallback={<FixedBox className="size-11 lg:size-9" />}>
            <CartBadge />
          </Slot>
          <MemberOnly>
            <Slot fallback={<FixedBox className="size-9" />}>
              <NotificationsPopover />
            </Slot>
          </MemberOnly>
          <div className="hidden lg:block">
            <Slot fallback={<AccountSlotSkeleton />}>
              <AccountSlot />
            </Slot>
          </div>
        </div>
      </div>
    </header>
  );
}
