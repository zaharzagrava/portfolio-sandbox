/**
 * Retry policy for provider calls (AS-57, FR-052). Pure: randomness is injected.
 * Retries happen at this layer only; at most 3 attempts per call path; idempotent operations only.
 */
export const MAX_ATTEMPTS = 3;
export const BASE_DELAY_MS = 500;
export const CAP_DELAY_MS = 8000;

export type CallFailure =
  { kind: 'http'; status: number } | { kind: 'timeout' } | { kind: 'network' };

export type FailureClass =
  'transient' | 'rate_limited' | 'auth' | 'forbidden' | 'gone' | 'permanent';

export function classifyFailure(failure: CallFailure): FailureClass {
  if (failure.kind !== 'http') return 'transient';
  const { status } = failure;
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'gone';
  if (status >= 500) return 'transient';
  return 'permanent';
}

/** `attempt` = number of attempts already made (1-based). */
export function shouldRetry(input: {
  failure: CallFailure;
  attempt: number;
  idempotent: boolean;
}): boolean {
  if (!input.idempotent || input.attempt >= MAX_ATTEMPTS) return false;
  const klass = classifyFailure(input.failure);
  return klass === 'transient' || klass === 'rate_limited';
}

/** Full jitter: uniform in `[0, min(cap, base * 2^(attempt-1)))`. `attempt` = attempts already made (1-based). */
export function retryDelayMs(attempt: number, random: () => number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 30);
  const ceiling = Math.min(CAP_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
  return Math.min(ceiling - 1, Math.floor(random() * ceiling));
}
