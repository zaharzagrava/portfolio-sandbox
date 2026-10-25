'use client';

import { useSyncExternalStore } from 'react';
import { formatInstant } from '@/lib/seller/format-date';

const subscribe = () => () => {};

/**
 * A server timestamp in the viewer's time zone (W04 assumptions, "Time"). The server does not know the viewer's zone, so
 * the server render and the first client paint show the UTC reading (identical on both sides, no hydration mismatch) and
 * the browser then switches to its own zone. The tooltip always carries the UTC instant.
 */
export function LocalTime({ value, time = true }: { value: string | null | undefined; time?: boolean }) {
  const inBrowser = useSyncExternalStore(subscribe, () => true, () => false);
  const at = formatInstant(value, { time, ...(inBrowser ? {} : { timeZone: 'UTC' }) });
  return (
    <time dateTime={at.iso} title={at.utc}>
      {at.text}
    </time>
  );
}
