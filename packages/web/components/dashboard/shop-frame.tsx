import 'server-only';
import type { ReactNode } from 'react';
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ForbiddenPanel } from '@/components/seller/forbidden-panel';
import type { ShopListItem } from '@/lib/api/seller';
import { requireServerSession } from '@/lib/auth/session.server';
import { loginHref } from '@/lib/auth/return-to';
import { queryKeys } from '@/lib/query-keys';
import { pageRequires, shopCan, type ShopPage } from '@/lib/seller/permissions';
import { readMyShops, readShop } from '@/lib/server/seller.server';
import { DashboardShell } from './dashboard-shell';

type SearchParams = Record<string, string | string[] | undefined>;

/** `path?query` of a seller page, the `returnTo` of its guard (W04 AS-84). Repeated parameters stay repeated. */
export function sellerReturnTo(pathname: string, searchParams: SearchParams = {}): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(searchParams)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(name, item);
  }
  const text = query.toString();
  return text ? `${pathname}?${text}` : pathname;
}

/**
 * The guard every seller page calls first (W04 FR-001, AS-84): an anonymous visitor is redirected to
 * `/login?returnTo=<path and query>` before anything is read or sent. Convenience only; the API decides on every call.
 */
export function requireSellerSession(pathname: string, searchParams?: SearchParams) {
  return requireServerSession(sellerReturnTo(pathname, searchParams));
}

/**
 * Layout body of `/dashboard/seller/{shopId}/**` (W04 FR-001, FR-011): requires the session, resolves the shop on the server
 * and renders the shell around the page. A malformed, unknown or foreign shop is the not-found page (AS-85); any other
 * failure goes to the error boundary. The shop and the shop list are handed to the client's query cache. Render it inside
 * `<Suspense>` (the session read is a request-time read).
 */
export async function ShopFrame({ params, children }: { params: Promise<{ shopId: string }>; children: ReactNode }) {
  const { shopId } = await params;
  const root = `/dashboard/seller/${encodeURIComponent(shopId)}`;
  const seen = (await headers()).get('x-return-to');
  // The address the proxy saw, so a signed-out visit to a section or a query survives login (B-023); only this shop's own pages count.
  const returnTo = seen && (seen === root || seen.startsWith(`${root}/`) || seen.startsWith(`${root}?`)) ? seen : sellerReturnTo(root);
  await requireServerSession(returnTo);

  const [shopResult, shopsResult] = await Promise.all([readShop(shopId), readMyShops()]);
  if (!shopResult.ok) {
    if (shopResult.status === 401) redirect(loginHref(returnTo));
    if (shopResult.status === 403 || shopResult.status === 404) notFound();
    throw new Error('shop_unavailable');
  }
  const shop = shopResult.data;
  const own: ShopListItem = { id: shop.id, name: shop.name, slug: shop.slug, plan: shop.plan, status: shop.status, role: shop.myRole };
  const listed = shopsResult.ok ? shopsResult.data : { items: [own], nextCursor: null };
  const shops = listed.items.some((item) => item.id === shop.id) ? listed.items : [own, ...listed.items];

  const client = new QueryClient();
  client.setQueryData(queryKeys.seller.shop(shop.id), shop);
  if (shopsResult.ok) client.setQueryData(queryKeys.seller.shops(), shopsResult.data);

  return (
    <HydrationBoundary state={dehydrate(client)}>
      <DashboardShell shop={shop} shops={shops} nextCursor={listed.nextCursor}>
        {children}
      </DashboardShell>
    </HydrationBoundary>
  );
}

/** Content of a page when the member holds its permission, otherwise the panel of FR-011 (never the content). */
export function PageAccess({ shop, page, children }: { shop: { id: string; myRole?: string; myPermissions?: readonly string[] | null }; page: ShopPage; children: ReactNode }) {
  return shopCan(shop, pageRequires[page]) ? children : <ForbiddenPanel shopId={shop.id} role={shop.myRole} />;
}
