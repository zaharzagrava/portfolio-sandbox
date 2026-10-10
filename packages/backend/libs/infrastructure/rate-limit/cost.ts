import { InvalidRateLimitCostError } from './rate-limit.errors';

/** Code callers: a cost is a positive integer, anything else is a programming error. */
export function assertValidCost(cost: number): void {
  if (!Number.isInteger(cost) || cost < 1)
    throw new InvalidRateLimitCostError(cost);
}

/** HTTP surface: a resolver's value becomes `max(1, ceil(value))`, and `1` when it is not a finite number. */
export function normalizeHttpCost(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.ceil(value));
}
