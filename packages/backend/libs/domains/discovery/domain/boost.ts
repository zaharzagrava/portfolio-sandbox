import { MAX_POPULARITY_BUCKET } from './popularity-bucket';

/** Total business multiplier is within [1, 4] so text relevance always dominates (FR-005, AS-06, AS-86). */
export const MIN_BOOST_MULTIPLIER = 1;
export const MAX_BOOST_MULTIPLIER = 4;

export const BOOST_TIERS = ['STARTER', 'PRO', 'ENTERPRISE'] as const;
export type BoostTier = (typeof BOOST_TIERS)[number];

/**
 * Factors that multiply (questions.md default): in stock x2, rating `1 + r * 0.1`, popularity `1 + bucket * 0.05`,
 * plan tier x1 / x1.1 / x1.2, sponsored x1.3. A missing signal is the neutral factor 1. The product is capped at 4.
 */
export interface BoostWeights {
  /** factor for an in-stock product */
  inStock: number;
  /** added per rating point (0-5) */
  rating: number;
  /** added per popularity bucket (0-10) */
  popularity: number;
  tier: Record<BoostTier, number>;
  sponsored: number;
}

export const DEFAULT_BOOST_WEIGHTS: BoostWeights = {
  inStock: 2,
  rating: 0.1,
  popularity: 0.05,
  tier: { STARTER: 1, PRO: 1.1, ENTERPRISE: 1.2 },
  sponsored: 1.3,
};

export interface BoostSignals {
  inStock: boolean;
  rating: number | null;
  popularityBucket: number | null;
  tier: BoostTier | null;
  sponsored: boolean;
}

const clamp = (value: number | null, max: number): number =>
  value === null || !Number.isFinite(value) ? 0 : Math.min(Math.max(value, 0), max);

/** A factor below 1 would turn a boost into a penalty; non-numbers are neutral. */
const factor = (weight: number): number =>
  Number.isFinite(weight) ? Math.max(weight, 1) : 1;

const perUnit = (weight: number): number =>
  Number.isFinite(weight) ? Math.max(weight, 0) : 0;

/** Everything except the plan tier, capped. The engine recomputes the score from this when only the tier changes. */
export function baseMultiplier(
  signals: Omit<BoostSignals, 'tier'>,
  weights: BoostWeights = DEFAULT_BOOST_WEIGHTS,
): number {
  const total =
    (signals.inStock ? factor(weights.inStock) : 1) *
    (1 + perUnit(weights.rating) * clamp(signals.rating, 5)) *
    (1 +
      perUnit(weights.popularity) *
        clamp(signals.popularityBucket, MAX_POPULARITY_BUCKET)) *
    (signals.sponsored ? factor(weights.sponsored) : 1);
  return Math.min(Math.max(total, MIN_BOOST_MULTIPLIER), MAX_BOOST_MULTIPLIER);
}

export const tierFactor = (
  tier: BoostTier | null,
  weights: BoostWeights = DEFAULT_BOOST_WEIGHTS,
): number => (tier ? factor(weights.tier[tier]) : 1);

/** The combined business multiplier, always within [1, 4] whatever the weights. */
export function businessMultiplier(
  signals: BoostSignals,
  weights: BoostWeights = DEFAULT_BOOST_WEIGHTS,
): number {
  return Math.min(
    baseMultiplier(signals, weights) * tierFactor(signals.tier, weights),
    MAX_BOOST_MULTIPLIER,
  );
}
