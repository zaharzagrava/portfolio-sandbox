/**
 * A counting semaphore over events: at most `max` events are inside handlers at once (S53 FR-028, default 500).
 * Waiters are served in arrival order; a request larger than the limit is clamped so it can never starve.
 */
export class InFlightLimiter {
  private used = 0;
  private readonly waiters: { count: number; wake: () => void }[] = [];

  constructor(private readonly max: number) {}

  get inFlight(): number {
    return this.used;
  }

  async acquire(count: number): Promise<() => void> {
    const need = Math.min(Math.max(count, 1), this.max);
    while (this.used + need > this.max)
      await new Promise<void>((wake) =>
        this.waiters.push({ count: need, wake }),
      );
    this.used += need;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= need;
      // Everyone re-checks the freed capacity; those that still do not fit queue again.
      for (const waiter of this.waiters.splice(0)) waiter.wake();
    };
  }
}
