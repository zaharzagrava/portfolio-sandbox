'use client';

import { useRef } from 'react';
import { newIdempotencyKey } from '@/lib/api/idempotency';

/**
 * One write attempt of a form (W02 AS-46, FR-083): the `Idempotency-Key` is made when the attempt starts, kept for every
 * retry of the unchanged form and dropped after a success or an edit. `begin()` also refuses a second press while the
 * first is still running (a double click posts once).
 */
export function useWriteAttempt() {
  const key = useRef<string | null>(null);
  const running = useRef(false);
  return {
    /** The key of this attempt, or `null` when one is already running. */
    begin(): string | null {
      if (running.current) return null;
      running.current = true;
      key.current ??= newIdempotencyKey();
      return key.current;
    },
    end(): void {
      running.current = false;
    },
    /** The text changed or the write succeeded: the next attempt is a new one. */
    renew(): void {
      key.current = null;
    },
  };
}
