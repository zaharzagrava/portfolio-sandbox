import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock } from '@app/common/core/clock';

/** Global time source: tests override `CLOCK` with `FakeClock` instead of sleeping. */
@Global()
@Module({
  providers: [{ provide: CLOCK, useClass: SystemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
