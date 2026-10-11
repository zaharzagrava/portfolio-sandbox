'use client';

// Stand-in for the W01 contract: the owner replaces the body, never the name or props.

import Link from 'next/link';
import { KeyRound, LogOut, Package, ShieldCheck, User } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/hooks/use-auth';
import { isAdmin } from '@/lib/admin/is-admin';

/** Exactly the size of the signed-in account button, so the header does not move while the session is read. */
export function AccountSlotSkeleton() {
  return <div aria-hidden="true" data-slot="account-skeleton" className="size-9 rounded-full bg-muted" />;
}

// Users have no display name in the API: show the email local part.
function displayName(user: { name?: string | null; email?: string | null }): string {
  return user.name || user.email?.split('@')[0] || 'Account';
}

/** Desktop account control: Log in / Sign up for visitors, the account menu for members. */
export function AccountSlot() {
  const { user, isAuthenticated, isLoading, logout } = useAuth();

  if (isLoading) return <AccountSlotSkeleton />;

  if (!isAuthenticated || !user) {
    return (
      <div className="flex gap-2">
        <Button variant="ghost" asChild>
          <Link href="/login">Log in</Link>
        </Button>
        <Button asChild>
          <Link href="/register">Sign up</Link>
        </Button>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-lg" className="rounded-full" aria-label={`Account menu, ${displayName(user)}`}>
          <Avatar className="size-8">
            <AvatarImage src={user.avatarUrl} alt="" />
            <AvatarFallback>{displayName(user).slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <div className="flex flex-col gap-1 p-2 leading-none">
          <p className="font-medium">{displayName(user)}</p>
          <p className="w-[200px] truncate text-sm text-muted-foreground">{user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard">
            <User className="mr-2 h-4 w-4" /> Dashboard
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/dashboard/orders">
            <Package className="mr-2 h-4 w-4" /> Orders
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/security">
            <KeyRound className="mr-2 h-4 w-4" /> Account &amp; security
          </Link>
        </DropdownMenuItem>
        {isAdmin(user) && (
          <DropdownMenuItem asChild>
            <Link href="/admin">
              <ShieldCheck className="mr-2 h-4 w-4" /> Admin
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={logout} className="cursor-pointer text-destructive focus:text-destructive">
          <LogOut className="mr-2 h-4 w-4" /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The account entries at the top of the mobile menu (visitors: Log in / Sign up; members: the "Account" group). */
export function MobileAccountEntries() {
  const { user, isAuthenticated, isLoading, logout } = useAuth();

  if (isLoading) return <div aria-hidden="true" className="h-24 rounded-md bg-muted" />;

  if (!isAuthenticated || !user) {
    return (
      <div className="grid gap-2">
        <Button asChild size="lg" className="min-h-11">
          <Link href="/login">Log in</Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="min-h-11">
          <Link href="/register">Sign up</Link>
        </Button>
      </div>
    );
  }

  const link = 'flex min-h-11 items-center gap-2 rounded-md px-2 hover:bg-accent';
  return (
    <div role="group" aria-labelledby="mobile-account-heading" className="grid gap-1">
      <p id="mobile-account-heading" className="px-2 text-sm font-medium text-muted-foreground">
        Account
      </p>
      <p className="truncate px-2 text-sm">{user.email}</p>
      <Link href="/dashboard" className={link}>
        <User className="h-4 w-4" /> Dashboard
      </Link>
      <Link href="/dashboard/orders" className={link}>
        <Package className="h-4 w-4" /> Orders
      </Link>
      <Link href="/account/security" className={link}>
        <KeyRound className="h-4 w-4" /> Account &amp; security
      </Link>
      {isAdmin(user) && (
        <Link href="/admin" className={link}>
          <ShieldCheck className="h-4 w-4" /> Admin
        </Link>
      )}
      <button type="button" onClick={logout} className={`${link} text-left text-destructive`}>
        <LogOut className="h-4 w-4" /> Log out
      </button>
    </div>
  );
}
