'use client';

import type { Flag } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { formatUtc } from '@/lib/admin/flags/format-time';
import { availableActions, type LifecycleAction } from '@/lib/admin/flags/transitions';
import { DANGER_BUTTON } from './danger';
import { StatusBadge } from './status-badge';

const Time = ({ iso }: { iso: string }) => <time dateTime={iso}>{formatUtc(iso)}</time>;

/**
 * The editor's header (W06 AS-17, AS-33): the key as `h1`, the status badge, "Version {n}", Created and Updated in UTC, and the
 * lifecycle actions that status allows. The kill switch is visible without scrolling: at the right on desktop, full width
 * directly under the header at 640 px and below (one set of buttons, laid out by CSS). Reads the live flag, so the badge and
 * version follow a refetch while the draft stays.
 */
export function EditorHeader({ flag, busy, onAction }: { flag: Flag; busy: boolean; onAction: (action: LifecycleAction) => void }) {
  const actions = availableActions(flag.status);
  const button = 'min-h-11 w-full sm:min-h-8 sm:w-auto';
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 font-mono text-2xl font-semibold tracking-tight break-all" tabIndex={-1}>
            {flag.key}
          </h1>
          <StatusBadge status={flag.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          Version {flag.version} · Created <Time iso={flag.createdAt} /> · Updated <Time iso={flag.updatedAt} />
        </p>
      </div>
      {actions.length > 0 && (
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          {actions.includes('kill') && (
            <Button type="button" variant="destructive" disabled={busy} onClick={() => onAction('kill')} className={`${button} ${DANGER_BUTTON}`}>
              Kill switch
            </Button>
          )}
          {actions.includes('restore') && (
            <Button type="button" variant="outline" disabled={busy} onClick={() => onAction('restore')} className={button}>
              Restore
            </Button>
          )}
          {actions.includes('archive') && (
            <Button type="button" variant="outline" disabled={busy} onClick={() => onAction('archive')} className={button}>
              Archive
            </Button>
          )}
        </div>
      )}
    </header>
  );
}
