'use client';

import { useEffect, useState } from 'react';

/**
 * Whether `deadline` (epoch milliseconds) has passed; re-renders at that instant by a timer, never by polling. `null` means no
 * wait is running. Used for the waits a `Retry-After` asks for and for a mute that ends (W05 FR-063, AS-18, AS-19).
 */
export function useDeadlinePassed(deadline: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(deadline - Date.now(), 0) + 1);
    return () => clearTimeout(timer);
  }, [deadline]);
  return deadline === null || now > deadline;
}
