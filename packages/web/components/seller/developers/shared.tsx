'use client';

import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from 'cn';
import { ProblemPanel } from '@/components/seller/problem-states';
import { Button } from '@/components/ui/button';
import type { Problem } from '@/lib/api/errors';
import { formatInstant } from '@/lib/seller/format-date';
import { sellerProblemCopy, type SellerProblemContext } from '@/lib/seller/problem-copy';

/** Parts shared by the developer pages (W04 US4..US6). */

const CONTROL =
  'h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive max-sm:min-h-11 dark:bg-input/30';

/** A native select: it stays operable by keyboard, screen reader and a phone's own picker, and a test can drive it. */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select {...props} className={cn(CONTROL, className)} />;
}

export const controlClass = CONTROL;

/** A server instant in the viewer's zone with the UTC value as its tooltip (W04 assumptions, "Time"). */
export function Instant({ value, time = true, fallback }: { value: string | null | undefined; time?: boolean; fallback?: string }) {
  const at = formatInstant(value, { time, fallback });
  if (!at.iso) return <>{at.text}</>;
  return (
    <time dateTime={at.iso} title={at.utc} suppressHydrationWarning>
      {at.text}
    </time>
  );
}

/** Text that is dimmed, for rows that no longer act (revoked, expired keys). */
export function Dim({ dimmed, children }: { dimmed: boolean; children: ReactNode }) {
  return dimmed ? (
    <span data-dimmed="true" className="opacity-60">
      {children}
    </span>
  ) : (
    <>{children}</>
  );
}

/** First page and next page links of a keyset-paged list. */
export function PageLinks({ firstHref, nextHref }: { firstHref?: string; nextHref?: string | null }) {
  if (!firstHref && !nextHref) return null;
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3">
      {firstHref ? (
        <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
          <Link href={firstHref}>First page</Link>
        </Button>
      ) : (
        <span />
      )}
      {nextHref && (
        <Button asChild variant="outline" className="min-h-11 sm:min-h-8">
          <Link href={nextHref}>Next page</Link>
        </Button>
      )}
    </nav>
  );
}

/**
 * A problem shown inside a dialog (W04 FR-043). Besides the text of the code it offers what the code asks for: the link to
 * two-step setup (`mfa_required`, AS-49) and "End old secret now" (`rotation_in_progress`, AS-62).
 */
export function DialogProblem({
  problem,
  detail,
  returnTo,
  subject,
  resource,
  onEndOldSecret,
}: {
  problem: Problem;
  detail?: string;
  returnTo?: string;
  subject?: SellerProblemContext['subject'];
  resource?: SellerProblemContext['resource'];
  onEndOldSecret?: () => void;
}) {
  const context: SellerProblemContext = { place: 'dialog', detail, subject, resource };
  const copy = sellerProblemCopy(problem, context);
  return (
    <div className="space-y-2">
      <ProblemPanel problem={problem} context={context} />
      {copy.action === 'two-step' && returnTo && (
        <Button asChild variant="outline" size="sm" className="min-h-11 sm:min-h-7">
          <Link href={`/account/security?tab=two-step&returnTo=${encodeURIComponent(returnTo)}`}>Set up or verify two-step</Link>
        </Button>
      )}
      {copy.action === 'end-old-secret' && onEndOldSecret && (
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" onClick={onEndOldSecret}>
          End old secret now
        </Button>
      )}
    </div>
  );
}

/**
 * The messages that belong under form fields (`validation_failed` names its fields; a rejected or duplicate URL belongs to
 * `url`), and whether anything is left for an alert. A field the form does not have falls back to the alert.
 */
export function fieldMessages(problem: Problem | null, fields: readonly string[], detail?: string): { byField: Record<string, string>; alert: boolean } {
  if (!problem) return { byField: {}, alert: false };
  const copy = sellerProblemCopy(problem, { detail });
  if (copy.form !== 'field') return { byField: {}, alert: true };
  const byField: Record<string, string> = {};
  const named = problem.code === 'validation_failed' ? problem.errors.map((error) => error.field) : copy.field ? [copy.field] : [];
  for (const field of named) if (fields.includes(field)) byField[field] = copy.message;
  return { byField, alert: Object.keys(byField).length === 0 };
}

/** Error text under a field, tied to it with `aria-describedby` through the returned id. */
export function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {children}
    </p>
  );
}
