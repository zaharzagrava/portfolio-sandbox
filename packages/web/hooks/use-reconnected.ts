'use client';

import { useEffect, useRef } from 'react';
import { getUserStreamSnapshot, subscribeUserStreamState } from '@/lib/realtime/user-stream';

/**
 * Calls `onReconnected` when the browser comes back online and when the shared live connection opens again after it was not
 * open (W05 AS-17: "Not sent" bubbles that failed for lack of a network are retried once, oldest first, at those moments).
 */
export function useReconnected(onReconnected: () => void): void {
  const latest = useRef(onReconnected);
  useEffect(() => {
    latest.current = onReconnected;
  });
  useEffect(() => {
    let connected = getUserStreamSnapshot().health === 'connected';
    const unsubscribe = subscribeUserStreamState(() => {
      const now = getUserStreamSnapshot().health === 'connected';
      if (now && !connected) latest.current();
      connected = now;
    });
    const online = () => latest.current();
    window.addEventListener('online', online);
    return () => {
      unsubscribe();
      window.removeEventListener('online', online);
    };
  }, []);
}
