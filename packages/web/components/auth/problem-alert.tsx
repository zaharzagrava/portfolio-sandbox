'use client';

import type { Ref } from 'react';
import { Button } from '@/components/ui/button';
import type { Problem } from '@/lib/api/errors';
import { problemCopy, type CopyOptions, type Surface } from '@/lib/api/problem-copy';
import { needsReload, problemMessage, showsReference, type ProblemContext } from '@/lib/auth/copy';

/**
 * The one place a failed call is shown (W01 FR-040). The text comes from the catalogue by `code`/`status`, never from the
 * server's `detail`/`title`. Focusable (`tabIndex=-1`) so a form can move focus here when no field is at fault (FR-053).
 */
export function ProblemAlert({
  problem,
  context = 'generic',
  surface,
  target,
  copyOptions,
  role = 'alert',
  id,
  className,
  ref,
}: {
  problem: Problem;
  context?: ProblemContext;
  /** W02 surfaces: the text and reference come from the storefront catalogue (`lib/api/problem-copy.ts`). */
  surface?: Surface;
  target?: CopyOptions['target'];
  /** W03 FR-082: extra inputs of the catalogue (`detail` of a 4xx for the generic form, `titles`, `operation`). */
  copyOptions?: Omit<CopyOptions, 'target'>;
  role?: 'alert' | 'status';
  id?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const copy = surface ? problemCopy(surface, problem, { ...copyOptions, target }) : undefined;
  return (
    <div
      ref={ref}
      id={id}
      role={role}
      tabIndex={-1}
      className={`rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 outline-none dark:border-red-900 dark:bg-red-950/60 dark:text-red-100 focus-visible:ring-3 focus-visible:ring-ring/50 ${className ?? ''}`}
    >
      <p>{copy ? copy.text : problemMessage(problem, context)}</p>
      {copy?.detail && <p className="mt-1 text-xs">{copy.detail}</p>}
      {copy ? (
        copy.reference && (
          <p className="mt-1 text-xs">
            Reference: <span className="select-text break-all font-mono">{problem.requestId}</span>
          </p>
        )
      ) : (
        showsReference(problem) && (
        <p className="mt-1 text-xs">
          Reference: <span className="select-text break-all font-mono">{problem.requestId}</span>
        </p>
        )
      )}
      {needsReload(problem) && (
        <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11 sm:min-h-7" onClick={() => window.location.reload()}>
          Reload
        </Button>
      )}
    </div>
  );
}
