import { BarChart3, BookOpen, Download, FileText, Upload, Wallet,Key, Layers, LayoutDashboard, LibraryBig, Megaphone, Package, Plug, Puzzle, ScrollText, ShoppingBag, UserRound, Users, Webhook, type LucideIcon } from 'lucide-react';
import { pageRequires, type ShopPermission } from './permissions';

/**
 * The entries of the seller sidebar and drawer (W04 FR-011, AS-54, AS-98). One registry: the shell reads it and filters by
 * `requires` with `shopCan`; the entry shows only when the member's `myPermissions` allows it (presentation only, the API
 * decides). Never keyed on the session's role claim.
 */
export type SellerNavItem = {
  id: string;
  group: 'shop' | 'developers';
  label: string;
  href: (shopId: string) => string;
  icon: LucideIcon;
  requires?: ShopPermission;
};

const shopHref = (shopId: string, section = '') => `/dashboard/seller/${encodeURIComponent(shopId)}${section}`;

export const sellerNavItems: SellerNavItem[] = [
  { id: 'overview', group: 'shop', label: 'Overview', href: (id) => shopHref(id), icon: LayoutDashboard, requires: pageRequires.overview },
  { id: 'inventory', group: 'shop', label: 'Inventory', href: (id) => shopHref(id, '/inventory'), icon: Package, requires: pageRequires.inventory },
  { id: 'orders', group: 'shop', label: 'Orders', href: (id) => shopHref(id, '/orders'), icon: ShoppingBag, requires: pageRequires.orders },
  { id: 'team', group: 'shop', label: 'Team', href: (id) => shopHref(id, '/team'), icon: Users, requires: pageRequires.team },
  { id: 'payouts', group: 'shop', label: 'Payouts', href: (id) => shopHref(id, '/payouts'), icon: Wallet, requires: pageRequires.payouts },
  { id: 'statements', group: 'shop', label: 'Statements', href: (id) => shopHref(id, '/statements'), icon: FileText, requires: pageRequires.statements },
  { id: 'imports', group: 'shop', label: 'Import', href: (id) => shopHref(id, '/imports'), icon: Upload, requires: pageRequires.imports },
  { id: 'exports', group: 'shop', label: 'Order export', href: (id) => shopHref(id, '/exports'), icon: Download, requires: pageRequires.exports },
  { id: 'integrations', group: 'shop', label: 'Integrations', href: (id) => shopHref(id, '/integrations'), icon: Plug, requires: pageRequires.integrations },
  { id: 'campaigns', group: 'shop', label: 'Campaigns', href: (id) => shopHref(id, '/campaigns'), icon: Megaphone, requires: pageRequires.campaigns },
  { id: 'widget', group: 'shop', label: 'Storefront widget', href: (id) => shopHref(id, '/widget'), icon: Puzzle, requires: pageRequires.widget },
  { id: 'knowledge', group: 'shop', label: 'Help documents', href: (id) => shopHref(id, '/knowledge'), icon: LibraryBig, requires: pageRequires.knowledge },
  { id: 'api-keys', group: 'developers', label: 'API keys', href: (id) => shopHref(id, '/developers/api-keys'), icon: Key, requires: pageRequires['api-keys'] },
  { id: 'webhooks', group: 'developers', label: 'Webhooks', href: (id) => shopHref(id, '/developers/webhooks'), icon: Webhook, requires: pageRequires.webhooks },
  { id: 'api-version', group: 'developers', label: 'API version', href: (id) => shopHref(id, '/developers/api-version'), icon: Layers, requires: pageRequires['api-version'] },
  { id: 'logs', group: 'developers', label: 'Request logs', href: (id) => shopHref(id, '/developers/logs'), icon: ScrollText, requires: pageRequires.logs },
  { id: 'usage', group: 'developers', label: 'Usage', href: (id) => shopHref(id, '/developers/usage'), icon: BarChart3, requires: pageRequires.usage },
  { id: 'api-docs', group: 'developers', label: 'API documentation', href: () => '/developers/docs', icon: BookOpen },
];

/** The "Account" links: independent of the shop. */
export const accountNavLinks: { id: string; label: string; href: string; icon: LucideIcon }[] = [
  { id: 'my-orders', label: 'Your orders', href: '/orders', icon: ShoppingBag },
  { id: 'account-security', label: 'Account security', href: '/account/security', icon: UserRound },
];

export const SELLER_HOME = '/dashboard/seller';

const ROLE_LABEL: Record<string, string> = { OWNER: 'Owner', ADMIN: 'Admin', STAFF: 'Staff', VIEWER: 'Viewer' };

/** A member's role in words (sentence case). */
export const roleLabel = (role: string): string => ROLE_LABEL[role] ?? role.charAt(0) + role.slice(1).toLowerCase();

/** Whether `pathname` is at `href` or below it. The overview (`/dashboard/seller/{id}`) matches exactly only. */
export function isCurrentPath(pathname: string | null | undefined, href: string, exact = false): boolean {
  if (!pathname) return false;
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return exact ? path === href : path === href || path.startsWith(`${href}/`);
}

export function isCurrentItem(item: SellerNavItem, pathname: string | null | undefined, shopId: string): boolean {
  return isCurrentPath(pathname, item.href(shopId), item.id === 'overview');
}

/** The part of the address after `/dashboard/seller/{shopId}` (`/inventory`, `/developers/webhooks`), or `''`. */
export function sectionOf(pathname: string | null | undefined, shopId: string): string {
  const base = shopHref(shopId);
  if (!pathname || !isCurrentPath(pathname, base)) return '';
  const rest = pathname.slice(base.length);
  return rest === '/' ? '' : rest;
}

/**
 * Where the shop switcher goes: the same section of the other shop. A detail page (`/developers/webhooks/{endpointId}`)
 * would not exist in the other shop, so only the section itself stays.
 */
export function switchShopHref(pathname: string | null | undefined, fromShopId: string, toShopId: string): string {
  const segments = sectionOf(pathname, fromShopId).split('/').filter(Boolean);
  const kept = segments[0] === 'developers' ? segments.slice(0, 2) : segments.slice(0, 1);
  return shopHref(toShopId, kept.length ? `/${kept.join('/')}` : '');
}

/** Where the legacy `/dashboard/seller/inventory` goes: the one shop's inventory, otherwise the picker (AS-08, AS-09). */
export function legacyInventoryTarget(shops: readonly { id: string }[]): string {
  const [only, ...others] = shops;
  return only && others.length === 0 ? shopHref(only.id, '/inventory') : SELLER_HOME;
}

/** The label of the page the member is on, for the mobile top bar. */
export function currentPageLabel(pathname: string | null | undefined, shopId: string): string {
  return sellerNavItems.find((item) => item.id !== 'api-docs' && isCurrentItem(item, pathname, shopId))?.label ?? 'Overview';
}
