import { Global, Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Shop from './infra/models/shop.model';
import ShopMembership from './infra/models/shop-membership.model';
import ShopInvite from './infra/models/shop-invite.model';
import ShopDirectory from './infra/models/shop-directory.model';
import ShopSsoConfig from './infra/models/shop-sso-config.model';
import {
  UserModel as User,
  AuthModule,
  AuthApiModule,
} from '@app/domains/identity';
import { ApiConfigModule } from '@app/common/config';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { MembershipService } from './application/membership.service';
import { ShopGuard } from './api/shop.guard';
import { ShopTransactionRunner } from './infra/shop-transaction';
import { TenantConnectionResolver } from './infra/tenant-connection.resolver';
import { ShopService } from './application/shop.service';
import { ShopSsoService } from './application/shop-sso.service';
import { ShopController } from './api/shop.controller';

/**
 * Multi-tenant shops (SD-02). Global so every domain module can use
 * `@ShopScoped(...)`, `ShopTransactionRunner` and the connection resolver.
 * Needs global Redis + Cache modules.
 */
@Global()
@Module({
  imports: [
    ApiConfigModule,
    AuthModule,
    AuthApiModule,
    CacheModule,
    SequelizeModule.forFeature([
      Shop,
      ShopMembership,
      ShopInvite,
      ShopDirectory,
      ShopSsoConfig,
      User,
    ]),
  ],
  providers: [
    MembershipService,
    ShopGuard,
    ShopTransactionRunner,
    TenantConnectionResolver,
    ShopService,
    ShopSsoService,
  ],
  exports: [
    MembershipService,
    ShopGuard,
    ShopTransactionRunner,
    TenantConnectionResolver,
    ShopService,
  ],
  controllers: [ShopController],
})
export class TenancyModule {}
