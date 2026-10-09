export type Priority = 'critical' | 'default' | 'background';
export type Decision = 'admit' | 'lag' | 'inflight';

/** Tier thresholds as multiples of the configured lag threshold `T`: background `T`, default `2T`, critical `5T`. */
const TIER_MULTIPLIER: Record<Priority, number> = {
  background: 1,
  default: 2,
  critical: 5,
};
const RECOVERY_FACTOR = 0.8;
const RECOVERY_SAMPLES = 2;

interface TierState {
  shedding: boolean;
  belowCount: number;
}

/**
 * Pure shedding policy (FR-049 to FR-051): one lag sample per window goes in through `observe`, a decision per request
 * comes out of `decide`. A tier starts shedding at its threshold and stops only after two consecutive samples below
 * `0.8 x` that threshold, so a lag hovering near the threshold does not flap. No clock is read here.
 */
export class SheddingPolicy {
  private readonly tiers: Record<Priority, TierState> = {
    background: { shedding: false, belowCount: 0 },
    default: { shedding: false, belowCount: 0 },
    critical: { shedding: false, belowCount: 0 },
  };

  constructor(
    private readonly options: { thresholdMs: number; inflightCap: number },
  ) {}

  observe(lagMs: number): void {
    for (const priority of Object.keys(this.tiers) as Priority[]) {
      const threshold = this.options.thresholdMs * TIER_MULTIPLIER[priority];
      const tier = this.tiers[priority];
      if (lagMs >= threshold) {
        tier.shedding = true;
        tier.belowCount = 0;
      } else if (tier.shedding) {
        tier.belowCount =
          lagMs < threshold * RECOVERY_FACTOR ? tier.belowCount + 1 : 0;
        if (tier.belowCount >= RECOVERY_SAMPLES) {
          tier.shedding = false;
          tier.belowCount = 0;
        }
      }
    }
  }

  decide(priority: Priority, inflight: number): Decision {
    if (this.tiers[priority].shedding) return 'lag';
    const cap =
      priority === 'critical'
        ? this.options.inflightCap * 2
        : this.options.inflightCap;
    return inflight >= cap ? 'inflight' : 'admit';
  }
}
