import { Module } from '@nestjs/common';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { LINK_AGGREGATE } from './domain/link-events';
import { LinkClicksProjector } from './infra/link-clicks.projector';

/**
 * The click consumer, hosted by `apps/projector` (S37 G17, D-8): the app lists `ShareLinksProjectorModule.projectors` in
 * `ProjectionsModule.forProjectors` and imports this module for what the consumer injects.
 */
@Module({
  imports: [
    ClockModule,
    ClickHouseModule,
    EventsModule.forAggregates([LINK_AGGREGATE]),
  ],
  providers: [LinkClicksProjector],
  // the consumer host (`ProjectionsModule.forProjectors`) resolves the projector's own dependencies through these
  exports: [LinkClicksProjector, ClickHouseModule, ClockModule],
})
export class ShareLinksProjectorModule {
  static readonly projectors = [LinkClicksProjector];
}
