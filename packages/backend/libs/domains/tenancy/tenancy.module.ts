import { Global, Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Shop from './infra/models/shop.model';
import ShopMembership from './infra/models/shop-membership.model';
import ShopInvite from './infra/models/shop-invite.model';
import ShopDirectory from './infra/models/shop-directory.model';
import ShopSsoConfig from './infra/models/shop-sso-config.model';
import ShopStatusHistory from './infra/models/shop-status-history.model';
import { AuthModule, AuthApiModule } from '@app/domains/identity';
import { ApiConfigModule } from '@app/common/config';
import { ProblemCatalogModule } from '@app/common/errors';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { TENANCY_AGGREGATE } from './domain/events';
import { TENANCY_PROBLEMS } from './domain/errors';
import { tenancyRatePolicies } from './domain/tenancy-rate-policies';
import {
  AUTHZ_CACHE,
  DIRECTORY_REPOSITORY,
  INVITE_REPOSITORY,
  MEMBERSHIP_READER,
  MEMBERSHIP_REPOSITORY,
  SHOP_REPOSITORY,
  STATUS_HISTORY_REPOSITORY,
  TENANT_DB_ROLE_CHECK,
  TENANT_TRANSACTIONS,
} from './domain/ports';
import { TenantDbRoleCheck } from './infra/tenant-db-role.check';
import { SequelizeShopRepository } from './infra/models/shop.repository';
import { SequelizeMembershipRepository } from './infra/models/shop-membership.repository';
import { SequelizeInviteRepository } from './infra/models/shop-invite.repository';
import { SequelizeDirectoryRepository } from './infra/models/shop-directory.repository';
import { SequelizeStatusHistoryRepository } from './infra/models/shop-status-history.repository';
import { RedisAuthzCache } from './infra/authz-cache.redis';
import { ShopTransactionRunner } from './infra/shop-transaction';
import { TenantConnectionResolver } from './infra/tenant-connection.resolver';
import { ShopGuard } from './api/shop.guard';
import { ShopController } from './api/shop.controller';
import { ShopRolesController } from './api/shop-roles.controller';
import { SsoController } from './api/sso.controller';
import { MembersController } from './api/members.controller';
import { InvitesController } from './api/invites.controller';
import { InviteService } from './application/invite.service';
import { MembershipAdminService } from './application/membership-admin.service';
import { MembershipQueryService } from './application/membership-query.service';
import { ShopAccessService } from './application/shop-access.service';
import { ShopProvisioningService } from './application/shop-provisioning.service';
import { ShopQueryService } from './application/shop-query.service';
import { MembershipService } from './application/membership.service';
import { ShopService } from './application/shop.service';
import { ShopSsoService } from './application/shop-sso.service';
import { TenancyAudit } from './application/tenancy-observability';

/**
 * Multi-tenant shops (SD-02). Global so every domain module can use `@ShopScoped(...)`, `ShopTransactionRunner` and the
 * connection resolver. Identity is used through its exported services only; no `User` model here (IX.4).
 */
@Global()
@Module({
  imports: [
    ApiConfigModule,
    AuthModule,
    AuthApiModule,
    CacheModule,
    ClockModule,
    EventsModule.forAggregates([TENANCY_AGGREGATE]),
    ProblemCatalogModule.forFeature(TENANCY_PROBLEMS),
    RateLimitModule,
    RateLimitModule.forFeature(tenancyRatePolicies),
    SequelizeModule.forFeature([
      Shop,
      ShopMembership,
      ShopInvite,
      ShopDirectory,
      ShopSsoConfig,
      ShopStatusHistory,
    ]),
  ],
  providers: [
    { provide: SHOP_REPOSITORY, useClass: SequelizeShopRepository },
    {
      provide: MEMBERSHIP_REPOSITORY,
      useExisting: SequelizeMembershipRepository,
    },
    { provide: MEMBERSHIP_READER, useExisting: SequelizeMembershipRepository },
    SequelizeMembershipRepository,
    { provide: INVITE_REPOSITORY, useClass: SequelizeInviteRepository },
    { provide: DIRECTORY_REPOSITORY, useClass: SequelizeDirectoryRepository },
    {
      provide: STATUS_HISTORY_REPOSITORY,
      useClass: SequelizeStatusHistoryRepository,
    },
    { provide: AUTHZ_CACHE, useClass: RedisAuthzCache },
    { provide: TENANT_DB_ROLE_CHECK, useExisting: TenantDbRoleCheck },
    TenantDbRoleCheck,
    { provide: TENANT_TRANSACTIONS, useExisting: ShopTransactionRunner },
    ShopTransactionRunner,
    TenantConnectionResolver,
    TenancyAudit,
    ShopAccessService,
    MembershipService,
    ShopGuard,
    ShopService,
    ShopSsoService,
    MembershipAdminService,
    MembershipQueryService,
    InviteService,
    ShopProvisioningService,
    ShopQueryService,
  ],
  exports: [
    ShopAccessService,
    ShopQueryService,
    MembershipQueryService,
    ShopProvisioningService,
    MembershipService,
    ShopGuard,
    ShopTransactionRunner,
    TenantConnectionResolver,
  ],
  controllers: [
    ShopController,
    MembersController,
    InvitesController,
    ShopRolesController,
    SsoController,
  ],
})
export class TenancyModule {}
