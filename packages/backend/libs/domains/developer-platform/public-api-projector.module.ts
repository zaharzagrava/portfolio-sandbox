import { Module } from '@nestjs/common';
import { DeveloperPlatformCoreModule } from './developer-platform-core.module';
import { ApiRequestsProjector } from './infra/api-requests.projector';
import {
  PublicApiShopLifecycleConsumer,
  PublicApiUsageMeteringConsumer,
} from './infra/consumers';

/**
 * The projector side of the public API (apps/projector): the consumers of `tenancy.events` and `api.request_logged`.
 * They are started by `ProjectionsModule.forProjectors(PublicApiProjectorModule.projectors, [PublicApiProjectorModule])`;
 * the e2e specs list the same classes as providers and call `project` directly, so no Kafka consumer starts in a spec.
 */
@Module({
  imports: [DeveloperPlatformCoreModule],
  providers: [
    PublicApiShopLifecycleConsumer,
    ApiRequestsProjector,
    PublicApiUsageMeteringConsumer,
  ],
  exports: [
    DeveloperPlatformCoreModule,
    PublicApiShopLifecycleConsumer,
    ApiRequestsProjector,
    PublicApiUsageMeteringConsumer,
  ],
})
export class PublicApiProjectorModule {
  /** Every consumer of this capability, for the projector app's list. */
  static readonly projectors = [
    PublicApiShopLifecycleConsumer,
    ApiRequestsProjector,
    PublicApiUsageMeteringConsumer,
  ];
}
