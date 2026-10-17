'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { ProblemPanel, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { RowMenu, type RowMenuItem } from '@/components/seller/row-menu';
import { Button } from '@/components/ui/button';
import { TableRowsSkeleton } from '@/components/seller/page-skeletons';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useChangeRole, useMembers, useRemoveMember, type MemberPage, type MemberRole, type ShopMember } from '@/lib/api/seller-team';
import { formatInstant } from '@/lib/seller/format-date';
import { roleLabel, SELLER_HOME } from '@/lib/seller/nav';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';

const SOURCE_LABEL: Record<ShopMember['source'], string> = { owner: 'Owner', invite: 'Invitation', sso: 'Single sign-on', provisioned: 'Provisioned' };
const ROLES: readonly MemberRole[] = ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'];

/** S03 FR-021: owners manage every role, admins manage staff and viewers, nobody else manages anyone. */
const manageable = (actor: string | undefined, target: MemberRole): boolean => actor === 'OWNER' || (actor === 'ADMIN' && (target === 'STAFF' || target === 'VIEWER'));
const assignable = (actor: string | undefined): readonly MemberRole[] => (actor === 'OWNER' ? ROLES : actor === 'ADMIN' ? ['STAFF', 'VIEWER'] : []);

const nameOf = (member: ShopMember) => member.email ?? 'Unknown member';

/**
 * The members tab (W04 AS-74..AS-76): a table with a self marker, a role menu limited to what S03 FR-021 allows the
 * viewer, removal, and "Leave shop" on the viewer's own row. The API still decides: its refusals show as messages.
 */
export function MembersPanel({
  shopId,
  shop,
  selfId,
  cursor,
  initialData,
  pageHref,
}: {
  shopId: string;
  shop: { name: string; status: string; myRole?: string; myPermissions?: readonly string[] | null };
  selfId: string | undefined;
  cursor: string | undefined;
  initialData?: MemberPage;
  pageHref: (cursor?: string) => string;
}) {
  const router = useRouter();
  const members = useMembers(shopId, { cursor }, initialData);
  const changeRole = useChangeRole(shopId);
  const removeMember = useRemoveMember(shopId);
  const { writable, reason } = useShopWritable(shop);
  const canManage = shopCan(shop, 'members.manage');

  const [problem, setProblem] = useState<Problem | null>(null);
  const [dialogProblem, setDialogProblem] = useState<Problem | null>(null);
  const [removing, setRemoving] = useState<ShopMember | null>(null);

  async function setRole(member: ShopMember, role: MemberRole) {
    setProblem(null);
    try {
      await changeRole.mutateAsync({ userId: member.userId, role });
      toast.success('Role updated');
    } catch (error) {
      setProblem(problemFromError(error));
    }
  }

  async function confirmRemove(member: ShopMember) {
    setDialogProblem(null);
    const leaving = member.userId === selfId;
    try {
      await removeMember.mutateAsync(member.userId);
    } catch (error) {
      setDialogProblem(problemFromError(error));
      throw error;
    }
    setRemoving(null);
    if (leaving) {
      toast.success('You left the shop');
      router.push(SELLER_HOME);
    } else {
      toast.success('Member removed');
    }
  }

  function menuFor(member: ShopMember): RowMenuItem[] {
    const own = member.userId === selfId;
    const mayManage = canManage && manageable(shop.myRole, member.role);
    const roleItems = mayManage
      ? assignable(shop.myRole)
          .filter((role) => role !== member.role)
          .map<RowMenuItem>((role) => ({ id: `role-${role}`, label: `Change role to ${roleLabel(role)}`, onSelect: () => void setRole(member, role) }))
      : [];
    return [
      ...roleItems,
      { id: 'remove', label: 'Remove member', destructive: true, hidden: own || !mayManage, onSelect: () => (setProblem(null), setDialogProblem(null), setRemoving(member)) },
      { id: 'leave', label: 'Leave shop', destructive: true, hidden: !own, onSelect: () => (setProblem(null), setDialogProblem(null), setRemoving(member)) },
    ];
  }

  const columns: Column<ShopMember>[] = [
    { id: 'member', header: 'Member', primary: true, cell: (member) => (member.userId === selfId ? `${nameOf(member)} (you)` : nameOf(member)) },
    { id: 'role', header: 'Role', cell: (member) => roleLabel(member.role) },
    {
      id: 'joined',
      header: 'Joined',
      cell: (member) => {
        const at = formatInstant(member.joinedAt, { time: false });
        return (
          <time dateTime={at.iso} title={at.utc}>
            {at.text}
          </time>
        );
      },
    },
    { id: 'source', header: 'Source', cell: (member) => SOURCE_LABEL[member.source] },
  ];

  const data = members.data;
  const busy = members.isPlaceholderData;
  const leaving = removing?.userId === selfId;

  return (
    <div className="space-y-4">
      {problem && <ProblemPanel problem={problem} context={{ place: 'page' }} />}
      {members.isError ? (
        <SectionError error={members.error} onRetry={() => void members.refetch()} firstPageHref={pageHref()} />
      ) : !data ? (
        <TableRowsSkeleton rows={5} name="members" />
      ) : data.items.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
          <p>No members on this page.</p>
          {cursor && (
            <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
              <Link href={pageHref()}>First page</Link>
            </Button>
          )}
        </div>
      ) : (
        <>
          <ResponsiveTable
            caption={`Members of ${shop.name}`}
            captionHidden
            columns={columns}
            rows={data.items}
            rowKey={(member) => member.userId}
            busy={busy}
            actions={(member) => <RowMenu label={nameOf(member)} items={menuFor(member)} disabledReason={writable ? null : reason} />}
          />
          {!busy && (cursor || data.nextCursor) && (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3">
              {cursor ? (
                <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                  <Link href={pageHref()}>First page</Link>
                </Button>
              ) : (
                <span />
              )}
              {data.nextCursor && (
                <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                  <Link href={pageHref(data.nextCursor)}>Next page</Link>
                </Button>
              )}
            </nav>
          )}
        </>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={leaving ? 'Leave shop' : `Remove ${removing ? nameOf(removing) : ''}`}
        description={leaving ? `You will lose access to ${shop.name} straight away.` : 'They will lose access to this shop straight away.'}
        confirmLabel={leaving ? 'Leave' : 'Remove'}
        destructive
        error={dialogProblem ? <ProblemPanel problem={dialogProblem} context={{ place: 'dialog' }} /> : undefined}
        onConfirm={() => (removing ? confirmRemove(removing) : undefined)}
      />
    </div>
  );
}
