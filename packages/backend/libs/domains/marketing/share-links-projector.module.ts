import { Module } from '@nestjs/common';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { ConversionIngestService } from './application/conversion-ingest.service';
import { CONVERSION_STORE } from './domain/conversion-ports';
import { LINK_AGGREGATE } from './domain/link-events';
import { AffiliateConversionProjector } from './infra/affiliate-conversion.projector';
import { LinkClicksProjector } from './infra/link-clicks.projector';
import { SequelizeConversionStore } from './infra/sequelize-conversion.store';

/**
 * The click and conversion consumers, hosted by `apps/projector` (S37 G17, D-8; J05): the app lists
 * `ShareLinksProjectorModule.projectors` in `ProjectionsModule.forProjectors` and imports this module for what the
 * consumers inject. The conversion consumer writes its row and its `links.events` outbox rows in one transaction.
 */
@Module({
  imports: [
    ClockModule,
    ClickHouseModule,
    EventsModule.forAggregates([LINK_AGGREGATE]),
  ],
  providers: [
    LinkClicksProjector,
    AffiliateConversionProjector,
    ConversionIngestService,
    SequelizeConversionStore,
    { provide: CONVERSION_STORE, useExisting: SequelizeConversionStore },
  ],
  // the consumer host (`ProjectionsModule.forProjectors`) resolves the projector's own dependencies through these
  exports: [
    LinkClicksProjector,
    AffiliateConversionProjector,
    ConversionIngestService,
    CONVERSION_STORE,
    ClickHouseModule,
    ClockModule,
  ],
})
export class ShareLinksProjectorModule {
  static readonly projectors = [
    LinkClicksProjector,
    AffiliateConversionProjector,
  ];
}
