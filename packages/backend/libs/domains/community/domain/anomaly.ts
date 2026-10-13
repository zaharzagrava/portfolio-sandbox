/** Vote-anomaly signal (S25 FR-053): defaults and the pure decision. */
export const ANOMALY_THRESHOLD = 10;
export const ANOMALY_WINDOW_SECONDS = 600;
/** One signal per target per hour. */
export const ANOMALY_DEDUPE_MS = 3_600_000;

export interface AnomalyInput {
  /** Times (ms) of the zero-weight votes seen on one target. */
  timestamps: number[];
  now: number;
  /** When the last signal for this target was sent (ms), if any. */
  lastSentAt: number | null;
  threshold?: number;
  windowSeconds?: number;
}

export interface AnomalyResult {
  fire: boolean;
  count: number;
  windowSeconds: number;
}

/** Ten zero-weight votes inside ten minutes fire once per hour; the signal never blocks voting. */
export function evaluateAnomaly(input: AnomalyInput): AnomalyResult {
  const windowSeconds = input.windowSeconds ?? ANOMALY_WINDOW_SECONDS;
  const threshold = input.threshold ?? ANOMALY_THRESHOLD;
  const from = input.now - windowSeconds * 1000;
  const count = input.timestamps.filter(
    (t) => t >= from && t <= input.now,
  ).length;
  const deduped =
    input.lastSentAt !== null &&
    input.now - input.lastSentAt < ANOMALY_DEDUPE_MS;
  return { fire: count >= threshold && !deduped, count, windowSeconds };
}
