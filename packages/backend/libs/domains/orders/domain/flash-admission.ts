/**
 * Admission allowance of a flash sale (S11 FR-016, FR-017; research R-04): a token bucket per sale whose burst is one
 * second of the rate. These pure functions are the specification of the Lua script in `infra/flash-scripts.ts`; the
 * e2e specs run the real script with a frozen clock and expect the same numbers.
 */

export interface AllowanceInput {
  rate: number;
  burst: number;
  tokens: number;
  elapsedMs: number;
}

/** Tokens after `elapsedMs`: linear refill, capped at the burst, never below zero; a clock going backwards mints nothing. */
export function allowance(input: AllowanceInput): { tokens: number } {
  const elapsed = Math.max(0, input.elapsedMs);
  const refilled = input.tokens + (elapsed * input.rate) / 1000;
  return { tokens: Math.max(0, Math.min(input.burst, refilled)) };
}

export interface AdmissionState {
  tokens: number;
  updatedAtMs: number;
}

/** Takes one token. `state` is `null` before the first attempt: the bucket starts full. */
export function admit(
  state: AdmissionState | null,
  rate: number,
  nowMs: number,
): { admitted: boolean; state: AdmissionState } {
  const current = state ?? { tokens: rate, updatedAtMs: nowMs };
  const { tokens } = allowance({
    rate,
    burst: rate,
    tokens: current.tokens,
    elapsedMs: nowMs - current.updatedAtMs,
  });
  const updatedAtMs = Math.max(nowMs, current.updatedAtMs);
  if (tokens >= 1) return { admitted: true, state: { tokens: tokens - 1, updatedAtMs } };
  return { admitted: false, state: { tokens, updatedAtMs } };
}

/** `Retry-After` for a rejected attempt: uniform in 1..3 s from a random number in [0, 1]. */
export function retryAfterSeconds(random: number): number {
  return Math.min(3, 1 + Math.floor(random * 3));
}
