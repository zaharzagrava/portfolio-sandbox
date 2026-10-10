import { Module, type Type } from '@nestjs/common';
import { CacheModule } from '@app/infrastructure/cache';
import type { Projector } from '@app/infrastructure/projections/projector';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { ProductCacheInvalidator } from './infra/product-cache-invalidator.projector';

/**
 * The catalog's event consumers, hosted by `apps/projector`: the app lists `ProductProjectorModule.projectors` in
 * `ProjectionsModule.forProjectors` and imports this module for what they inject. Nothing here is a projector class
 * for other domains to use.
 */
@Module({
  imports: [CacheModule, ClockModule],
  providers: [ProductCacheInvalidator],
  exports: [ProductCacheInvalidator],
})
export class ProductProjectorModule {
  static readonly projectors: Type<Projector>[] = [ProductCacheInvalidator];
}
