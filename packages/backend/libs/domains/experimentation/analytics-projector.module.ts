import { Module } from '@nestjs/common';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { DeadLetterWriter } from '@app/infrastructure/projections/dead-letter';
import { PurchaseEventsProjector } from './infra/purchase-events.projector';

/**
 * The consumer side of analytics (S39): `apps/projector` lists `AnalyticsProjectorModule.projectors` and imports this
 * module so the host resolves the projector's own dependencies through its exports (the pattern of the other projector
 * modules). The projector leaves the domain barrel with this module (S38 D-8).
 */
@Module({
  imports: [ClickHouseModule, KafkaProducerModule, ClockModule],
  providers: [PurchaseEventsProjector, DeadLetterWriter],
  exports: [
    PurchaseEventsProjector,
    DeadLetterWriter,
    ClickHouseModule,
    ClockModule,
  ],
})
export class AnalyticsProjectorModule {
  static readonly projectors = [PurchaseEventsProjector];
}
