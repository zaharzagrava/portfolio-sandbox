'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionListItem } from '@marketplace-sandbox/contracts';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { listSessions, logoutAll, revokeSession } from '@/lib/api/account';
import { problemFromError } from '@/lib/api/errors';
import { sessionApi } from '@/lib/api/session';
import { problemMessage } from '@/lib/auth/copy';
import { queryKeys } from '@/lib/query-keys';
import { clearPrivateState } from '@/hooks/use-auth-actions';
import { DESTRUCTIVE_TEXT, SHEET_DIALOG } from './dialog-styles';
import { formatDateTime, relativeTime } from './format-time';
import { useDesktop } from './use-desktop';

/**
 * The "Active sessions" tab (W01 US9, AS-54..AS-57). Newest first; the current session is labelled and has no revoke
 * control (signing out here is the menu's Log out). A table from 1024 px, stacked cards below. Keys are session ids.
 */
export function SessionsPanel({ now }: { now?: number }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const desktop = useDesktop();
  const sessions = useQuery({ queryKey: queryKeys.auth.sessions(), queryFn: listSessions });
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const without = (sessionId: string) =>
    queryClient.setQueryData<SessionListItem[]>(queryKeys.auth.sessions(), (list) => list?.filter((item) => item.sessionId !== sessionId));

  async function revoke(sessionId: string) {
    if (revoking.has(sessionId)) return;
    setRevoking((set) => new Set(set).add(sessionId));
    try {
      await revokeSession(sessionId);
      without(sessionId);
      setAnnouncement('Device signed out.');
    } catch (error) {
      const problem = problemFromError(error);
      if (problem.code === 'session_not_found') {
        without(sessionId);
        setAnnouncement('Device signed out.');
      } else toast.error(problemMessage(problem));
    } finally {
      setRevoking((set) => {
        const next = new Set(set);
        next.delete(sessionId);
        return next;
      });
    }
  }

  async function signOutEverywhere() {
    if (leaving) return;
    setLeaving(true);
    try {
      await logoutAll();
      // The BFF holds its own session record and cookies: end them too, or `/login` would treat the visitor as signed in.
      // Every session is already revoked, so a failure here changes nothing the member can see.
      await sessionApi.logout();
      clearPrivateState(queryClient);
      router.replace('/login?notice=signed_out_everywhere');
      router.refresh();
    } catch (error) {
      toast.error(problemMessage(problemFromError(error)));
      setLeaving(false);
    }
  }

  if (sessions.isPending) {
    return (
      <div data-testid="sessions-skeleton" aria-busy="true" className="grid gap-3">
        {[0, 1, 2].map((n) => (
          <Skeleton key={n} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (sessions.isError) {
    return (
      <div className="grid gap-3">
        <p role="alert">We couldn&apos;t load this section.</p>
        <div>
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" onClick={() => void sessions.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const items = [...sessions.data].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const name = (item: SessionListItem) => item.device ?? 'Unknown device';
  const signedIn = (item: SessionListItem) => (
    <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
  );
  const lastActive = (item: SessionListItem) => {
    const at = item.lastUsedAt ?? item.createdAt;
    return <time dateTime={at}>{relativeTime(at, now)}</time>;
  };
  const action = (item: SessionListItem, full: boolean) =>
    item.current ? null : (
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`Log out ${name(item)}`}
        className={full ? 'min-h-11 w-full' : undefined}
        disabled={revoking.has(item.sessionId)}
        onClick={() => void revoke(item.sessionId)}
      >
        {revoking.has(item.sessionId) && <Loader2 className="animate-spin" aria-hidden="true" />}
        Log out
      </Button>
    );
  const badge = (item: SessionListItem) =>
    item.current && <span className="ml-2 rounded-full border px-2 py-0.5 text-xs font-medium">This device</span>;

  return (
    <section aria-labelledby="sessions-heading" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="sessions-heading" className="text-lg font-semibold">
          Active sessions
        </h2>
        <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" onClick={() => setConfirming(true)}>
          Log out of all devices
        </Button>
      </div>
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {desktop ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Device</TableHead>
              <TableHead>IP address</TableHead>
              <TableHead>Signed in</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.sessionId}>
                <TableCell>
                  {name(item)}
                  {badge(item)}
                </TableCell>
                <TableCell>{item.ip ?? 'Unknown'}</TableCell>
                <TableCell>{signedIn(item)}</TableCell>
                <TableCell>{lastActive(item)}</TableCell>
                <TableCell>{action(item, false)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <ul className="grid gap-3">
          {items.map((item) => (
            <li key={item.sessionId} className="grid gap-3 rounded-lg border p-4">
              <p className="font-medium">
                <span>{name(item)}</span>
                {badge(item)}
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">IP address</dt>
                <dd>{item.ip ?? 'Unknown'}</dd>
                <dt className="text-muted-foreground">Signed in</dt>
                <dd>{signedIn(item)}</dd>
                <dt className="text-muted-foreground">Last active</dt>
                <dd>{lastActive(item)}</dd>
              </dl>
              {action(item, true)}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={confirming} onOpenChange={(open) => !leaving && setConfirming(open)}>
        <DialogContent className={SHEET_DIALOG}>
          <DialogHeader>
            <DialogTitle>Log out of all devices</DialogTitle>
            <DialogDescription>This signs you out here too.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11 sm:min-h-0" disabled={leaving} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" className={`min-h-11 sm:min-h-0 ${DESTRUCTIVE_TEXT}`} disabled={leaving} aria-busy={leaving} onClick={() => void signOutEverywhere()}>
              {leaving && <Loader2 className="animate-spin" aria-hidden="true" />}
              Log out everywhere
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
