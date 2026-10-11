'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';

/** **Try again** for a page that failed to load: asks the server for the page again. */
export function RetryButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="lg" disabled={pending} onClick={() => start(() => router.refresh())}>
      Try again
    </Button>
  );
}
