import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { requireSellerSession, sellerReturnTo } from '@/components/dashboard/shop-frame';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { SELLER_HOME } from '@/lib/seller/nav';
import type { RawSearchParams } from '@/lib/seller/search-params';
import { readMyShops } from '@/lib/server/seller.server';

type Props = { searchParams: Promise<RawSearchParams> };

/**
 * Where the S08 OAuth callback sends the browser (`/dashboard/integrations?connected=<id>` or `?error=<code>`): a member of
 * exactly one shop lands on that shop's integrations page with the same query, anyone else on the shop picker (S08 does not
 * know the shop; recorded in gaps.md). Only `connected` and `error` are carried over.
 */
async function IntegrationsRedirect({ searchParams }: Props): Promise<never> {
  const raw = await searchParams;
  await requireSellerSession('/dashboard/integrations', raw);
  const shops = await readMyShops();
  const [only, ...others] = shops.ok ? shops.data.items : [];
  if (!only || others.length > 0) redirect(SELLER_HOME);
  const carried: RawSearchParams = { connected: raw.connected, error: raw.error };
  redirect(sellerReturnTo(`/dashboard/seller/${encodeURIComponent(only.id)}/integrations`, carried));
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton filters={false} />}>
      <IntegrationsRedirect {...props} />
    </Suspense>
  );
}
