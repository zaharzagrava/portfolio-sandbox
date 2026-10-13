import type { TopWindow } from '@marketplace-sandbox/contracts';

/** Top windows of FR-034: `day` 24 h, `week` 7 d, `month` 30 d, `year` 365 d, `all` unbounded. */
const WINDOW_DAYS: Record<Exclude<TopWindow, 'all'>, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

const DAY_MS = 86_400_000;

/** The inclusive start of a window, or `null` for `all`. */
export function topWindowStart(window: TopWindow, now: Date): Date | null {
  return window === 'all'
    ? null
    : new Date(now.getTime() - WINDOW_DAYS[window] * DAY_MS);
}

export function isInTopWindow(
  window: TopWindow,
  createdAt: Date,
  now: Date,
): boolean {
  const start = topWindowStart(window, now);
  return start === null || createdAt.getTime() >= start.getTime();
}
