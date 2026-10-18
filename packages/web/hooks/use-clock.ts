'use client';

import { useEffect, useState } from 'react';

/** The current time (epoch ms), refreshed every `intervalMs`, so relative times ("2 min ago") stay right without a render of the page. */
export function useClock(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
