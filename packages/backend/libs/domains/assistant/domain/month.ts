import type { Clock } from './assistant-ports';

/** Allowance month (UTC, S46 AS-34). Time comes from the injected clock only (G23). */
export function monthKey(clock: Clock): string {
  const now = clock.now();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${String(now.getUTCFullYear()).padStart(4, '0')}${month}`;
}

/** First instant of the next UTC month. */
export function monthResetsAt(clock: Clock): Date {
  const now = clock.now();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** `Retry-After` seconds until the month ends; never below 1. */
export function retryAfterSeconds(clock: Clock): number {
  const ms = monthResetsAt(clock).getTime() - clock.now().getTime();
  return Math.max(1, Math.ceil(ms / 1000));
}
