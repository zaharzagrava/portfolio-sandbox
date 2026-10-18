'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { flagProblemCopy, type FlagProblemView } from '@/lib/admin/flags/copy';
import type { FlagOp, FlagProblem } from '@/lib/admin/flags/problem';
import { listHref, staleHref, flagHref, LIST_PATH } from '@/lib/admin/flags/params';
import { endSession } from '@/lib/auth/session-ended';
import { waitPhrase } from '@/lib/auth/retry-after';
import { useCountdown } from '@/lib/seller/countdown';
import { ForbiddenPanel } from '@/components/admin/forbidden-panel';
import { CopyButton } from './copy-button';
import { NotFoundPanel } from './not-found-panel';

const ALERT =
  'rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 outline-none dark:border-red-900 dark:bg-red-950/60 dark:text-red-100 focus-visible:ring-3 focus-visible:ring-ring/50';
const WARN = 'rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100';
const BUTTON = 'mt-2 min-h-11 sm:min-h-7';

/** "Too many requests. Try again in {wait}." with one polite announcement at the start and one at the end (W06 AS-50). */
export function RateLimited({ seconds, token, onActiveChange }: { seconds?: number; token?: unknown; onActiveChange?: (active: boolean) => void }) {
  const countdown = useCountdown(seconds, token);
  const notify = useRef(onActiveChange);
  useEffect(() => {
    notify.current = onActiveChange;
  });
  useEffect(() => {
    notify.current?.(countdown.active);
  }, [countdown.active]);
  const counting = (seconds ?? 0) > 0;
  const text = !counting ? 'Too many requests. Try again later.' : countdown.active ? `Too many requests. Try again in ${waitPhrase(countdown.remaining)}.` : 'You can try again now.';
  return (
    <div tabIndex={-1} className={ALERT}>
      <p>{text}</p>
      <span role="status" className="sr-only">
        {countdown.announcement}
      </span>
    </div>
  );
}

function Reference({ requestId }: { requestId: string }) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      <span>
        Reference: <span className="select-text break-all font-mono">{requestId}</span>
      </span>
      <CopyButton text={requestId} label="Copy reference" />
    </p>
  );
}

function SessionEnded() {
  useEffect(() => {
    endSession();
  }, []);
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Your session ended. Sign in again to continue.
    </p>
  );
}

export type FlagProblemProps = {
  problem: FlagProblem;
  op: FlagOp;
  flagKey?: string;
  onRetry?: () => void;
  onLoadLatest?: () => void;
  onKeepEditing?: () => void;
  /** `true` while a 429 countdown runs: the control that caused it disables itself. */
  onCountdownActive?: (active: boolean) => void;
  /** Distinguishes two refusals with the same wait. */
  token?: unknown;
  id?: string;
  className?: string;
};

/**
 * One failed call in the form its code gives it (W06 error catalogue). Copy comes from `flagProblemCopy` by `(status, code)`,
 * so the server's `title` and `detail` never reach the page. A 403 replaces the content with the no-access panel (AS-48);
 * a lost session runs W01's session-ended flow once (AS-49). Field-level placement (`field`, `summary`) is the form's job;
 * the summary here lists the issues as links to their fields.
 */
export function FlagProblemAlert(props: FlagProblemProps) {
  const { problem, op, flagKey, onRetry, onLoadLatest, onKeepEditing, onCountdownActive, token, id, className } = props;
  const view: FlagProblemView = flagProblemCopy(problem, { op, key: flagKey });

  if (view.form === 'session') return <SessionEnded />;
  if (view.form === 'forbidden') return <ForbiddenPanel />;
  if (view.form === 'notfound') return <NotFoundPanel />;
  if (view.form === 'countdown') return <RateLimited seconds={view.retryAfterSeconds} token={token} onActiveChange={onCountdownActive} />;

  const tone = view.form === 'banner' ? WARN : ALERT;
  return (
    <div id={id} role="alert" tabIndex={-1} className={`${tone} ${className ?? ''}`}>
      <p>{view.message}</p>
      {view.form === 'summary' && view.issues && view.issues.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {view.issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              {issue.fieldId ? (
                <a href={`#${issue.fieldId}`} className="underline underline-offset-2" title={issue.title}>
                  {issue.label}: {issue.message}
                </a>
              ) : (
                <span title={issue.title}>
                  {issue.path ? `${issue.path}: ` : ''}
                  {issue.message}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {view.reference && <Reference requestId={view.reference} />}
      <div className="flex flex-wrap gap-2">
        {view.action === 'retry' && onRetry && (
          <Button type="button" variant="outline" size="sm" className={BUTTON} onClick={onRetry}>
            Try again
          </Button>
        )}
        {view.action === 'reload' && (
          <Button type="button" variant="outline" size="sm" className={BUTTON} onClick={() => window.location.reload()}>
            Reload
          </Button>
        )}
        {view.action === 'first-page' && (
          <Button asChild variant="outline" size="sm" className={BUTTON}>
            <Link href={op === 'history' && flagKey ? flagHref(flagKey) + '?tab=history' : listHref({ status: 'all' })}>{op === 'history' ? 'Go to the newest changes' : 'Go to the first page'}</Link>
          </Button>
        )}
        {view.action === 'all-flags' && (
          <Button asChild variant="outline" size="sm" className={BUTTON}>
            <Link href={LIST_PATH}>All flags</Link>
          </Button>
        )}
        {view.action === 'review-stale' && (
          <Button asChild variant="outline" size="sm" className={BUTTON}>
            <Link href={staleHref(14)}>Review stale flags</Link>
          </Button>
        )}
        {view.action === 'load-latest' && onLoadLatest && (
          <Button type="button" variant="outline" size="sm" className={BUTTON} onClick={onLoadLatest}>
            Load latest
          </Button>
        )}
        {view.action === 'load-latest' && onKeepEditing && (
          <Button type="button" variant="ghost" size="sm" className={BUTTON} onClick={onKeepEditing}>
            Keep editing
          </Button>
        )}
      </div>
    </div>
  );
}
