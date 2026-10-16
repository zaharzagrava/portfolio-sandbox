import { Module } from '@nestjs/common';
import { ProblemCatalogModule } from '@app/common/errors';
import { AuthModule } from '@app/domains/identity';
import { ProductQueryModule } from '@app/domains/catalog';
import { ShopQueryModule } from '@app/domains/tenancy';
import { CacheModule } from '@app/infrastructure/cache';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { InboxModule } from '@app/infrastructure/inbox';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import './config-rules';
import './application/story.job-types';
import { StoriesController } from './api/stories.controller';
import { PublicStoriesController } from './api/public-stories.controller';
import { SitemapController } from './api/sitemap.controller';
import { CacheInvalidationService } from './application/cache-invalidation.service';
import { DraftsService } from './application/drafts.service';
import { STORIES_AGGREGATE } from './application/events/story-events';
import { LifecycleService } from './application/lifecycle.service';
import { PreviewService } from './application/preview.service';
import { PublicReadService } from './application/public-read.service';
import { PublishService } from './application/publish.service';
import { ScheduleService } from './application/schedule.service';
import { ShopCopyService } from './application/shop-copy.service';
import { ShopIdentity } from './application/shop-identity.service';
import { SitemapService } from './application/sitemap.service';
import { STORY_CONFIG } from './application/story-config.token';
import { StoryWriteLimit } from './application/story-limits';
import { StoriesService } from './application/stories.service';
import { STORY_PROBLEMS } from './domain/errors';
import { STORY_CONFIG_KEYS, resolveStoryConfig } from './domain/limits';
import {
  CDN_PURGER,
  DRAFT_REPOSITORY,
  PREVIEW_SIGNER,
  PRODUCT_REFERENCE_CHECKER,
  PUBLISHED_STORY_READER,
  READ_MODEL,
  REVALIDATION_CLIENT,
  SHOP_COPY_REPOSITORY,
  SHOP_LOOKUP,
  SITEMAP_READER,
  STORY_REPOSITORY,
  TRANSITION_REPOSITORY,
  VERSION_REPOSITORY,
} from './domain/ports';
import { ConfiguredCdnPurger } from './infra/cdn-purger';
import { SequelizeDraftRepository } from './infra/draft.repository';
import { StoryInvalidationConsumer } from './infra/invalidation.consumer';
import { HmacPreviewSigner } from './infra/preview-signer';
import { CatalogProductReferenceChecker } from './infra/product-reference.adapter';
import { SequelizePublishedStoryReader } from './infra/published-story.reader';
import { ConfiguredRevalidationClient } from './infra/revalidation-client';
import { SequelizeShopCopyRepository } from './infra/shop-copy.repository';
import { StoryShopCopyConsumer } from './infra/shop-copy.consumer';
import { TenancyShopLookup } from './infra/shop-lookup.adapter';
import { SequelizeSitemapReader } from './infra/sitemap.reader';
import { StoriesJobs, StoriesSchedule } from './infra/stories.jobs';
import { SequelizeStoryRepository } from './infra/story.repository';
import { CachedStoryReadModel } from './infra/story-read-model';
import { SequelizeTransitionRepository } from './infra/transition.repository';
import { SequelizeVersionRepository } from './infra/version.repository';
import { storyRatePolicies } from './rate-limit-policies';

/**
 * The adapters of the ports (D-6), in the groups the modules need: the stores every module has, the cache layers, the
 * lookups of another capability (S03, S05) that only the write path needs, and what only the public routes read.
 */
const STORE_ADAPTERS = [
  { provide: STORY_REPOSITORY, useClass: SequelizeStoryRepository },
  { provide: DRAFT_REPOSITORY, useClass: SequelizeDraftRepository },
  { provide: VERSION_REPOSITORY, useClass: SequelizeVersionRepository },
  { provide: TRANSITION_REPOSITORY, useClass: SequelizeTransitionRepository },
  { provide: SHOP_COPY_REPOSITORY, useClass: SequelizeShopCopyRepository },
];
const CACHE_ADAPTERS = [
  { provide: READ_MODEL, useClass: CachedStoryReadModel },
  { provide: CDN_PURGER, useClass: ConfiguredCdnPurger },
  { provide: REVALIDATION_CLIENT, useClass: ConfiguredRevalidationClient },
];
const WRITE_ADAPTERS = [
  {
    provide: PRODUCT_REFERENCE_CHECKER,
    useClass: CatalogProductReferenceChecker,
  },
  { provide: SHOP_LOOKUP, useClass: TenancyShopLookup },
];
const PUBLIC_ADAPTERS = [
  { provide: SITEMAP_READER, useClass: SequelizeSitemapReader },
  { provide: PUBLISHED_STORY_READER, useClass: SequelizePublishedStoryReader },
  { provide: PREVIEW_SIGNER, useClass: HmacPreviewSigner },
];

/** Validated at boot, so an invalid setting fails the start. The environment carries the keys in upper case. */
const CONFIG_PROVIDER = {
  provide: STORY_CONFIG,
  useFactory: () =>
    resolveStoryConfig(
      Object.fromEntries(
        STORY_CONFIG_KEYS.map((key) => [key, process.env[key.toUpperCase()]]),
      ),
    ),
};

/** S27 (core): staff, public and sitemap routes. */
@Module({
  imports: [
    AuthModule,
    CacheModule,
    ClockModule,
    IdempotencyModule,
    ProductQueryModule,
    ShopQueryModule,
    JobsModule,
    EventsModule.forAggregates([STORIES_AGGREGATE]),
    RateLimitModule.forFeature(storyRatePolicies),
    ProblemCatalogModule.forFeature(STORY_PROBLEMS),
  ],
  providers: [
    ...STORE_ADAPTERS,
    ...CACHE_ADAPTERS,
    ...WRITE_ADAPTERS,
    ...PUBLIC_ADAPTERS,
    CONFIG_PROVIDER,
    StoryWriteLimit,
    ShopIdentity,
    StoriesService,
    DraftsService,
    PublishService,
    ScheduleService,
    LifecycleService,
    PublicReadService,
    PreviewService,
    SitemapService,
  ],
  controllers: [StoriesController, PublicStoriesController, SitemapController],
})
export class StoriesModule {}

/** S27 (worker): the reveal job and the due-schedule sweep. Boots on its own: everything it needs is listed here (L-018). */
@Module({
  imports: [
    CacheModule,
    ClockModule,
    ProductQueryModule,
    ShopQueryModule,
    JobsModule,
    EventsModule.forAggregates([STORIES_AGGREGATE]),
    RateLimitModule.forFeature(storyRatePolicies),
  ],
  providers: [
    ...STORE_ADAPTERS,
    ...CACHE_ADAPTERS,
    ...WRITE_ADAPTERS,
    CONFIG_PROVIDER,
    StoryWriteLimit,
    ShopIdentity,
    PublishService,
    ScheduleService,
    StoriesJobs,
    StoriesSchedule,
  ],
})
export class StoriesWorkerModule {}

/**
 * S27 (projector): the shop copy and the cache invalidation consumers (apps/projector registers them from `projectors`).
 * The projection framework builds the consumers in its own module, so what they inject is exported.
 */
@Module({
  imports: [CacheModule, ClockModule, InboxModule, ShopQueryModule],
  providers: [
    ...STORE_ADAPTERS,
    ...CACHE_ADAPTERS,
    CONFIG_PROVIDER,
    CacheInvalidationService,
    ShopCopyService,
  ],
  exports: [CacheInvalidationService, ShopCopyService, InboxModule],
})
export class StoriesProjectorModule {
  static readonly projectors = [
    StoryShopCopyConsumer,
    StoryInvalidationConsumer,
  ];
}
