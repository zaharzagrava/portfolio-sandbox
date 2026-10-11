'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { GENERIC_ERROR_TEXT, StateMessage } from '@/components/layout/system-states';

/** Contains a failure to `<main>`: only the server digest is shown, never the message, stack or address (V.3). */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void; reset?: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StateMessage
      alert
      focusHeading
      title="Something went wrong"
      description={GENERIC_ERROR_TEXT}
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
