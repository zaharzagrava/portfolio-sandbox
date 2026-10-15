'use client';

import { useEffect } from 'react';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import type { Problem } from '@/lib/api/errors';

/**
 * A failed read of the list, a thread or some replies (W02 AS-52, AS-74), shown beside the control that asked: the
 * catalogue text, **Try again** (not for a `404`, which will not change), and while the browser is offline the line
 * "Reconnecting…", because the request is repeated by itself when the browser comes back online.
 */
export function ReadProblem({
  problem,
  retry,
  busy,
  className,
}: {
  problem: Problem;
  retry: () => void;
  busy: boolean;
  className?: string;
}) {
  const offline = problem.status === 0;
  useEffect(() => {
    if (!offline) return;
    const again = () => retry();
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, [offline, retry]);

  return (
    <div className={className} aria-busy={offline ? true : undefined}>
      <ProblemAlert problem={problem} surface="discussions-read" />
      {offline ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Reconnecting…
        </p>
      ) : null}
      {problem.status === 404 ? null : (
        <Button type="button" variant="outline" className="mt-2 min-h-9 max-sm:min-h-11" disabled={busy} onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}
