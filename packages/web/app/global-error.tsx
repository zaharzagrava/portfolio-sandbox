'use client';

import './globals.css';
import { useEffect, useRef } from 'react';
import { track } from '@/lib/analytics/track';
import { ERROR_PAGE } from '@/lib/routes/page-name';

const GENERIC_TEXT = 'We hit an unexpected problem. Try again, and if it keeps happening come back in a few minutes.';
const DARK = '[@media(prefers-color-scheme:dark)]';

const control = 'inline-flex min-h-11 items-center justify-center rounded-md px-5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2';

/**
 * Replaces the root layout when it fails, so it brings its own document and depends on nothing that may be broken
 * (no providers, no theme provider): it follows the operating system's colour scheme.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void; reset?: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    console.error(error);
    heading.current?.focus();
    // The layout (and its PageView) is gone: this is the one page view of a root error (AS-35).
    track({ name: 'page_view', page: ERROR_PAGE });
  }, [error]);

  return (
    <html lang="en">
      <body className={`flex min-h-screen items-center justify-center bg-white px-4 text-neutral-900 ${DARK}:bg-neutral-950 ${DARK}:text-neutral-50`}>
        <main role="alert" className="flex max-w-prose flex-col items-center gap-4 text-center">
          <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none md:text-3xl">
            Something went wrong
          </h1>
          <p className={`text-neutral-600 ${DARK}:text-neutral-300`}>{GENERIC_TEXT}</p>
          {error.digest && <p className="select-text text-sm text-neutral-600 [@media(prefers-color-scheme:dark)]:text-neutral-300">Reference: {error.digest}</p>}
          <div className="flex flex-wrap justify-center gap-3">
            <button type="button" onClick={() => retry()} className={`${control} bg-neutral-900 text-white ${DARK}:bg-white ${DARK}:text-neutral-900`}>
              Try again
            </button>
            {/* A plain link: the router may be what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className={`${control} border border-neutral-400`}>
              Go to home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
