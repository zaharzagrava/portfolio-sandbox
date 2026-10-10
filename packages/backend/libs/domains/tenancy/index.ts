/**
 * Public entry point of the `tenancy` domain (constitution X.4). Code outside this domain imports only from
 * `@app/domains/tenancy`: the module, the `ShopScoped` decorator, the R1 services and the event contracts.
 *
 * TRANSITIONAL (S03 plan Risk 1): the five models and `MembershipService` stay exported while the consumers listed in
 * `specs/domains/S03-shops-rbac/gaps.md` (sections C1 and C2) move to the services below. Do not add to this block;
 * delete a line when its last consumer is gone (`tenancy-exports.e2e-spec.ts` pins the list).
 */
export { default as ShopDirectoryModel } from './infra/models/shop-directory.model';
export { default as ShopInviteModel } from './infra/models/shop-invite.model';
export { default as ShopMembershipModel } from './infra/models/shop-membership.model';
export { default as ShopSsoConfigModel } from './infra/models/shop-sso-config.model';
export { default as ShopModel } from './infra/models/shop.model';
export { MembershipService } from './application/membership.service';

export { TenancyWorkerModule } from './tenancy-worker.module';
export { TenancyModule } from './tenancy.module';
export { ShopBatchReadModule } from './batch-read.module';
export { ShopTopicsModule } from './realtime-topics.module';
export { ShopScoped } from './api/shop.guard';
export { ShopAccessService } from './application/shop-access.service';
export { ShopQueryService } from './application/shop-query.service';
export { MembershipQueryService } from './application/membership-query.service';
export { ShopProvisioningService } from './application/shop-provisioning.service';
export type { ShopSummaryDto } from './application/shop-summary';
export { TenantConnectionResolver } from './infra/tenant-connection.resolver';
export { ShopTransactionRunner } from './infra/shop-transaction';
export { tenancyRatePolicies } from './domain/tenancy-rate-policies';
export type { ShopPermission } from './domain/permissions';
export type { ShopRole } from './domain/shop-types';
export {
  InviteCreated,
  MemberAdded,
  MemberRemoved,
  MemberRoleChanged,
  ShopCellMoved,
  ShopCreated,
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
  ShopPlanChanged,
  ShopStatusChanged,
  ShopUpdated,
  ShopVerificationChanged,
} from './domain/events';
