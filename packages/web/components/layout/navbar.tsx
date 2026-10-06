'use client';

import Link from 'next/link';
import { useTheme } from 'next-themes';
import {
  ShoppingBag,
  Search,
  Menu,
  Sun,
  Moon,
  ShoppingCart,
  User,
  LogOut,
  Package,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetHeader } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/use-auth';
import { NotificationsPopover } from '@/components/notifications-popover';

export function Navbar() {
  const { setTheme, theme } = useTheme();
  const { user, isAuthenticated, logout } = useAuth();

  const toggleAssistant = () => {
    window.dispatchEvent(new Event('toggle-assistant'));
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center justify-between px-4 md:px-6 mx-auto">
        <div className="flex items-center gap-4">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Toggle menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle className="sr-only">Menu</SheetTitle>
              </SheetHeader>
              <nav className="grid gap-6 text-lg font-medium mt-6">
                <Link href="/" className="flex items-center gap-2 text-lg font-semibold">
                  <ShoppingBag className="h-6 w-6" />
                  <span>Marketplace</span>
                </Link>
                <Link href="/search" className="hover:text-foreground">
                  Browse
                </Link>
                <Link href="/cart" className="hover:text-foreground">
                  Cart
                </Link>
              </nav>
            </SheetContent>
          </Sheet>
          <Link href="/" className="hidden md:flex items-center gap-2 font-bold text-xl">
            <ShoppingBag className="h-6 w-6" />
            <span>Marketplace</span>
          </Link>
        </div>

        <div className="flex-1 max-w-md hidden md:flex items-center mx-4">
          <Button
            variant="outline"
            className="w-full justify-start text-muted-foreground relative"
            onClick={() => {}}
          >
            <Search className="mr-2 h-4 w-4" />
            <span>Search products...</span>
            <kbd className="pointer-events-none absolute right-1.5 top-2.5 hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
              <span className="text-xs">⌘</span>K
            </kbd>
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="md:hidden">
            <Search className="h-5 w-5" />
            <span className="sr-only">Search</span>
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            <span className="sr-only">Toggle theme</span>
          </Button>

          <Button variant="ghost" size="icon" onClick={toggleAssistant} title="AI Assistant" aria-label="AI Assistant">
            <Sparkles className="h-5 w-5 text-indigo-500" />
            <span className="sr-only">AI Assistant</span>
          </Button>

          <Button variant="ghost" size="icon" className="relative" asChild>
            <Link href="/cart">
              <ShoppingCart className="h-5 w-5" />
              <Badge
                className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 rounded-full"
                variant="destructive"
              >
                0
              </Badge>
              <span className="sr-only">Cart</span>
            </Link>
          </Button>

          {isAuthenticated && (
            <NotificationsPopover />
          )}

          {isAuthenticated && user ? (
            // Users have no display name in the API: show the email local part.
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full ml-1">
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={user.avatarUrl} alt={displayName(user)} />
                    <AvatarFallback>{displayName(user).slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <div className="flex items-center justify-start gap-2 p-2">
                  <div className="flex flex-col space-y-1 leading-none">
                    <p className="font-medium">{displayName(user)}</p>
                    <p className="w-[200px] truncate text-sm text-muted-foreground">
                      {user.email}
                    </p>
                  </div>
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
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive cursor-pointer">
                  <LogOut className="mr-2 h-4 w-4" /> Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="hidden md:flex gap-2 ml-2">
              <Button variant="ghost" asChild>
                <Link href="/login">Log in</Link>
              </Button>
              <Button asChild>
                <Link href="/register">Sign up</Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function displayName(user: { name?: string | null; email?: string | null }): string {
  return user.name || user.email?.split('@')[0] || 'Account';
}
