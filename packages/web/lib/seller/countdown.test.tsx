import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCountdown } from './countdown';

describe('W04 AS-90 useCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down once per second and re-enables at 0', () => {
    const { result } = renderHook(() => useCountdown(3));
    expect(result.current).toMatchObject({ remaining: 3, active: true });
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.remaining).toBe(2);
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current).toMatchObject({ remaining: 0, active: false });
  });

  it('is idle without seconds', () => {
    for (const seconds of [undefined, null, 0, -4, Number.NaN]) {
      const { result } = renderHook(() => useCountdown(seconds));
      expect(result.current).toMatchObject({ remaining: 0, active: false, announcement: '' });
    }
  });

  it('R-18: the polite announcement changes only at the start and at the end, never per tick', () => {
    const { result } = renderHook(() => useCountdown(4));
    const seen = [result.current.announcement];
    for (let i = 0; i < 5; i += 1) {
      act(() => void vi.advanceTimersByTime(1000));
      seen.push(result.current.announcement);
    }
    expect([...new Set(seen)]).toEqual(['Try again in 4 seconds.', 'You can try again now.']);
  });

  it('rounds fractional seconds up and starts again when the token changes', () => {
    const { result, rerender } = renderHook(({ token }) => useCountdown(1.2, token), { initialProps: { token: 1 } });
    expect(result.current.remaining).toBe(2);
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current.active).toBe(false);
    rerender({ token: 2 });
    expect(result.current).toMatchObject({ remaining: 2, active: true });
  });

  it('stops its timer on unmount', () => {
    const { unmount } = renderHook(() => useCountdown(30));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
