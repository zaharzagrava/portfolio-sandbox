import type { Channel } from './catalog';

const HOUR_MS = 3_600_000;

export interface CapRule {
  limit: number;
  windowMs: number;
}

/**
 * Frequency caps of marketing deliveries, per user and channel over a rolling window (FR-025): push 3 per hour,
 * e-mail 2 per 24 hours, SMS 1 per 24 hours. Transactional deliveries and the inbox have no cap.
 */
export const CAP_RULES: Partial<Record<Channel, CapRule>> = {
  push: { limit: 3, windowMs: HOUR_MS },
  email: { limit: 2, windowMs: 24 * HOUR_MS },
  sms: { limit: 1, windowMs: 24 * HOUR_MS },
};

/**
 * The rolling window ending at `now` is `(now - windowMs, now]`: an admit made exactly `windowMs` ago has left it.
 * This is the arithmetic the Redis script of `CapStore` mirrors (`ZREMRANGEBYSCORE -inf now - window`).
 */
export function inWindow(admittedAtMs: number, now: Date, rule: CapRule) {
  return admittedAtMs > now.getTime() - rule.windowMs;
}

/** Admit when fewer than `limit` of the earlier admits (epoch ms) are still inside the window ending at `now`. */
export function admitsWithin(
  earlierAdmitsMs: number[],
  now: Date,
  rule: CapRule,
): boolean {
  return (
    earlierAdmitsMs.filter((at) => inWindow(at, now, rule)).length < rule.limit
  );
}
