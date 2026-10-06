/**
 * Public entry point of the `tenancy` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/tenancy`. Generated from actual cross-domain usage in Phase 2; extend it by
 * hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export { default as ShopDirectoryModel } from './infra/models/shop-directory.model';
export { default as ShopInviteModel } from './infra/models/shop-invite.model';
export { default as ShopMembershipModel } from './infra/models/shop-membership.model';
export { default as ShopSsoConfigModel } from './infra/models/shop-sso-config.model';
export { default as ShopModel } from './infra/models/shop.model';
export { TenancyWorkerModule } from './tenancy-worker.module';
export { TenancyModule } from './tenancy.module';
export { ShopScoped } from './api/shop.guard';
export { MembershipService } from './application/membership.service';
export { ShopBatchReadModule } from './batch-read.module';
export { ShopTopicsModule } from './realtime-topics.module';
