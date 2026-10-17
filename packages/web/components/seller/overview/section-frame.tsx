'use client';

import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/**
 * The chrome shared by the overview's sections (W04 FR-017, AS-17): a named region with a heading, and the section's own
 * failure message with "Try again" in place of its content, so one failed section never blanks the others.
 */
export function SectionFrame({ title, busy = false, className, children }: { title: string; busy?: boolean; className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} aria-busy={busy || undefined} className={`space-y-3 rounded-xl border bg-card p-4 ${busy ? 'opacity-70' : ''} ${className ?? ''}`}>
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function SectionUnavailable({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{text}</p>
      <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export const SALES_UNAVAILABLE = 'Sales numbers are temporarily unavailable.';

/** Mon d, yyyy of a `yyyy-mm-dd` UTC day, the same on the server and in the browser. */
export function formatDay(day: string, short = false): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(short ? {} : { year: 'numeric' }) });
}
