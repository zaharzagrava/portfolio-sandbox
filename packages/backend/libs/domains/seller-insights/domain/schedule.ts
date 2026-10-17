export const CRAWL_STATUSES = [
  'ok',
  'unchanged',
  'no_price',
  'out_of_stock',
  'disallowed_by_robots',
  'robots_unavailable',
  'gone',
  'blocked_by_site',
  'http_4xx',
  'http_429',
  'http_503',
  'http_5xx',
  'http_3xx',
  'history_unavailable',
  'blocked_address',
  'unresolvable',
  'invalid_url',
  'redirect_refused',
  'redirected_host',
  'too_many_redirects',
  'unsupported_content_type',
  'timeout',
  'tls_error',
  'network_error',
] as const;

export type CrawlStatus = (typeof CRAWL_STATUSES)[number];

/** Streak counters AFTER the crawl being scheduled has been applied. */
export interface ScheduleState {
  unchangedStreak: number;
  errorStreak: number;
  noPriceStreak: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const MIN_INTERVAL_MS = HOUR;
const JITTER = 0.1;
const NO_PRICE_STREAK_FOR_SLOWDOWN = 3;
const MAX_RETRY_AFTER_SEC = 3600;

function assertNever(value: never): never {
  throw new Error(`unhandled crawl status: ${String(value)}`);
}

const doubling = (baseMs: number, capMs: number, streak: number): number =>
  Math.min(capMs, baseMs * 2 ** Math.max(0, streak - 1));

function baseIntervalMs(status: CrawlStatus, state: ScheduleState): number {
  switch (status) {
    case 'ok':
      return 6 * HOUR;
    case 'unchanged':
      return state.unchangedStreak <= 1
        ? 12 * HOUR
        : state.unchangedStreak === 2
          ? 24 * HOUR
          : 48 * HOUR;
    case 'no_price':
    case 'out_of_stock':
      return state.noPriceStreak >= NO_PRICE_STREAK_FOR_SLOWDOWN
        ? 24 * HOUR
        : 6 * HOUR;
    case 'disallowed_by_robots':
    case 'blocked_by_site':
    case 'blocked_address':
    case 'invalid_url':
    case 'redirect_refused':
    case 'redirected_host':
    case 'too_many_redirects':
    case 'unsupported_content_type':
    case 'http_3xx':
      return 24 * HOUR;
    case 'robots_unavailable':
      return HOUR;
    case 'gone':
      return doubling(12 * HOUR, 48 * HOUR, state.errorStreak);
    case 'http_4xx':
      return 12 * HOUR;
    case 'http_5xx':
    case 'network_error':
    case 'timeout':
    case 'unresolvable':
    case 'tls_error':
      return doubling(HOUR, 24 * HOUR, state.errorStreak);
    case 'http_429':
    case 'http_503':
      return 6 * HOUR;
    case 'history_unavailable':
      return 15 * MIN;
    default:
      return assertNever(status);
  }
}

/**
 * Delay until the next crawl of a target. `state` holds the streaks after the
 * crawl that produced `status`. A `rand` in [0, 1) maps to a jitter of
 * 0.9..1.1; the 1 h floor applies after jitter, except for
 * `history_unavailable` (retry in 15 min).
 */
export function nextIntervalMs(
  status: CrawlStatus,
  state: ScheduleState,
  rand: () => number,
): number {
  const base = baseIntervalMs(status, state);
  const jittered = Math.round(base * (1 - JITTER + 2 * JITTER * rand()));
  return status === 'history_unavailable'
    ? jittered
    : Math.max(MIN_INTERVAL_MS, jittered);
}

/** Host is left alone for max(10 x delay, Retry-After capped at 1 h). */
export function hostBackoffMs(
  delayMs: number,
  retryAfterSec: number | null,
): number {
  const retryMs =
    retryAfterSec === null
      ? 0
      : Math.min(Math.max(0, retryAfterSec), MAX_RETRY_AFTER_SEC) * 1000;
  return Math.max(10 * delayMs, retryMs);
}

/** `Retry-After` as delta-seconds or HTTP-date; anything else is null. */
export function parseRetryAfter(
  header: string | null | undefined,
  nowMs: number,
): number | null {
  if (header === null || header === undefined) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const sec = Number(value);
    return Number.isSafeInteger(sec) ? sec : null;
  }
  if (!/^[A-Za-z]{3},/.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** Non-success HTTP status of the page (after redirects were handled). */
export function statusFromHttp(status: number): CrawlStatus {
  if (status === 404 || status === 410) return 'gone';
  if (status === 401 || status === 403) return 'blocked_by_site';
  if (status === 429) return 'http_429';
  if (status === 503) return 'http_503';
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  if (status >= 300) return 'http_3xx';
  return 'ok';
}
