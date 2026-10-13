import { Clock } from '@app/common/core/clock';

/**
 * The injected clock of the notifications e2e specs. It runs with real time (shifted by whatever the spec set or
 * advanced), because the rate limiter, cache TTLs and token buckets read the same injected clock and would stall on a
 * frozen one. A spec that needs exact instants calls `freeze()` (time stands still until `thaw()`), `set()` (jumps, then
 * keeps running) or `advance()` (moves forward by an exact amount).
 */
export class TestClock extends Clock {
  private offsetMs = 0;
  private frozenAt: number | null = null;

  now(): Date {
    return new Date(this.frozenAt ?? Date.now() + this.offsetMs);
  }

  /** Jumps to `date`; keeps running from there unless frozen. */
  set(date: Date): void {
    if (this.frozenAt !== null) this.frozenAt = date.getTime();
    else this.offsetMs = date.getTime() - Date.now();
  }

  advance(ms: number): void {
    if (this.frozenAt !== null) this.frozenAt += ms;
    else this.offsetMs += ms;
  }

  /** Time stands still at the current instant. */
  freeze(): void {
    this.frozenAt = this.now().getTime();
  }

  /** Time runs again from the frozen instant. */
  thaw(): void {
    if (this.frozenAt === null) return;
    this.offsetMs = this.frozenAt - Date.now();
    this.frozenAt = null;
  }

  /** Back to real time. */
  reset(): void {
    this.offsetMs = 0;
    this.frozenAt = null;
  }
}
