'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { ProblemPanel, RateLimitNotice, SectionError } from '@/components/seller/problem-states';
import { ResponsiveTable, type Column } from '@/components/seller/responsive-table';
import { RowMenu } from '@/components/seller/row-menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TableRowsSkeleton } from '@/components/seller/page-skeletons';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useInvite, useInvites, useResendInvite, useRevokeInvite, type InvitePage, type InviteRole, type ShopInvite } from '@/lib/api/seller-team';
import { formatInstant } from '@/lib/seller/format-date';
import { roleLabel } from '@/lib/seller/nav';
import { useShopWritable } from '@/lib/seller/permissions';
import { INVITE_STATUSES, type TeamParams } from '@/lib/seller/search-params';

const INVITE_ROLES: readonly InviteRole[] = ['ADMIN', 'STAFF', 'VIEWER'];
const STATUS_LABEL: Record<ShopInvite['status'], string> = { pending: 'Pending', accepted: 'Accepted', revoked: 'Revoked', expired: 'Expired' };
const FIELD = 'h-11 w-full rounded-lg border border-input bg-background px-3 text-sm sm:h-8';

const isRateLimited = (problem: Problem) => problem.status === 429 || problem.code === 'rate_limited';

/**
 * The invitations tab (W04 AS-77, AS-78): the invite form, the status filter in the URL and the list with Resend and
 * Revoke on pending rows. The API never returns the invite link, so none is shown.
 */
export function InvitesPanel({
  shopId,
  shop,
  params,
  initialData,
  hrefFor,
}: {
  shopId: string;
  shop: { status: string };
  params: Pick<TeamParams, 'status' | 'cursor'>;
  initialData?: InvitePage;
  hrefFor: (next: { status?: TeamParams['status']; cursor?: string }) => string;
}) {
  const router = useRouter();
  const ids = useId();
  const { writable, reason } = useShopWritable(shop);
  const invites = useInvites(shopId, { status: params.status, cursor: params.cursor }, initialData);
  const invite = useInvite(shopId);
  const resend = useResendInvite(shopId);
  const revoke = useRevokeInvite(shopId);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('STAFF');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [limited, setLimited] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [rowProblem, setRowProblem] = useState<Problem | null>(null);
  const [revoking, setRevoking] = useState<ShopInvite | null>(null);
  const [revokeProblem, setRevokeProblem] = useState<Problem | null>(null);

  const emailField = problem?.code === 'validation_failed' || problem?.errors.some((item) => item.field === 'email');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invite.isPending || limited) return;
    setSentTo('');
    setProblem(null);
    const address = email.trim();
    if (!address) {
      setProblem({ status: 400, code: 'validation_failed', errors: [{ field: 'email', code: 'required' }] } as Problem);
      return;
    }
    try {
      await invite.mutateAsync({ email: address, role });
      setSentTo(address);
      setEmail('');
    } catch (error) {
      setAttempt((count) => count + 1);
      setProblem(problemFromError(error));
    }
  }

  async function resendRow(row: ShopInvite) {
    setRowProblem(null);
    try {
      await resend.mutateAsync(row.id);
      toast.success('Invitation resent');
    } catch (error) {
      setRowProblem(problemFromError(error));
    }
  }

  async function confirmRevoke(row: ShopInvite) {
    setRevokeProblem(null);
    try {
      await revoke.mutateAsync(row.id);
    } catch (error) {
      setRevokeProblem(problemFromError(error));
      throw error;
    }
    setRevoking(null);
    toast.success('Invitation revoked');
  }

  const columns: Column<ShopInvite>[] = [
    { id: 'email', header: 'E-mail', primary: true, cell: (row) => row.email },
    { id: 'role', header: 'Role', cell: (row) => roleLabel(row.role) },
    { id: 'status', header: 'Status', cell: (row) => <Badge variant={row.status === 'pending' ? 'secondary' : 'outline'}>{STATUS_LABEL[row.status]}</Badge> },
    {
      id: 'expires',
      header: 'Expires',
      cell: (row) => {
        const at = formatInstant(row.expiresAt, { time: false });
        return (
          <time dateTime={at.iso} title={at.utc}>
            {at.text}
          </time>
        );
      },
    },
  ];

  const data = invites.data;
  const busy = invites.isPlaceholderData;

  return (
    <div className="space-y-6">
      <form onSubmit={(event) => void submit(event)} noValidate className="space-y-3 rounded-lg border p-4" aria-label="Invite a member">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1 space-y-1">
            <label htmlFor={`${ids}-email`} className="text-sm font-medium">
              E-mail address
            </label>
            <Input
              id={`${ids}-email`}
              type="email"
              autoComplete="off"
              value={email}
              aria-invalid={emailField ? true : undefined}
              aria-describedby={`${ids}-note`}
              onChange={(event) => setEmail(event.target.value)}
              className="h-11 sm:h-8"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${ids}-role`} className="text-sm font-medium">
              Role
            </label>
            <select id={`${ids}-role`} value={role} onChange={(event) => setRole(event.target.value as InviteRole)} className={FIELD}>
              {INVITE_ROLES.map((value) => (
                <option key={value} value={value}>
                  {roleLabel(value)}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" className="min-h-11 sm:min-h-8" disabled={!writable || invite.isPending || limited} aria-busy={invite.isPending}>
            Send invitation
          </Button>
        </div>
        <div id={`${ids}-note`} className="space-y-2 text-sm">
          {!writable && <p className="text-muted-foreground">{reason}</p>}
          {problem &&
            (isRateLimited(problem) ? (
              <RateLimitNotice seconds={problem.retryAfterSeconds} token={attempt} onActiveChange={setLimited} />
            ) : (
              <ProblemPanel problem={problem} context={{ place: 'page' }} />
            ))}
          <p role="status" className="empty:hidden">
            {sentTo ? `Invitation sent to ${sentTo}.` : ''}
          </p>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${ids}-status`} className="text-sm font-medium">
          Status
        </label>
        <select id={`${ids}-status`} value={params.status} onChange={(event) => router.push(hrefFor({ status: event.target.value as TeamParams['status'] }))} className={FIELD + ' sm:w-auto'}>
          {INVITE_STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABEL[value]}
            </option>
          ))}
        </select>
      </div>

      {rowProblem && <ProblemPanel problem={rowProblem} context={{ place: 'page' }} />}

      {invites.isError ? (
        <SectionError error={invites.error} onRetry={() => void invites.refetch()} firstPageHref={hrefFor({})} />
      ) : !data ? (
        <TableRowsSkeleton rows={3} name="invites" />
      ) : data.items.length === 0 && !busy ? (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
          <p>{params.cursor ? 'No invitations on this page.' : `No ${STATUS_LABEL[params.status].toLowerCase()} invitations.`}</p>
          {params.cursor && (
            <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
              <Link href={hrefFor({})}>First page</Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <ResponsiveTable
            caption="Invitations"
            captionHidden
            columns={columns}
            rows={data.items}
            rowKey={(row) => row.id}
            busy={busy}
            actions={(row) => (
              <RowMenu
                label={row.email}
                disabledReason={writable ? null : reason}
                items={[
                  { id: 'resend', label: 'Resend', hidden: row.status !== 'pending', onSelect: () => void resendRow(row) },
                  { id: 'revoke', label: 'Revoke', destructive: true, hidden: row.status !== 'pending', onSelect: () => (setRevokeProblem(null), setRevoking(row)) },
                ]}
              />
            )}
          />
          {!busy && (params.cursor || data.nextCursor) && (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3">
              {params.cursor ? (
                <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                  <Link href={hrefFor({})}>First page</Link>
                </Button>
              ) : (
                <span />
              )}
              {data.nextCursor && (
                <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
                  <Link href={hrefFor({ cursor: data.nextCursor })}>Next page</Link>
                </Button>
              )}
            </nav>
          )}
        </div>
      )}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke invitation for ${revoking?.email ?? ''}`}
        description="The link in the e-mail stops working straight away."
        confirmLabel="Revoke"
        destructive
        error={revokeProblem ? <ProblemPanel problem={revokeProblem} context={{ place: 'dialog' }} /> : undefined}
        onConfirm={() => (revoking ? confirmRevoke(revoking) : undefined)}
      />
    </div>
  );
}
