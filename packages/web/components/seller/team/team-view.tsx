'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { useShop } from '@/lib/api/seller';
import type { InvitePage, MemberPage } from '@/lib/api/seller-team';
import { shopCan } from '@/lib/seller/permissions';
import { buildQuery, readTeamParams, type TeamParams } from '@/lib/seller/search-params';
import { InvitesPanel } from './invites-table';
import { MembersPanel } from './members-table';
import { RolesMatrix } from './roles-matrix';

const sameParams = (a: TeamParams, b: TeamParams) => a.tab === b.tab && a.status === b.status && a.cursor === b.cursor;

/**
 * The team page of a shop (W04 US7, FR-040): Members, Invitations (members.manage) and Roles in one page, the tab, the
 * invitation status and the cursor in the URL. The server page seeds the first list for the address it read.
 */
export function TeamView({
  shopId,
  serverParams,
  initialMembers,
  initialInvites,
}: {
  shopId: string;
  serverParams: TeamParams;
  initialMembers?: MemberPage;
  initialInvites?: InvitePage;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? `/dashboard/seller/${shopId}/team`;
  const raw = readTeamParams(Object.fromEntries(useSearchParams().entries()));
  const shop = useShop(shopId).data;
  const { user } = useAuth();
  if (!shop) return <Skeleton aria-hidden="true" className="h-64 w-full" />;

  const canInvite = shopCan(shop, 'members.manage');
  // Without members.manage the invitations are not offered (the server page shows the forbidden panel for that address).
  const params: TeamParams = raw.tab === 'invitations' && !canInvite ? { ...raw, tab: 'members' } : raw;
  const seeded = sameParams(params, serverParams);

  const hrefFor = (next: Partial<TeamParams>) => {
    const merged = { ...params, cursor: undefined, ...next };
    const query = buildQuery({ tab: merged.tab, status: merged.tab === 'invitations' ? merged.status : undefined, cursor: merged.cursor }, { tab: 'members', status: 'pending' });
    return query ? `${pathname}?${query}` : pathname;
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">The people who work on {shop.name}.</p>
      </div>

      <Tabs value={params.tab} onValueChange={(tab) => router.push(hrefFor({ tab: tab as TeamParams['tab'] }))}>
        <TabsList variant="line" aria-label="Team sections">
          <TabsTrigger value="members" className="min-h-11 sm:min-h-7">
            Members
          </TabsTrigger>
          {canInvite && (
            <TabsTrigger value="invitations" className="min-h-11 sm:min-h-7">
              Invitations
            </TabsTrigger>
          )}
          <TabsTrigger value="roles" className="min-h-11 sm:min-h-7">
            Roles
          </TabsTrigger>
        </TabsList>
        <TabsContent value="members">
          <MembersPanel
            shopId={shopId}
            shop={shop}
            selfId={user?.id}
            cursor={params.tab === 'members' ? params.cursor : undefined}
            initialData={seeded && params.tab === 'members' ? initialMembers : undefined}
            pageHref={(cursor) => hrefFor({ tab: 'members', cursor })}
          />
        </TabsContent>
        {canInvite && (
          <TabsContent value="invitations">
            <InvitesPanel
              shopId={shopId}
              shop={shop}
              params={{ status: params.status, cursor: params.tab === 'invitations' ? params.cursor : undefined }}
              initialData={seeded && params.tab === 'invitations' ? initialInvites : undefined}
              hrefFor={(next) => hrefFor({ tab: 'invitations', status: params.status, ...next })}
            />
          </TabsContent>
        )}
        <TabsContent value="roles">
          <RolesMatrix myRole={shop.myRole} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
