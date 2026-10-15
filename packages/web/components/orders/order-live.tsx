'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StreamBanner } from '@/components/checkout/stream-banner';
import { useUserEvents, type UserEventHandler } from '@/hooks/use-user-stream';
import { orderStatusText, shortOrderId } from '@/lib/orders/status';
import { queryKeys } from '@/lib/query-keys';

/**
 * The stream bridge of the orders screens (W03 AS-58, FR-050). `order.status` re-reads the shown order (`refresh`) and
 * makes one polite announcement per event; an event for an order that is not shown only marks its cached detail stale.
 * `payment.status` marks the detail stale too (the payment panel shows it). `resync` re-reads everything on the page.
 * Returns the sentence for the live region.
 */
export function useOrderLive({ isShown, refresh }: { isShown: (orderId: string) => boolean; refresh: () => void }): string {
  const client = useQueryClient();
  const [message, setMessage] = useState('');
  const seen = useRef(new Set<string>());
  const latest = useRef({ isShown, refresh });
  useEffect(() => {
    latest.current = { isShown, refresh };
  });

  const handler = useMemo<UserEventHandler>(
    () => ({
      onEvent: (event) => {
        if (event.type === 'payment.status') {
          void client.invalidateQueries({ queryKey: queryKeys.orders.detail(event.data.orderId) });
          return;
        }
        if (event.type !== 'order.status') return;
        const { orderId, status, orderVersion } = event.data;
        void client.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) });
        if (!latest.current.isShown(orderId)) return;
        latest.current.refresh();
        const key = `${orderId}:${orderVersion ?? status}`;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        setMessage(`Order #${shortOrderId(orderId)} is now ${orderStatusText(status)}`);
      },
      onResync: () => void client.invalidateQueries({ queryKey: queryKeys.orders.all }),
    }),
    [client],
  );
  useUserEvents(handler);
  return message;
}

/** The polite live region and the reconnect banner shared by the list and the detail. */
export function OrderLive({ message }: { message: string }) {
  return (
    <>
      <StreamBanner />
      <p role="status" aria-live="polite" className="sr-only">
        {message}
      </p>
    </>
  );
}

/** A stable callback that re-reads the query for `queryKey`. */
export function useRefresh(queryKey: readonly unknown[]): () => void {
  const client = useQueryClient();
  const key = JSON.stringify(queryKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the serialised key is the identity
  return useCallback(() => void client.invalidateQueries({ queryKey }), [client, key]);
}
