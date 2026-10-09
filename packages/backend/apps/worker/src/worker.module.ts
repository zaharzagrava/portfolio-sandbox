import { TenancyModule, TenancyWorkerModule } from '@app/domains/tenancy';
import { QueueMetricsService } from '@app/infrastructure/sqs/queue-metrics.service';
import { FunctionJudgeModule } from '@app/domains/shop-functions';
import { KnowledgeWorkerModule } from '@app/domains/assistant';
import { OnboardingWorkerModule } from '@app/domains/seller-onboarding';
import {
  CrawlerWorkerModule,
  LeaderboardsWorkerModule,
} from '@app/domains/seller-insights';
import {
  IntegrationsWorkerModule,
  CatalogImportWorkerModule,
} from '@app/domains/catalog-sync';
import { VideoWorkerModule } from '@app/domains/media';
import { AssetsWorkerModule } from '@app/domains/asset-library';
import { StoriesWorkerModule } from '@app/domains/content';
import { AdsWorkerModule } from '@app/domains/marketing';
import { FlagsSdkModule } from '@app/domains/experimentation';
import {
  WebhooksWorkerModule,
  PublicApiWorkerModule,
} from '@app/domains/developer-platform';
import { DeliveryWorkerModule } from '@app/domains/fulfilment';
import { ChatOfflineWorkerModule } from '@app/domains/chat';
import {
  LiveWorkerModule,
  LaunchEventsWorkerModule,
} from '@app/domains/launch-events';
import { NotificationsWorkerModule } from '@app/domains/notifications';
import {
  RecommendationsWorkerModule,
  SearchReindexWorkerModule,
  AutocompleteWorkerModule,
} from '@app/domains/discovery';
import { DiscussionsWorkerModule } from '@app/domains/community';
import { StatementsWorkerModule } from '@app/domains/statements';
import { BillingWorkerModule } from '@app/domains/billing';
import { AuctionsWorkerModule } from '@app/domains/auctions';
import { FinanceWorkerModule } from '@app/domains/payments';
import { OrdersWorkerModule } from '@app/domains/orders';
import { Module } from '@nestjs/common';
import { OpenTelemetryModule } from 'nestjs-otel';
import { ApiConfigModule } from '@app/common/config';
import { PlatformModule } from '@app/infrastructure/platform';
import { DatabaseModule } from '@app/infrastructure/database';
import { RedisModule } from '@app/infrastructure/redis/redis.module';
import { JobsWorkerModule } from '@app/infrastructure/jobs/jobs-worker.module';
import { IdempotencyModule } from '@app/infrastructure/idempotency';
import { OutboxMaintenanceModule } from '@app/infrastructure/outbox/outbox-maintenance.module';
import { InboxModule } from '@app/infrastructure/inbox';
import { ProductWorkerModule } from '@app/domains/catalog';
import { AuthWorkerModule } from '@app/domains/identity';

/**
 * Background execution (SD-29 jobs, later SQS task consumers that are too
 * long-running for Lambda - SD-27 imports, SD-26 transcoding). Scaled on
 * queue lag (`job_queue_lag_seconds`, SQS age) by the worker ASG (O-03).
 * Domain modules that own @JobHandler methods are added here as sections land.
 */
@Module({
  imports: [
    ApiConfigModule,
    PlatformModule,
    // Global ShopGuard/MembershipService: shared domain modules (ProductModule, …) carry guarded controllers.
    TenancyModule,
    DatabaseModule,
    RedisModule,
    JobsWorkerModule,
    // Runs the platform.purge-idempotency-keys job (S54 FR-069).
    IdempotencyModule,
    // Runs the outbox.purge-published job (S53 FR-019) and the inbox.purge job (S53 FR-041).
    OutboxMaintenanceModule,
    InboxModule,
    ProductWorkerModule,
    AuthWorkerModule,
    TenancyWorkerModule,
    OrdersWorkerModule,
    FinanceWorkerModule,
    LaunchEventsWorkerModule,
    AuctionsWorkerModule,
    BillingWorkerModule,
    StatementsWorkerModule,
    DiscussionsWorkerModule,
    AutocompleteWorkerModule,
    SearchReindexWorkerModule,
    RecommendationsWorkerModule,
    NotificationsWorkerModule,
    LiveWorkerModule,
    LeaderboardsWorkerModule,
    ChatOfflineWorkerModule,
    DeliveryWorkerModule,
    PublicApiWorkerModule,
    WebhooksWorkerModule,
    FlagsSdkModule,
    AdsWorkerModule,
    StoriesWorkerModule,
    CatalogImportWorkerModule,
    AssetsWorkerModule,
    VideoWorkerModule,
    IntegrationsWorkerModule,
    CrawlerWorkerModule,
    FunctionJudgeModule,
    KnowledgeWorkerModule,
    OnboardingWorkerModule,
    OpenTelemetryModule.forRoot({ metrics: { hostMetrics: true } }),
  ],
  // SD-33: queue depth / DLQ gauges for Prometheus.
  providers: [QueueMetricsService],
})
export class WorkerModule {}
