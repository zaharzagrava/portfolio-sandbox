import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import {
  EventLoopMonitor,
  LAG_SOURCE,
  RealLagSource,
} from './event-loop-monitor.service';
import {
  LOAD_SHEDDING_OPTIONS,
  LoadSheddingGate,
} from './load-shedding.middleware';

/**
 * Event-loop monitor plus the shedding gate. The gate is not mounted as module middleware (that would run after the
 * body parsers Nest registers first): the bootstrap mounts `gate.middleware()` with `app.use` before anything else.
 */
@Global()
@Module({
  imports: [DiscoveryModule, ApiConfigModule],
  providers: [
    { provide: LAG_SOURCE, useFactory: () => new RealLagSource() },
    { provide: LOAD_SHEDDING_OPTIONS, useValue: {} },
    EventLoopMonitor,
    LoadSheddingGate,
  ],
  exports: [EventLoopMonitor, LoadSheddingGate],
})
export class LoadSheddingModule {}
