'use client';

import Link from 'next/link';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { Problem } from '@/lib/problem';

export const GENERIC_ERROR_TEXT = 'We hit an unexpected problem. Try again, and if it keeps happening come back in a few minutes.';
const UNAVAILABLE_TEXT = 'This part of the marketplace is temporarily unavailable. Try again in a moment.';
const CLIENT_ERROR_TEXT = "Something didn't work. Check the details and try again.";

/** One centred message block: heading, text, optional reference line and actions. Text only, never markup. */
export function StateMessage({
  title,
  description,
  reference,
  actions,
  alert = false,
  focusHeading = false,
  headingId,
}: {
  title: string;
  description: ReactNode;
  reference?: string;
  actions?: ReactNode;
  /** Announce the state (`role="alert"`). */
  alert?: boolean;
  /** Move focus to the heading when the state appears (error boundaries). */
  focusHeading?: boolean;
  headingId?: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading, title, reference]);

  return (
    <section role={alert ? 'alert' : undefined} className="container mx-auto flex flex-col items-center gap-4 px-4 py-16 text-center md:px-6">
      <h1 ref={heading} id={headingId} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none md:text-3xl">
        {title}
      </h1>
      <p className="max-w-prose text-muted-foreground">{description}</p>
      {reference && <p className="select-text text-sm text-muted-foreground">Reference: {reference}</p>}
      {actions && <div className="flex flex-wrap items-center justify-center gap-3">{actions}</div>}
    </section>
  );
}

const homeLink = (
  <Button asChild size="lg">
    <Link href="/">Go to home</Link>
  </Button>
);

export function NotFoundState({ title, description, actions }: { title?: string; description?: ReactNode; actions?: ReactNode } = {}) {
  return (
    <StateMessage
      title={title ?? 'Page not found'}
      description={description ?? "We couldn't find the page you were looking for. It may have moved, or the address may be wrong."}
      actions={
        actions ?? (
          <>
            {homeLink}
            <Button asChild variant="outline" size="lg">
              <Link href="/search">Browse products</Link>
            </Button>
          </>
        )
      }
    />
  );
}

export function AccessDeniedState() {
  return (
    <StateMessage
      alert
      title="You don't have access"
      description="Your account can't open this page. If you think this is a mistake, contact the shop owner or an administrator."
      actions={homeLink}
    />
  );
}

/** "{n} seconds" below a minute, whole minutes below an hour (rounded up), otherwise whole hours (W01 FR-041). */
export function waitText(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds < 60) return unit(Math.max(1, Math.ceil(seconds)), 'second');
  if (seconds < 3600) return unit(Math.ceil(seconds / 60), 'minute');
  return unit(Math.ceil(seconds / 3600), 'hour');
}

/**
 * The one place a failed call is shown when a screen has no dedicated place for it (AS-13). Text comes only from the
 * status class; the server's `title`/`detail` are never rendered.
 */
export function ErrorState({ problem, reference, onRetry }: { problem?: Problem; reference?: string; onRetry?: () => void }) {
  const status = problem?.status ?? 0;
  const ref = reference ?? problem?.requestId;
  const retry = onRetry && (
    <Button size="lg" onClick={onRetry}>
      Try again
    </Button>
  );

  if (status === 401) return null;
  if (status === 403) return <AccessDeniedState />;
  if (status === 404) return <NotFoundState />;
  if (status === 409)
    return (
      <StateMessage
        alert
        title="Something changed"
        description="This changed while you were looking at it. Reload and try again."
        actions={
          <Button size="lg" onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
      />
    );
  if (status === 429)
    return (
      <StateMessage
        alert
        title="Too many requests"
        description={problem?.retryAfterSeconds === undefined ? 'Too many requests. Try again later.' : `Too many requests. Try again in ${waitText(problem.retryAfterSeconds)}.`}
      />
    );
  if (status >= 400 && status < 500) return <StateMessage alert title="That didn't work" description={CLIENT_ERROR_TEXT} />;
  if (status === 502 || status === 503)
    return <StateMessage alert title="Temporarily unavailable" description={UNAVAILABLE_TEXT} reference={ref} actions={retry} />;
  return <StateMessage alert title="Something went wrong" description={GENERIC_ERROR_TEXT} reference={ref} actions={retry} />;
}
