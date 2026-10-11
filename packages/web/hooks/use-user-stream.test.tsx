import type { ReactNode } from 'react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installEventSourceStub, type EventSourceStub } from '@/tests/stubs/event-source';
import { queryKeys } from '@/lib/query-keys';
import { resetUserStream } from '@/lib/realtime/user-stream';
import { useStreamBanner, useStreamFallback, useUserEvents, useUserStream } from './use-user-stream';

const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ORDER = '7f1c0b1e-8f5e-4d7e-9a53-0d6a5b1f2c01';

function wrapper(signedIn = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (signedIn) client.setQueryData(queryKeys.auth.session(), { id: USER, email: 'a@b.co', role: 'USER' });
  else client.setQueryData(queryKeys.auth.session(), null);
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

describe('user stream hooks', () => {
  let es: EventSourceStub;
  beforeEach(() => {
    vi.useFakeTimers();
    es = installEventSourceStub();
  });
  afterEach(() => {
    resetUserStream();
    es.restore();
    vi.useRealTimers();
  });

  it('W03 AS-72: useUserEvents opens the shared stream for the signed-in user and unsubscribes on unmount', () => {
    const Wrapper = wrapper();
    const a = renderHook(() => useUserEvents({ onEvent: vi.fn() }), { wrapper: Wrapper });
    const b = renderHook(() => useUserEvents({ onEvent: vi.fn() }), { wrapper: Wrapper });
    expect(es.all).toHaveLength(1);
    expect(es.last().url).toBe(`/api/streams?topics=user:${USER}`);
    a.unmount();
    expect(es.live()).toHaveLength(1);
    b.unmount();
    expect(es.live()).toHaveLength(0);
  });

  it('W03 AS-72: an anonymous visitor opens no connection', () => {
    renderHook(() => useUserEvents({ onEvent: vi.fn() }), { wrapper: wrapper(false) });
    expect(es.all).toHaveLength(0);
  });

  it('W03 AS-58: the latest handler is called without resubscribing on re-render', () => {
    const Wrapper = wrapper();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => useUserEvents({ onEvent: fn }), { wrapper: Wrapper, initialProps: { fn: first } });
    rerender({ fn: second });
    expect(es.all).toHaveLength(1);
    es.last().open();
    es.last().emit('order.status', { topic: `user:${USER}`, data: { orderId: ORDER, status: 'PAID' } });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('W03 AS-45: useUserStream reports health as the connection changes', () => {
    const Wrapper = wrapper();
    renderHook(() => useUserEvents({}), { wrapper: Wrapper });
    const { result } = renderHook(() => useUserStream(), { wrapper: Wrapper });
    expect(result.current.health).toBe('closed');
    act(() => es.last().open());
    expect(result.current.health).toBe('connected');
    act(() => es.last().fail());
    expect(result.current.health).toBe('reconnecting');
  });

  it('W03 AS-45: useStreamBanner is true for one component only, while reconnecting', () => {
    const Wrapper = wrapper();
    renderHook(() => useUserEvents({}), { wrapper: Wrapper });
    const one = renderHook(() => useStreamBanner(), { wrapper: Wrapper });
    const two = renderHook(() => useStreamBanner(), { wrapper: Wrapper });
    act(() => es.last().open());
    expect([one.result.current, two.result.current]).toEqual([false, false]);
    act(() => es.last().fail());
    expect([one.result.current, two.result.current]).toEqual([true, false]);
    one.unmount();
    expect(two.result.current).toBe(true);
    act(() => es.last().open());
    expect(two.result.current).toBe(false);
  });

  it('W03 AS-39: useStreamFallback polls after 10 s of silence, reports stopped, and checkAgain restarts it', async () => {
    const Wrapper = wrapper();
    renderHook(() => useUserEvents({}), { wrapper: Wrapper });
    const poll = vi.fn();
    const { result, rerender } = renderHook(({ active }) => useStreamFallback(poll, active), { wrapper: Wrapper, initialProps: { active: true } });
    expect(result.current.state).toBe('idle');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('polling');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(330_000);
    });
    expect(result.current.state).toBe('stopped');
    act(() => result.current.checkAgain());
    expect(result.current.state).toBe('polling');
    rerender({ active: false });
    expect(result.current.state).toBe('idle');
  });
});
