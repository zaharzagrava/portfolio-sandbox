import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { PageAccess, requireSellerSession } from '@/components/dashboard/shop-frame';
import { ListPageSkeleton } from '@/components/seller/page-skeletons';
import { TeamView } from '@/components/seller/team/team-view';
import { shopCan } from '@/lib/seller/permissions';
import { readTeamParams, type RawSearchParams } from '@/lib/seller/search-params';
import { readInvites, readMembers, readShop } from '@/lib/server/seller.server';

export const metadata: Metadata = { title: 'Team' };

type Props = { params: Promise<{ shopId: string }>; searchParams: Promise<RawSearchParams> };

/**
 * The team of a shop (W04 US7, AS-74): session first with the full address as `returnTo` (AS-84); `members.read` decides
 * between the page and the forbidden panel, and the Invitations tab needs `members.manage`. The list of the tab in the
 * address seeds the client query; a failed first read is shown by the view with "Try again".
 */
async function TeamPage({ params, searchParams }: Props) {
  const [{ shopId }, raw] = await Promise.all([params, searchParams]);
  await requireSellerSession(`/dashboard/seller/${encodeURIComponent(shopId)}/team`, raw);
  const shop = await readShop(shopId);
  if (!shop.ok) notFound();
  if (!shopCan(shop.data, 'members.read')) return <PageAccess shop={shop.data} page="team">{null}</PageAccess>;

  const serverParams = readTeamParams(raw);
  if (serverParams.tab === 'invitations' && !shopCan(shop.data, 'members.manage')) return <PageAccess shop={shop.data} page="team-invitations">{null}</PageAccess>;

  const [members, invites] = await Promise.all([
    serverParams.tab === 'members' ? readMembers(shopId, { cursor: serverParams.cursor }) : null,
    serverParams.tab === 'invitations' ? readInvites(shopId, { status: serverParams.status, cursor: serverParams.cursor }) : null,
  ]);
  return (
    <TeamView
      shopId={shopId}
      serverParams={serverParams}
      initialMembers={members?.ok ? members.data : undefined}
      initialInvites={invites?.ok ? invites.data : undefined}
    />
  );
}

export default function Page(props: Props) {
  return (
    <Suspense fallback={<ListPageSkeleton />}>
      <TeamPage {...props} />
    </Suspense>
  );
}
