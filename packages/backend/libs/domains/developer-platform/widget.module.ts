import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { jsonBodyLimits } from '@app/infrastructure/platform/body-limits';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { WidgetResponseDefaults } from './api/widget-cors';
import { JsonOnlyGuard } from './api/widget-json.guard';
import { WidgetController } from './api/widget.controller';
import { WidgetSitesController } from './api/widget-sites.controller';
import { WidgetIdentityService } from './application/widget-identity.service';
import { WidgetPublicService } from './application/widget-public.service';
import { WidgetSessionService } from './application/widget-session.service';
import { developerPlatformRatePolicies } from './rate-limit-policies';
import { WidgetCoreModule } from './widget-core.module';

// The identify body is at most 8 KiB (FR-031); a larger one is `413` before anything is evaluated.
jsonBodyLimits.register({
  match: /^\/api\/widget\/v1\/identify\/?$/,
  limit: '8kb',
});

/**
 * The widget backend (apps/core): the dashboard routes of the sites and the public widget API. The loader script is
 * served by the edge (packages/edge-be/src/widget-loader.ts). Exports only what other domains may use (X.4, D-8).
 */
@Module({
  imports: [
    AuthModule,
    CacheModule,
    WidgetCoreModule,
    RateLimitModule.forFeature(developerPlatformRatePolicies),
  ],
  controllers: [WidgetSitesController, WidgetController],
  providers: [
    WidgetPublicService,
    WidgetIdentityService,
    WidgetSessionService,
    JsonOnlyGuard,
    WidgetResponseDefaults,
  ],
  exports: [WidgetSessionService],
})
export class WidgetModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(WidgetResponseDefaults).forRoutes(WidgetController);
  }
}
