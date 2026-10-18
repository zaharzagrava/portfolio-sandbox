'use client';

import { useId, useState } from 'react';
import type { FlagAuditPage } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { diffFlags } from '@/lib/admin/flags/diff';
import { formatUtc } from '@/lib/admin/flags/format-time';
import { CopyButton } from './copy-button';

type Entry = FlagAuditPage['items'][number];

const ACTION: Record<Entry['action'], string> = { create: 'Created', update: 'Updated', kill: 'Killed', restore: 'Restored', archive: 'Archived' };

/**
 * One applied change (W06 AS-40, AS-41): label, UTC time, actor ("You" for the viewer, otherwise the id in monospace with
 * Copy), request id with Copy, and **Show changes** that opens the readable difference computed in the browser from the
 * entry's `before` and `after`. Every value is text (VI.7).
 */
export function HistoryEntry({ entry, viewerId }: { entry: Entry; viewerId?: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const diff = open ? diffFlags(entry.before, entry.after) : null;
  return (
    <li className="space-y-2 rounded-xl border bg-background p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <strong data-testid="action" className="text-base">
          {ACTION[entry.action]}
        </strong>
        <time dateTime={entry.at}>{formatUtc(entry.at)}</time>
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-muted-foreground">By</span>
          {entry.actorId === viewerId ? <span>You</span> : <span className="font-mono break-all">{entry.actorId}</span>}
          {entry.actorId !== viewerId && <CopyButton text={entry.actorId} label="Copy actor id" />}
        </span>
        {entry.requestId && (
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Request</span>
            <span className="font-mono break-all">{entry.requestId}</span>
            <CopyButton text={entry.requestId} label="Copy request id" />
          </span>
        )}
      </div>
      <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((value) => !value)}>
        {open ? 'Hide changes' : 'Show changes'}
      </Button>
      <div id={panel} hidden={!open} className="min-w-0 space-y-2 text-sm">
        {diff && (
          <>
            {diff.kind === 'created' && <p className="font-medium">Created with</p>}
            {diff.kind === 'none' && <p>No visible changes</p>}
            <ul className="space-y-2">
              {diff.lines.map((line) => (
                <li key={line.field} className="min-w-0 break-words">
                  <p>{line.text}</p>
                  {(line.detailBefore || line.detailAfter) && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-muted-foreground">Full text</summary>
                      {line.detailBefore ? <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{line.detailBefore}</pre> : null}
                      {line.detailAfter ? <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{line.detailAfter}</pre> : null}
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </li>
  );
}
