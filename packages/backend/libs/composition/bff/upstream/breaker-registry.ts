import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { BffSettings } from '../bff-config';
import { UpstreamBreaker } from './circuit-breaker';
import type { Capability } from './endpoints/endpoint';

/** One breaker per upstream capability, per BFF instance (S48 FR-009): one section's breaker never affects another's. */
@Injectable()
export class BreakerRegistry {
  private readonly breakers = new Map<Capability, UpstreamBreaker>();

  constructor(
    private readonly settings: BffSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  of(upstream: Capability): UpstreamBreaker {
    let breaker = this.breakers.get(upstream);
    if (!breaker) {
      breaker = new UpstreamBreaker(this.settings.breaker, () =>
        this.clock.nowMs(),
      );
      this.breakers.set(upstream, breaker);
    }
    return breaker;
  }

  /** Forgets every breaker (specs start each test closed). */
  reset(): void {
    this.breakers.clear();
  }
}
