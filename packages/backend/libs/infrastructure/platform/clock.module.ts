import { Global, Module } from '@nestjs/common';
import { CLOCK } from '@app/common/core/clock';
import { ClockService } from '@app/infrastructure/clock/clock.service';

/**
 * Global time source: tests override `CLOCK` with `FakeClock` instead of sleeping. `ClockService` is the system
 * clock until `CLOCK_CONTROL=enabled` (S54.R-21), then it adds the shared Redis offset.
 */
@Global()
@Module({
  providers: [ClockService, { provide: CLOCK, useExisting: ClockService }],
  exports: [CLOCK, ClockService],
})
export class ClockModule {}
