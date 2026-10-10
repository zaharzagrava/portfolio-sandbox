import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import type { AutocompleteClock } from '../domain/autocomplete-ports';

/** The autocomplete `Clock` port over the platform time source, so specs that move the platform clock move this one. */
@Injectable()
export class SystemAutocompleteClock implements AutocompleteClock {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  now(): Date {
    return this.clock.now();
  }
}
