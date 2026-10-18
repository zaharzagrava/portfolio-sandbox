import { Flag, type LucideIcon } from 'lucide-react';

/** The navigation registry of the admin console (W06 Provides): a later admin capability adds an entry here. */
export type AdminNavItem = { id: string; label: string; href: string; icon: LucideIcon };

export const adminNavItems: readonly AdminNavItem[] = [{ id: 'feature-flags', label: 'Feature flags', href: '/admin/feature-flags', icon: Flag }];

export const isCurrentAdminItem = (item: AdminNavItem, pathname: string | null): boolean =>
  pathname === item.href || (pathname?.startsWith(`${item.href}/`) ?? false);

/** The page name shown in the mobile top bar. */
export function adminPageName(pathname: string | null): string {
  const item = adminNavItems.find((entry) => isCurrentAdminItem(entry, pathname));
  return item?.label ?? 'Admin';
}
