'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { endSession } from '@/lib/auth/session-ended';
import { useOnline } from '@/hooks/use-online';
import { queryKeys } from '@/lib/query-keys';
import { useCountdown } from '@/lib/seller/countdown';
import { sellerProblemCopy, type SellerProblemContext } from '@/lib/seller/problem-copy';
import { CopyButton } from './copy-button';

/**
 * How a failed call or read shows in the seller screens (W04 FR-043..FR-046, AS-87..AS-90). The text comes from
 * `sellerProblemCopy` by `code`, so the server's `title`/`detail` never reach the page; the chrome matches W01's
 * `ProblemAlert` (same classes, `role="alert"`, focusable). A session that ended is a polite status and runs W01's
 * session-ended flow, which latches to once.
 */

const ALERT =
  'rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 outline-none dark:border-red-900 dark:bg-red-950/60 dark:text-red-100 focus-visible:ring-3 focus-visible:ring-ring/50';

export const OFFLINE_TEXT = "You're offline. Changes can't be saved.";

/** "Too many {subject}. Try again in {n} s." with one polite announcement at the start and one at the end (AS-90). */
export function RateLimitNotice({
  seconds,
  subject = 'requests',
  token,
  onActiveChange,
  className,
}: {
  seconds?: number;
  subject?: 'requests' | 'attempts' | 'test events';
  /** A new value restarts the count when the same number comes twice. */
  token?: unknown;
  /** `true` while counting, `false` once the caller may try again: the control that caused it uses this to disable itself. */
  onActiveChange?: (active: boolean) => void;
  className?: string;
}) {
  const countdown = useCountdown(seconds, token);
  const { active } = countdown;
  const notify = useRef(onActiveChange);
  useEffect(() => {
    notify.current = onActiveChange;
  });
  useEffect(() => {
    notify.current?.(active);
  }, [active]);

  const counting = (seconds ?? 0) > 0;
  const text = !counting ? `Too many ${subject}. Try again later.` : active ? `Too many ${subject}. Try again in ${countdown.remaining} s.` : 'You can try again now.';
  return (
    <div tabIndex={-1} className={`${ALERT} ${className ?? ''}`}>
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
      <CopyButton text={requestId} label="Copy reference" showLabel />
    </p>
  );
}

function SessionEnded({ className }: { className?: string }) {
  useEffect(() => {
    endSession();
  }, []);
  return (
    <p role="status" className={`text-sm text-muted-foreground ${className ?? ''}`}>
      Your session ended. Sign in again to continue.
    </p>
  );
}

/** One problem, in the form its code gives it. `onRetry` adds "Try again" (not for a session end or a countdown). */
export function ProblemPanel({
  problem,
  context,
  subject,
  onRetry,
  firstPageHref,
  onActiveChange,
  className,
}: {
  problem: Problem;
  context?: SellerProblemContext;
  subject?: SellerProblemContext['subject'];
  onRetry?: () => void;
  /** Target of "Go to the first page" for `invalid_cursor`; defaults to the current path, which has no cursor. */
  firstPageHref?: string;
  /** Passed to the rate-limit countdown: `true` while it counts, so the control that caused it can disable itself (W04 R-14). */
  onActiveChange?: (active: boolean) => void;
  className?: string;
}) {
  const pathname = usePathname();
  const copy = sellerProblemCopy(problem, { ...context, subject: subject ?? context?.subject });

  if (copy.form === 'session') return <SessionEnded className={className} />;
  if (copy.form === 'countdown') return <RateLimitNotice seconds={copy.retryAfterSeconds} subject={subject ?? context?.subject} onActiveChange={onActiveChange} className={className} />;

  return (
    <div role="alert" tabIndex={-1} className={`${ALERT} ${className ?? ''}`}>
      <p>{copy.message}</p>
      {copy.reference && <Reference requestId={copy.reference} />}
      {copy.action === 'first-page' && (
        <Button asChild variant="outline" size="sm" className="mt-2 min-h-11 sm:min-h-7">
          <Link href={firstPageHref ?? pathname ?? '/dashboard/seller'}>Go to the first page</Link>
        </Button>
      )}
      {onRetry && copy.action !== 'first-page' && (
        <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11 sm:min-h-7" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** A section of a page that failed to load: the problem in words and "Try again" (the rest of the page stays usable). */
export function SectionError({ error, onRetry, context, firstPageHref }: { error: unknown; onRetry: () => void; context?: SellerProblemContext; firstPageHref?: string }) {
  return <ProblemPanel problem={problemFromError(error)} context={{ kind: 'read', ...context }} onRetry={onRetry} firstPageHref={firstPageHref} />;
}

/**
 * The offline banner of every seller page (AS-88): a polite status region that is always mounted, so its changes are
 * announced. When the browser comes back, the seller queries that are on screen refetch once.
 */
export function OfflineBanner() {
  const online = useOnline();
  const queryClient = useQueryClient();
  const wasOffline = useRef(false);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      // Joins a refetch the query client already started for the same reconnect: one request, not two (B-071).
      void queryClient.invalidateQueries({ queryKey: queryKeys.seller.all() }, { cancelRefetch: false });
    }
  }, [online, queryClient]);

  return (
    <div role="status" className="empty:hidden">
      {!online && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">{OFFLINE_TEXT}</p>
      )}
    </div>
  );
}
