import { Module } from '@nestjs/common';
import {
  WidgetShopDeletedConsumer,
  WidgetShopStatusConsumer,
  WidgetShopUpdatedConsumer,
} from './infra/widget-consumers';
import { WidgetCoreModule } from './widget-core.module';

/**
 * The projector side of the widget (apps/projector): the consumers of `tenancy.events` that keep the shop copy of every
 * site current (FR-033…FR-035). Started by `ProjectionsModule.forProjectors(WidgetProjectorModule.projectors, …)`; the
 * e2e specs list the same classes as providers and call `project` directly, so no Kafka consumer starts in a spec.
 */
@Module({
  imports: [WidgetCoreModule],
  providers: [
    WidgetShopUpdatedConsumer,
    WidgetShopStatusConsumer,
    WidgetShopDeletedConsumer,
  ],
  exports: [
    WidgetCoreModule,
    WidgetShopUpdatedConsumer,
    WidgetShopStatusConsumer,
    WidgetShopDeletedConsumer,
  ],
})
export class WidgetProjectorModule {
  /** Every consumer of this capability, for the projector app's list. */
  static readonly projectors = [
    WidgetShopUpdatedConsumer,
    WidgetShopStatusConsumer,
    WidgetShopDeletedConsumer,
  ];
}
