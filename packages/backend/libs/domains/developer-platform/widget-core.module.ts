import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { WIDGET_AGGREGATE } from './application/events/widget-events';
import { WidgetShopLifecycleHandler } from './application/widget-shop-lifecycle.handler';
import { WidgetSiteCache } from './application/widget-site.cache';
import { WidgetSitesService } from './application/widget-sites.service';
import {
  HandoffVerifier,
  SingleUseStore,
  WidgetCatalog,
  WidgetRandom,
  WidgetShops,
  WidgetSiteRepository,
  WidgetTokenSigner,
} from './domain/widget-ports';
import {
  JwtHandoffVerifier,
  JwtWidgetTokenSigner,
} from './infra/jwt-widget-token';
import { RedisSingleUseStore } from './infra/redis-single-use.store';
import { SequelizeWidgetSiteRepository } from './infra/sequelize-widget-site.repository';
import { WidgetBackfill } from './infra/widget-shop-copy.backfill';
import {
  CatalogWidgetCatalog,
  SystemWidgetRandom,
  TenancyWidgetShops,
} from './infra/widget-adapters';
import { ProductModule } from '@app/domains/catalog';

/**
 * What the widget's deployables share (core and projector): the ports with their adapters, the site cache and the
 * services built on them. Each deployable module imports this one explicitly (L-018); nothing here is exported by the
 * barrel.
 */
@Module({
  imports: [
    AuthModule,
    CacheModule,
    ProductModule,
    EventsModule.forAggregates([WIDGET_AGGREGATE]),
  ],
  providers: [
    { provide: WidgetSiteRepository, useClass: SequelizeWidgetSiteRepository },
    { provide: WidgetCatalog, useClass: CatalogWidgetCatalog },
    { provide: WidgetShops, useClass: TenancyWidgetShops },
    { provide: SingleUseStore, useClass: RedisSingleUseStore },
    { provide: WidgetTokenSigner, useClass: JwtWidgetTokenSigner },
    { provide: HandoffVerifier, useClass: JwtHandoffVerifier },
    { provide: WidgetRandom, useClass: SystemWidgetRandom },
    WidgetSiteCache,
    WidgetSitesService,
    WidgetShopLifecycleHandler,
    WidgetBackfill,
  ],
  exports: [
    WidgetSiteRepository,
    WidgetCatalog,
    WidgetShops,
    SingleUseStore,
    WidgetTokenSigner,
    HandoffVerifier,
    WidgetRandom,
    WidgetSiteCache,
    WidgetSitesService,
    WidgetShopLifecycleHandler,
    WidgetBackfill,
  ],
})
export class WidgetCoreModule {}
