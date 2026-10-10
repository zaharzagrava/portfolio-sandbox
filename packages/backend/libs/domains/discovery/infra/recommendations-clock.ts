import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { RecommendationsClock } from '../domain/recommendation-ports';

/** The recommendations `Clock` port over the platform time source, so specs that move the platform clock move this one. */
@Injectable()
export class SystemRecommendationsClock implements RecommendationsClock {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  now(): Date {
    return this.clock.now();
  }
}
