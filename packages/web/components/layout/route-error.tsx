'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { StateMessage } from '@/components/layout/system-states';

/**
 * The error boundary of a storefront route (W02 FR-161): the generic sentence, a reference (only the server digest) and
 * **Try again**. The message and stack of the error are never shown (constitution V.3).
 */
export function RouteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // The digest ties this to the server log; the message itself stays out of the page.
    console.error(error.digest ?? 'route error');
  }, [error]);
  return (
    <StateMessage
      alert
      focusHeading
      title="Something went wrong"
      description="This page ran into a problem. Try again."
      reference={error.digest}
      actions={
        <>
          <Button size="lg" onClick={() => retry()}>
            Try again
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href="/">Go to home</Link>
          </Button>
        </>
      }
    />
  );
}
