import { Module, type Provider } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { CLOCK } from '@app/common/core/clock';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { catalogSyncRatePolicies } from './rate-limit-policies';
import { CATALOG_SYNC_AGGREGATE } from './application/events/integration-events';
import { ConnectService } from './application/connect.service';
import { IntegrationHealthService } from './application/integration-health.service';
import { IntegrationViewService } from './application/integration-view.service';
import { LifecycleService } from './application/lifecycle.service';
import { RetentionService } from './application/retention.service';
import { LinkApplyService } from './application/link-apply.service';
import { OAuthService } from './application/oauth.service';
import { ReconcileService } from './application/reconcile.service';
import { LagMonitorService } from './application/lag-monitor.service';
import { IntegrationAdminService } from './application/integration-admin.service';
import { SyncEngineService } from './application/sync-engine.service';
import { ConflictService } from './application/conflict.service';
import { StockSyncService } from './application/stock-sync.service';
import { ConflictController } from './api/conflict.controller';
import { QuarantineController } from './api/quarantine.controller';
import { ReconcileController } from './api/reconcile.controller';
import { QuarantineService } from './application/quarantine.service';
import { IntegrationOAuthController } from './api/integration-oauth.controller';
import { IntegrationsController } from './api/integrations.controller';
import { IntegrationWebhookController } from './api/integration-webhook.controller';
import { WebhookService } from './application/webhook.service';
import {
  CATALOG_GATEWAY,
  CONFLICT_REPOSITORY,
  CREDENTIAL_VAULT,
  CURSOR_REPOSITORY,
  INSTALL_REPOSITORY,
  INTEGRATION_REPOSITORY,
  LINK_REPOSITORY,
  PROVIDER_SESSIONS,
  QUARANTINE_REPOSITORY,
  RECEIPT_REPOSITORY,
  RECONCILIATION_REPOSITORY,
  RUN_REPOSITORY,
  SHOP_PURGE_REPOSITORY,
  SHOP_STATUS_GATEWAY,
  SYNC_CLOCK,
  SYNC_QUEUE,
} from './domain/ports';
import { CatalogServicesGateway } from './infra/catalog-gateway.adapter';
import { SecretBoxCredentialVault } from './infra/credential-vault';
import { IntegrationsJobs } from './infra/integrations.jobs';
import { PROVIDER_NETWORK } from './infra/provider-network';
import { HttpProviderSessions } from './infra/provider-sessions.adapter';
import { ProductEventsConsumer } from './infra/product-events.consumer';
import {
  TenancyOffboardingConsumer,
  TenancyShopDeletedConsumer,
} from './infra/tenancy-events.consumer';
import { BackfillConsumer } from './infra/queue/backfill.consumer';
import { SyncConsumer } from './infra/queue/sync.consumer';
import {
  SequelizeConflictRepository,
  SequelizeCursorRepository,
  SequelizeInstallRepository,
  SequelizeIntegrationRepository,
  SequelizeLinkRepository,
  SequelizeQuarantineRepository,
  SequelizeReceiptRepository,
  SequelizeReconciliationRepository,
  SequelizeRunRepository,
  SequelizeShopPurgeRepository,
} from './infra/repositories';
import { TenancyShopStatusGateway } from './infra/shop-status.adapter';
import { TaskSyncQueue } from './infra/task-sync-queue';

/** Ports bound to their adapters. `PROVIDER_NETWORK` is `{}` in production: the only test seam of the provider stack. */
const ADAPTERS: Provider[] = [
  { provide: INTEGRATION_REPOSITORY, useClass: SequelizeIntegrationRepository },
  { provide: LINK_REPOSITORY, useClass: SequelizeLinkRepository },
  { provide: CURSOR_REPOSITORY, useClass: SequelizeCursorRepository },
  { provide: RUN_REPOSITORY, useClass: SequelizeRunRepository },
  { provide: SHOP_PURGE_REPOSITORY, useClass: SequelizeShopPurgeRepository },
  { provide: QUARANTINE_REPOSITORY, useClass: SequelizeQuarantineRepository },
  { provide: CONFLICT_REPOSITORY, useClass: SequelizeConflictRepository },
  { provide: RECEIPT_REPOSITORY, useClass: SequelizeReceiptRepository },
  {
    provide: RECONCILIATION_REPOSITORY,
    useClass: SequelizeReconciliationRepository,
  },
  { provide: INSTALL_REPOSITORY, useClass: SequelizeInstallRepository },
  { provide: CREDENTIAL_VAULT, useClass: SecretBoxCredentialVault },
  { provide: SYNC_QUEUE, useClass: TaskSyncQueue },
  { provide: SYNC_CLOCK, useExisting: CLOCK },
  { provide: CATALOG_GATEWAY, useClass: CatalogServicesGateway },
  { provide: SHOP_STATUS_GATEWAY, useClass: TenancyShopStatusGateway },
  { provide: PROVIDER_NETWORK, useValue: {} },
  { provide: PROVIDER_SESSIONS, useClass: HttpProviderSessions },
];

/** Every module imports what it injects, so each boots alone (L-018). `AuthModule` provides `SecretBox`. */
const BASE = [
  AuthModule,
  ClockModule,
  TenancyModule,
  ProductModule,
  SqsModule,
  RateLimitModule.forFeature(catalogSyncRatePolicies),
  EventsModule.forAggregates([CATALOG_SYNC_AGGREGATE]),
];

const APPLICATION = [
  IntegrationViewService,
  LinkApplyService,
  StockSyncService,
  ConflictService,
  QuarantineService,
  IntegrationHealthService,
  SyncEngineService,
  ConnectService,
  OAuthService,
  ReconcileService,
  LagMonitorService,
  IntegrationAdminService,
  LifecycleService,
  RetentionService,
];

/** apps/core: connect, OAuth callback, the webhook route and the management routes. */
@Module({
  imports: BASE,
  providers: [...ADAPTERS, ...APPLICATION, WebhookService],
  controllers: [
    IntegrationsController,
    IntegrationOAuthController,
    IntegrationWebhookController,
    ConflictController,
    QuarantineController,
    ReconcileController,
  ],
})
export class IntegrationsModule {}

/** apps/worker: queue consumers and jobs (later stories add their consumers and schedules here). */
@Module({
  imports: [...BASE, JobsModule],
  providers: [
    ...ADAPTERS,
    ...APPLICATION,
    SyncConsumer,
    BackfillConsumer,
    IntegrationsJobs,
  ],
})
export class IntegrationsWorkerModule {}

/** apps/projector: event consumers (product events, tenancy events; added by US4 and US8). */
@Module({
  imports: BASE,
  providers: [
    ...ADAPTERS,
    ...APPLICATION,
    ProductEventsConsumer,
    TenancyOffboardingConsumer,
    TenancyShopDeletedConsumer,
  ],
  // The projection framework builds the consumers in its own module, so what they inject must be exported.
  exports: [
    ...ADAPTERS.map((p) => (p as { provide: symbol }).provide),
    ...APPLICATION,
  ],
})
export class IntegrationsProjectorModule {
  /** Every consumer of this capability, for the projector app's list. */
  static readonly projectors = [
    ProductEventsConsumer,
    TenancyOffboardingConsumer,
    TenancyShopDeletedConsumer,
  ];
}
