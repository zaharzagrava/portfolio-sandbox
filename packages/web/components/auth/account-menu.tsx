'use client';

import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, Package, RefreshCw, ShieldCheck, User, UserRound } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AuthBootstrap, useAuth, useHydrated, type AuthStatus, type SessionUser } from '@/hooks/use-auth';
import { useLogout } from '@/hooks/use-auth-actions';
import { isAdmin } from '@/lib/admin/is-admin';
import { queryKeys } from '@/lib/query-keys';
import { AccountSlotSkeleton } from './account-skeleton';

const ROLE_LABEL: Record<SessionUser['role'], string> = {
  USER: 'Member',
  SELLER: 'Seller',
  MODERATOR: 'Moderator',
  ADMIN: 'Administrator',
};

/** Two letters from the e-mail local part ("jane.doe@x" -> "JA"). */
export function initialsOf(email: string): string {
  const letters = (email.split('@')[0] ?? '').replace(/[^\p{L}\p{N}]/gu, '');
  return (letters.slice(0, 2) || 'AC').toUpperCase();
}

/** Re-checks the session now (the unavailable state's way out; focus and reconnect do it on their own). */
function useRetrySession() {
  const queryClient = useQueryClient();
  return () => void queryClient.refetchQueries({ queryKey: queryKeys.auth.session() });
}

function RetryButton() {
  const retry = useRetrySession();
  return (
    <Button type="button" variant="ghost" size="icon-lg" aria-label="Sign-in status unavailable. Retry" onClick={retry}>
      <RefreshCw aria-hidden="true" />
    </Button>
  );
}

/** The signed-in account button and its menu. */
export function AccountMenu({ user }: { user: SessionUser }) {
  const logout = useLogout();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-lg" className="rounded-full text-xs font-semibold" aria-label="Account menu">
          <span aria-hidden="true">{initialsOf(user.email)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56 max-w-[min(20rem,calc(100vw-1rem))]">
        <div className="flex flex-col gap-1 p-2 leading-snug">
          <p className="text-sm font-medium break-all">{user.email}</p>
          <p className="text-xs text-muted-foreground">Role: {ROLE_LABEL[user.role] ?? user.role}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard">
            <User aria-hidden="true" /> Dashboard
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/dashboard/orders">
            <Package aria-hidden="true" /> Orders
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/security">
            <KeyRound aria-hidden="true" /> Account &amp; security
          </Link>
        </DropdownMenuItem>
        {isAdmin(user) && (
          <DropdownMenuItem asChild>
            <Link href="/admin">
              <ShieldCheck aria-hidden="true" /> Admin
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={logout.isPending} onSelect={() => logout.mutate()}>
          <LogOut aria-hidden="true" /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The client leaf of the desktop account slot. `initialUser` is what the server read (`undefined`: nothing was read, the
 * browser asks). After seeding it reads the shared session query, so sign-in/out in this or another tab, the role
 * refresh and the focus/reconnect re-check all show without a reload.
 */
export function AccountSlotClient({ initialUser }: { initialUser?: SessionUser | null }) {
  return (
    <>
      {initialUser !== undefined && <AuthBootstrap user={initialUser} />}
      <AccountArea initialUser={initialUser} />
    </>
  );
}

function AccountArea({ initialUser }: { initialUser?: SessionUser | null }) {
  const live = useAuth();
  const hydrated = useHydrated();
  // Until hydration is done the server's answer decides, so the first client render equals the server's markup even when
  // the browser's own session query answered first.
  const hinted = initialUser !== undefined && !hydrated;
  const user = hinted ? initialUser : live.user;
  const status: AuthStatus = hinted ? (initialUser ? 'authenticated' : 'anonymous') : live.status;
  if (status === 'loading') return <AccountSlotSkeleton />;
  if (status === 'unavailable') {
    // Never "anonymous"; a member who was already shown keeps the last known menu.
    return (
      <div className="flex items-center gap-1">
        {user && <AccountMenu user={user} />}
        <RetryButton />
      </div>
    );
  }
  if (!user) {
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
  return <AccountMenu user={user} />;
}

/** Header icon link for visitors below 1024 px, where the desktop slot is hidden (nothing for members or while unknown). */
export function MobileLoginLink({ initialAnonymous }: { initialAnonymous?: boolean } = {}) {
  const { status } = useAuth();
  // `initialAnonymous` is what the server read from the cookie (`MobileLoginSlot`): while the browser's session query has no
  // answer, it decides, so the server's markup and the first client render agree whether or not the server's cache had the session.
  const hydrated = useHydrated();
  const hinted = initialAnonymous !== undefined && (!hydrated || status === 'loading');
  const anonymous = hinted ? initialAnonymous : status === 'anonymous';
  if (!anonymous) return null;
  return (
    <Button asChild variant="ghost" size="icon-lg" className="size-11 lg:hidden">
      <Link href="/login" aria-label="Log in">
        <UserRound aria-hidden="true" className="h-5 w-5" />
      </Link>
    </Button>
  );
}

/** The account entries at the top of the mobile menu (visitors: Log in / Sign up; members: the "Account" group). */
export function MobileAccountEntries() {
  const { user, status } = useAuth();
  const logout = useLogout();
  const retry = useRetrySession();

  if (status === 'loading') return <div aria-busy="true" className="h-24 rounded-md bg-muted" />;

  if (!user) {
    if (status === 'unavailable') {
      return (
        <Button type="button" variant="outline" size="lg" className="min-h-11" onClick={retry}>
          <RefreshCw aria-hidden="true" /> Sign-in status unavailable. Retry
        </Button>
      );
    }
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
      <p className="px-2 text-sm break-all">{user.email}</p>
      <p className="px-2 text-xs text-muted-foreground">Role: {ROLE_LABEL[user.role] ?? user.role}</p>
      {status === 'unavailable' && (
        <button type="button" onClick={retry} className={`${link} text-left`}>
          <RefreshCw aria-hidden="true" className="h-4 w-4" /> Sign-in status unavailable. Retry
        </button>
      )}
      <Link href="/dashboard" className={link}>
        <User aria-hidden="true" className="h-4 w-4" /> Dashboard
      </Link>
      <Link href="/dashboard/orders" className={link}>
        <Package aria-hidden="true" className="h-4 w-4" /> Orders
      </Link>
      <Link href="/account/security" className={link}>
        <KeyRound aria-hidden="true" className="h-4 w-4" /> Account &amp; security
      </Link>
      {isAdmin(user) && (
        <Link href="/admin" className={link}>
          <ShieldCheck aria-hidden="true" className="h-4 w-4" /> Admin
        </Link>
      )}
      <button type="button" disabled={logout.isPending} onClick={() => logout.mutate()} className={`${link} text-left text-destructive`}>
        <LogOut aria-hidden="true" className="h-4 w-4" /> Log out
      </button>
    </div>
  );
}
