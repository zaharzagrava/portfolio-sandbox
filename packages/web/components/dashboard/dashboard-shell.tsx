'use client';

import { useAuth } from '@/hooks/use-auth';
import { useRouter, usePathname, useParams } from 'next/navigation';
import { useEffect } from 'react';
import Link from 'next/link';
import { LayoutDashboard, ShoppingBag, Settings, Package, BarChart3, LogOut, Key, Webhook, BookOpen } from 'lucide-react';
import { useMyShops } from '@/lib/api/shops';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const navItems = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/orders', label: 'Orders', icon: ShoppingBag },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

const sellerNavItems = [
  { href: '/dashboard/seller', label: 'Seller Analytics', icon: BarChart3 },
  { href: '/dashboard/seller/inventory', label: 'Inventory', icon: Package },
];

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const { user, isLoading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const { data: shops } = useMyShops(user?.role === 'SELLER');
  const shopId = (params?.shopId as string) || shops?.[0]?.id;

  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login');
    }
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  const isSeller = user.role === 'SELLER';

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="w-full md:w-64 border-r bg-muted/40 p-6 flex flex-col gap-6">
        <div className="font-semibold text-lg">My Dashboard</div>
        <nav className="flex flex-col gap-2 flex-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover:bg-accent",
                pathname === item.href ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
          
          {!isSeller && (
            <Link
              href="/dashboard/seller"
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover:bg-accent",
                pathname === '/dashboard/seller' ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground"
              )}
            >
              <Package className="h-4 w-4" />
              Start selling
            </Link>
          )}

          {isSeller && (
            <>
              <div className="mt-4 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Seller Tools
              </div>
              {sellerNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover:bg-accent",
                    pathname === item.href ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground"
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              ))}

              {shopId && (<>
              <div className="mt-4 mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Developer Settings
              </div>
              <Link
                href={`/dashboard/seller/${shopId}/developers/api-keys`}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover:bg-accent",
                  pathname.includes('/developers/api-keys') ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground"
                )}
              >
                <Key className="h-4 w-4" />
                API Keys
              </Link>
              <Link
                href={`/dashboard/seller/${shopId}/developers/webhooks`}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover:bg-accent",
                  pathname.includes('/developers/webhooks') ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground"
                )}
              >
                <Webhook className="h-4 w-4" />
                Webhooks
              </Link>
              </>)}
              <Link
                href="/developers/docs"
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover:bg-accent",
                  pathname === '/developers/docs' ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground"
                )}
              >
                <BookOpen className="h-4 w-4" />
                API Documentation
              </Link>
            </>
          )}
        </nav>
        
        <div className="mt-auto">
          <Button variant="ghost" className="w-full justify-start gap-3" onClick={() => logout()}>
            <LogOut className="h-4 w-4" />
            Logout
          </Button>
        </div>
      </aside>
      
      <main className="flex-1 p-6 md:p-8">
        {children}
      </main>
    </div>
  );
}
