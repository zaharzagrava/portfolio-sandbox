'use client';

import { useEffect, useState } from 'react';

export type Countdown = {
  /** Whole seconds left; `0` when idle or finished. */
  remaining: number;
  active: boolean;
  /**
   * For one polite status region: it changes twice only (at the start, at the end), so a screen reader hears two
   * announcements and not one per tick (W04 AS-90, R-18). Empty while idle.
   */
  announcement: string;
};

const seconds = (value: number | null | undefined): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0);

/**
 * Counts `value` seconds down to 0 (a `429`'s `Retry-After`). It starts again when `value` or `token` changes (pass a new
 * `token` per refusal when the same number can come twice). The remaining time is computed from a deadline, so a throttled
 * background tab catches up.
 */
export function useCountdown(value: number | null | undefined, token?: unknown): Countdown {
  const initial = seconds(value);
  const [seen, setSeen] = useState({ initial, token });
  const [remaining, setRemaining] = useState(initial);
  const [phase, setPhase] = useState<'idle' | 'running' | 'ended'>(initial > 0 ? 'running' : 'idle');

  if (seen.initial !== initial || seen.token !== token) {
    setSeen({ initial, token });
    setRemaining(initial);
    setPhase(initial > 0 ? 'running' : 'idle');
  }

  useEffect(() => {
    if (initial <= 0) return;
    const deadline = Date.now() + initial * 1000;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) {
        setPhase('ended');
        clearInterval(timer);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [initial, token]);

  const announcement = phase === 'running' ? `Try again in ${initial} ${initial === 1 ? 'second' : 'seconds'}.` : phase === 'ended' ? 'You can try again now.' : '';
  return { remaining, active: remaining > 0, announcement };
}
