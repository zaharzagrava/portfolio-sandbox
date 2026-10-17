import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetUserStream } from '@/lib/realtime/user-stream';
import { installLiveStreamStub, type LiveStreamStub } from '@/lib/test/event-source-stub';
import { OTHER_SHOP_ID, SELLER_SHOP_ID, liveFrameFixture } from '@/lib/test/seller-handlers';
import { formatMoney } from '@/lib/utils';

const session = vi.hoisted(() => ({ refresh: vi.fn(), current: vi.fn() }));
vi.mock('@/lib/api/session', () => ({ sessionApi: session }));
const endSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/session-ended', () => ({ endSession, setSessionEndHandler: vi.fn(), rearmSessionEnd: vi.fn() }));

import { LivePanel } from './live-panel';

const topic = (shopId = SELLER_SHOP_ID) => `shop:${shopId}:live`;
let stub: LiveStreamStub;
let client: QueryClient;
let invalidate: { mock: { calls: unknown[][] } };

function mount(shopId = SELLER_SHOP_ID) {
  const view = (id: string) => (
    <QueryClientProvider client={client}>
      <LivePanel shopId={id} currency="EUR" />
    </QueryClientProvider>
  );
  const rendered = render(view(shopId));
  return { ...rendered, switchTo: (id: string) => rendered.rerender(view(id)) };
}

const frame = (overrides: Record<string, unknown> = {}, shopId = SELLER_SHOP_ID) => {
  act(() => stub.frame('dashboard', topic(shopId), liveFrameFixture({ shopId, ...overrides })));
};
const status = () => screen.getByRole('status');
const refetchesOf = (shopId = SELLER_SHOP_ID) =>
  invalidate.mock.calls.filter(([filter]) => JSON.stringify((filter as { queryKey?: unknown })?.queryKey ?? []).includes(`"${shopId}","overview"`)).length;
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
  stub = installLiveStreamStub();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(client, 'invalidateQueries');
  session.refresh.mockReset();
  session.current.mockReset();
  endSession.mockReset();
  session.refresh.mockResolvedValue({ ok: true, kind: 'session', session: { id: 'u' } });
  session.current.mockResolvedValue({ ok: true, kind: 'session', session: { id: 'u' } });
});

afterEach(() => {
  setVisibility('visible');
  resetUserStream();
  vi.useRealTimers();
});

describe('W04 live panel', () => {
  it('W04 AS-19: it opens the shop topic, says Connecting, then renders the last 60 seconds and says Live from the first frame', () => {
    mount();
    expect(stub.topics()).toContain(topic());
    expect(status()).toHaveTextContent('Connecting…');
    act(() => stub.open());
    frame();
    expect(status()).toHaveTextContent('Live');
    const panel = screen.getByRole('region', { name: 'Last 60 seconds' });
    expect(within(panel).getByText('Orders').parentElement).toHaveTextContent('2');
    expect(within(panel).getByText('Units').parentElement).toHaveTextContent('3');
    expect(within(panel).getByText('Checkouts').parentElement).toHaveTextContent('4');
    expect(within(panel).getByText('Revenue').parentElement).toHaveTextContent(formatMoney(15000, 'EUR'));
    frame({ last60s: { checkouts: 5, orders: 3, units: 4, revenueMinor: 25000 } });
    expect(within(panel).getByText('Orders').parentElement).toHaveTextContent('3');
    expect(within(panel).getByText('Revenue').parentElement).toHaveTextContent(formatMoney(25000, 'EUR'));
  });

  it('W04 AS-20: conversion shows an em dash when absent and a percentage with its hint when present', () => {
    mount();
    act(() => stub.open());
    frame({ checkoutConversion: null });
    const tile = () => screen.getByText('Checkout conversion').parentElement!;
    expect(tile()).toHaveTextContent('—');
    frame({ checkoutConversion: 1.5 });
    expect(tile()).toHaveTextContent('150 %');
    expect(tile()).toHaveTextContent('orders ÷ checkouts, last 60 s');
  });

  it('W04 AS-21: no frame for 5 seconds is Reconnecting with dimmed numbers and the last update time; frames bring Live back', () => {
    mount();
    act(() => stub.open());
    frame();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(status()).toHaveTextContent('Live');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(status()).toHaveTextContent('Reconnecting…');
    const panel = screen.getByRole('region', { name: 'Last 60 seconds' });
    expect(panel).toHaveAttribute('data-stale', 'true');
    expect(panel).toHaveTextContent(/Last updated \d{2}:\d{2}:\d{2}/);
    frame();
    expect(status()).toHaveTextContent('Live');
    expect(panel).not.toHaveAttribute('data-stale', 'true');
    expect(panel).not.toHaveTextContent('Last updated');
  });

  it('W04 AS-21: a dropped connection is Reconnecting at once, never old numbers as live', () => {
    mount();
    act(() => stub.open());
    frame();
    act(() => stub.reconnect(false));
    expect(status()).toHaveTextContent('Reconnecting…');
    expect(screen.getByRole('region', { name: 'Last 60 seconds' })).toHaveAttribute('data-stale', 'true');
  });

  it('W04 AS-21: a resync refetches the overview once', () => {
    mount();
    act(() => stub.open());
    frame();
    const before = refetchesOf();
    act(() => stub.resync());
    expect(refetchesOf()).toBe(before + 1);
  });

  it('W04 AS-21: revoked checks the session once and recreates the subscription; a member no longer admitted sees Unavailable', async () => {
    mount();
    act(() => stub.open());
    frame();
    await act(async () => {
      stub.revoked(topic());
      await Promise.resolve();
    });
    expect(session.current).toHaveBeenCalledTimes(1);
    expect(stub.connections()).toBe(1);
    expect(stub.topics()).toContain(topic());

    session.current.mockResolvedValue({ ok: false, status: 401, code: 'unauthenticated' });
    act(() => stub.open());
    await act(async () => {
      stub.revoked(topic());
      await Promise.resolve();
    });
    expect(screen.getByText("Live numbers aren't available right now. Showing today's totals.")).toBeInTheDocument();
  });

  it('W04 AS-22: a refused stream is recreated once after a session refresh; refused again, it falls back to polling today every 30 s', async () => {
    mount();
    act(() => stub.open());
    await act(async () => {
      stub.refuse();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(session.refresh).toHaveBeenCalledTimes(1);
    expect(stub.opened()).toBe(2);
    await act(async () => {
      stub.refuse();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Live numbers aren't available right now. Showing today's totals.")).toBeInTheDocument();
    expect(stub.opened()).toBe(2);
    const before = refetchesOf();
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(refetchesOf()).toBe(before);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(refetchesOf()).toBe(before + 1);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(refetchesOf()).toBe(before + 3);
    setVisibility('hidden');
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(refetchesOf()).toBe(before + 3);
  });

  it('W04 AS-23: a hidden tab closes the stream; coming back reopens it and refetches once', () => {
    mount();
    act(() => stub.open());
    frame();
    expect(stub.connections()).toBe(1);
    setVisibility('hidden');
    expect(stub.connections()).toBe(0);
    const before = refetchesOf();
    setVisibility('visible');
    expect(stub.connections()).toBe(1);
    expect(refetchesOf()).toBe(before + 1);
    expect(stub.topics()).toContain(topic());
  });

  it('W04 AS-24: frames with new orders refresh the period numbers at most once per 30 seconds', () => {
    mount();
    act(() => stub.open());
    const perSecond = () => Array.from({ length: 60 }, (_, i) => (i === 59 ? 1 : 0));
    for (let second = 0; second < 29; second += 1) {
      frame({ ordersPerSecond: perSecond() });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(refetchesOf()).toBeLessThanOrEqual(2);
    for (let second = 29; second < 65; second += 1) {
      frame({ ordersPerSecond: perSecond() });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    const total = refetchesOf();
    expect(total).toBeGreaterThanOrEqual(2);
    expect(total).toBeLessThanOrEqual(4);
  });

  it('W04 AS-24: frames without new orders refresh nothing', () => {
    mount();
    act(() => stub.open());
    for (let second = 0; second < 40; second += 1) {
      frame({ ordersPerSecond: Array.from({ length: 60 }, () => 0) });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(refetchesOf()).toBe(0);
  });

  it('W04 AS-25: one stream for the page, the topic swapped when the shop changes, released on leaving', () => {
    const view = mount();
    expect(stub.connections()).toBe(1);
    expect(stub.topics()).toEqual([topic()]);
    view.switchTo(OTHER_SHOP_ID);
    expect(stub.connections()).toBe(1);
    expect(stub.topics()).toEqual([topic(OTHER_SHOP_ID)]);
    view.unmount();
    expect(stub.connections()).toBe(0);
  });

  it('W04 AS-27: ticking values are in an aria-live="off" region; only the state is a polite status, once per change', () => {
    mount();
    act(() => stub.open());
    frame();
    const panel = screen.getByRole('region', { name: 'Last 60 seconds' });
    const values = panel.querySelector('[data-live-values]');
    expect(values).toHaveAttribute('aria-live', 'off');
    expect(status().closest('[aria-live="off"]')).toBeNull();
    expect(status()).toHaveTextContent(/^Live$/);
    expect(within(panel).getByRole('img', { name: '2 orders in the last 60 seconds' })).toBeInTheDocument();
    frame({ last60s: { checkouts: 9, orders: 7, units: 7, revenueMinor: 1 } });
    expect(status()).toHaveTextContent(/^Live$/);
    expect(status().textContent).not.toMatch(/\d/);
  });
});
