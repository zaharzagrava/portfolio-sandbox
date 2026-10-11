import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePayFlow } from './use-pay-flow';

const pending = { payment: null, orderStatus: 'RESERVED' } as const;

describe('usePayFlow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('W03 AS-38: walks idle -> tokenizing -> submitting -> processing through send()', () => {
    const { result } = renderHook(() => usePayFlow(pending));
    expect(result.current.phase).toBe('idle');
    act(() => result.current.send('PRESS_PAY'));
    act(() => result.current.send('TOKEN_READY'));
    expect(result.current.phase).toBe('submitting');
    act(() => result.current.send('ACCEPTED'));
    expect(result.current.phase).toBe('processing');
  });

  it('W03 AS-38: an impossible event leaves the phase alone', () => {
    const { result } = renderHook(() => usePayFlow(pending));
    act(() => result.current.send('ORDER_PAID'));
    expect(result.current.phase).toBe('idle');
  });

  it('W03 AS-39: a page loaded during a payment resumes it', () => {
    const { result } = renderHook(() => usePayFlow({ payment: { status: 'PENDING', requiresAction: false }, orderStatus: 'RESERVED' }));
    expect(result.current.phase).toBe('processing');
  });

  it('W03 AS-46: sync() follows server data; COMPLETED on an unpaid order is confirming, then completed when PAID', () => {
    const { result } = renderHook(() => usePayFlow({ payment: { status: 'PENDING', requiresAction: false }, orderStatus: 'RESERVED' }));
    act(() => result.current.sync({ payment: { status: 'COMPLETED', requiresAction: false }, orderStatus: 'RESERVED' }));
    expect(result.current.phase).toBe('confirming');
    act(() => result.current.sync({ payment: { status: 'COMPLETED', requiresAction: false }, orderStatus: 'PAID' }));
    expect(result.current.phase).toBe('completed');
  });

  it('W03 AS-46: after 60 seconds in confirming the slow hint appears, never before, never in other phases', () => {
    const { result } = renderHook(() => usePayFlow({ payment: { status: 'COMPLETED', requiresAction: false }, orderStatus: 'RESERVED' }));
    expect(result.current.phase).toBe('confirming');
    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(result.current.slowConfirming).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.slowConfirming).toBe(true);
    act(() => result.current.sync({ payment: { status: 'COMPLETED', requiresAction: false }, orderStatus: 'PAID' }));
    expect(result.current.phase).toBe('completed');
    expect(result.current.slowConfirming).toBe(false);
  });

  it('W03 AS-43: view tells when the order ended, whatever the phase', () => {
    const { result } = renderHook(() => usePayFlow({ payment: { status: 'COMPLETED', requiresAction: false }, orderStatus: 'CANCELLED' }));
    expect(result.current.view).toEqual({ kind: 'order-ended', reason: 'cancelled', paymentArrivedLate: true });
  });
});
