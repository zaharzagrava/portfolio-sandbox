'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LiveDashboardFrame } from '@marketplace-sandbox/contracts';
import { sessionApi } from '@/lib/api/session';
import { queryKeys } from '@/lib/query-keys';
import { getUserStreamSnapshot, parseLiveFrame, subscribeTopic, subscribeUserStreamState } from '@/lib/realtime/user-stream';
import { formatClock } from '@/lib/seller/format-date';
import { formatMoney } from '@/lib/utils';
import { LIVE_STALE_MS, PERIOD_INVALIDATE_MIN_MS, TODAY_POLL_MS } from './constants';

/**
 * The live panel of the overview (W04 FR-020..FR-024, AS-19..AS-25, AS-27): the last 60 seconds of the shop from
 * `shop:{shopId}:live`, on the page's single shared stream. The numbers are never presented as live once frames stop: the
 * panel says "Reconnecting…", dims them and shows when they were last updated. Frames that show a new order refresh the
 * period numbers at most once per 30 s; a refused stream falls back to refetching "Today (UTC)" every 30 s.
 */

type Connection = 'connecting' | 'live' | 'reconnecting' | 'unavailable';
type PanelState = { key: string; connection: Connection; frame: LiveDashboardFrame | null; lastAt: number | null };

const UNAVAILABLE_TEXT = "Live numbers aren't available right now. Showing today's totals.";
const STATUS_TEXT: Record<Exclude<Connection, 'unavailable'>, string> = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' };
const initial = (key: string): PanelState => ({ key, connection: 'connecting', frame: null, lastAt: null });

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}
const isVisible = () => document.visibilityState !== 'hidden';

function Spark({ perSecond, orders, at }: { perSecond: readonly number[]; orders: number; at: number }) {
  const peak = Math.max(1, ...perSecond);
  return (
    <svg role="img" aria-label={`${orders} ${orders === 1 ? 'order' : 'orders'} in the last 60 seconds`} viewBox="0 0 120 24" preserveAspectRatio="none" className="h-8 w-full text-primary">
      {perSecond.map((count, index) => {
        const height = count === 0 ? 1 : Math.max(3, (count / peak) * 24);
        // the bar's own second (epoch seconds) is its identity
        return <rect key={at - (perSecond.length - 1 - index)} x={index * 2} y={24 - height} width={1.4} height={height} fill="currentColor" opacity={count === 0 ? 0.25 : 1} />;
      })}
    </svg>
  );
}

function Value({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{children}</dd>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function LivePanel({ shopId, currency }: { shopId: string; currency?: string }) {
  const queryClient = useQueryClient();
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, () => true);
  const [epoch, setEpoch] = useState(0);
  const key = `${shopId}:${epoch}`;
  const [state, setState] = useState<PanelState>(() => initial(key));
  const current = state.key === key ? state : initial(key);

  // The stream: one subscription for this shop, only while the tab is visible.
  useEffect(() => {
    if (!visible) return;
    const topic = `shop:${shopId}:live`;
    const patch = (change: Partial<PanelState>) => setState((s) => ({ ...(s.key === key ? s : initial(key)), ...change }));
    let lastRefetch = -Infinity;
    const refetch = () => {
      lastRefetch = Date.now();
      void queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'overview') });
    };
    let lastFrameAt = Date.now();
    let trailing: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    let seenActive = false;

    const refreshAfterOrder = () => {
      const wait = PERIOD_INVALIDATE_MIN_MS - (Date.now() - lastRefetch);
      if (wait <= 0) refetch();
      else trailing ??= setTimeout(() => {
        trailing = undefined;
        refetch();
      }, wait);
    };

    const onRevoked = async () => {
      let admitted = false;
      try {
        const result = await sessionApi.current();
        admitted = result.ok && result.kind === 'session';
      } catch {
        admitted = false;
      }
      if (!active) return;
      if (admitted && epoch < 1) setEpoch((n) => n + 1);
      else patch({ connection: 'unavailable' });
    };

    const unwatch = subscribeUserStreamState(() => {
      const { health } = getUserStreamSnapshot();
      if (health === 'reconnecting') {
        seenActive = true;
        patch({ connection: 'reconnecting' });
      } else if (health === 'connected') {
        seenActive = true;
      } else if (seenActive) {
        patch({ connection: 'unavailable' });
      }
    });
    const release = subscribeTopic(topic, (event) => {
      if (event.type === 'dashboard') {
        const frame = parseLiveFrame(event.data);
        if (!frame) return;
        lastFrameAt = Date.now();
        patch({ connection: 'live', frame, lastAt: lastFrameAt });
        if ((frame.ordersPerSecond.at(-1) ?? 0) > 0) refreshAfterOrder();
      } else if (event.type === 'resync') {
        refetch();
      } else if (event.type === 'revoked') {
        void onRevoked();
      }
    });
    const watchdog = setInterval(() => {
      if (Date.now() - lastFrameAt > LIVE_STALE_MS) setState((s) => (s.key === key && s.connection === 'live' ? { ...s, connection: 'reconnecting' } : s));
    }, 1000);

    return () => {
      active = false;
      unwatch();
      clearInterval(watchdog);
      clearTimeout(trailing);
      release();
    };
  }, [shopId, visible, epoch, key, queryClient]);

  // Coming back to a hidden tab reads the page's numbers once.
  useEffect(() => {
    let wasHidden = !isVisible();
    const onChange = () => {
      if (!isVisible()) {
        wasHidden = true;
      } else if (wasHidden) {
        wasHidden = false;
        void queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'overview') });
      }
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [shopId, queryClient]);

  // A refused stream: "Today (UTC)" is read again every 30 s while the tab is visible.
  const unavailable = current.connection === 'unavailable';
  useEffect(() => {
    if (!unavailable || !visible) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.seller.scope(shopId, 'overview') });
    }, TODAY_POLL_MS);
    return () => clearInterval(timer);
  }, [unavailable, visible, shopId, queryClient]);

  const { frame, connection } = current;
  const stale = connection === 'reconnecting';
  const money = (minor: number) => (currency ? formatMoney(minor, currency) : '—');
  const conversion = frame?.checkoutConversion;

  return (
    <section aria-labelledby="live-heading" data-stale={stale ? 'true' : undefined} className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="live-heading" className="text-base font-semibold">
          Last 60 seconds
        </h2>
        <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span aria-hidden="true" className={`size-2 rounded-full ${connection === 'live' ? 'bg-green-500' : 'bg-muted-foreground/50'}`} />
          {connection === 'unavailable' ? UNAVAILABLE_TEXT : STATUS_TEXT[connection]}
        </p>
      </div>
      {!unavailable && (
        <div data-live-values aria-live="off" className={stale ? 'space-y-3 text-muted-foreground' : 'space-y-3'}>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Value label="Checkouts">{frame ? frame.last60s.checkouts : '—'}</Value>
            <Value label="Orders">{frame ? frame.last60s.orders : '—'}</Value>
            <Value label="Units">{frame ? frame.last60s.units : '—'}</Value>
            <Value label="Revenue">{frame ? money(frame.last60s.revenueMinor) : '—'}</Value>
            <Value label="Checkout conversion" hint={typeof conversion === 'number' ? 'orders ÷ checkouts, last 60 s' : undefined}>
              {typeof conversion === 'number' ? `${Math.round(conversion * 100)} %` : '—'}
            </Value>
          </dl>
          {frame && <Spark perSecond={frame.ordersPerSecond} orders={frame.last60s.orders} at={frame.at} />}
        </div>
      )}
      {stale && current.lastAt !== null && <p className="text-xs text-muted-foreground">Last updated {formatClock(current.lastAt)}</p>}
    </section>
  );
}
