---
id: tenancy-domain-layer
title: Tenancy domain layer
kind: term
status: draft
aliases: [tenancy domain]
defined_for: S03-shops-rbac
rules_hash: 5371fc18896b
---
# Tenancy domain layer
## Definition
The tenancy domain layer is the part of the tenancy code that holds the shop rules. It lives in the `domain` folder of the [tenancy capability](capability.md), apart from the `api` folder. The `api` folder holds the controllers, [`ShopGuard`](shop-guard.md) and the [realtime topics](realtime-topic.md). The domain layer decides questions such as which [role has which permission](role-permission-matrix.md) and whether a role may manage another role. It also [checks slugs](slug-policy.md), counts [seats](seat.md) against the [plan limit](plan-limit.md) and allows or refuses [shop status and verification moves](shop-status.md). It holds the domain errors too, such as the one behind [`shop_not_found`](shop-not-found.md). Design intent (not stated in the spec): keeping the rules apart from the HTTP code means every endpoint applies the same rule, and the rules can be tested without making a request.

## Example
Files in `packages/backend/libs/domains/tenancy/domain/` that the [S03 rules](rule-proof.md) point to:
```
permissions.ts           ROLE_PERMISSIONS     (S03.R-06)
role-policy.ts           canManage, canLeave  (S03.R-08, S03.R-09)
seat-policy.ts           MAX_OWNED_SHOPS, seatLimit (S03.R-12, S03.R-17)
slug-policy.ts           checkSlug            (S03.R-13)
invite-token.ts          digestInviteToken    (S03.R-14)
tenancy-rate-policies.ts tenancyRatePolicies  (S03.R-18)
cross-tenant-reason.ts   isCrossTenantReason  (S03.R-20)
shop-status.ts           nextState            (shop status lifecycle)
verification-status.ts   applyVerification    (verification lifecycle)
errors.ts                Domain_ShopNotFoundError (S03.R-01)
```

## Known gaps
- Not confirmed in the code: whether the domain layer is pure, meaning it has no database, cache or framework dependencies, or whether some of its functions reach the store.
- The spec does not say which folder holds the exported services (`ShopAccessService`, `ShopQueryService`, `MembershipQueryService`, `ShopProvisioningService`, `ShopCellService`). It also does not say whether they belong to this layer.
- The spec does not say whether other capabilities may import domain functions directly or must use the exported services.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-07
- [apply-verification](apply-verification.md)
- [capability](capability.md)
- [is-cross-tenant-reason](is-cross-tenant-reason.md)
- [max-owned-shops](max-owned-shops.md)
- [onboarding-verify-pending-job](onboarding-verify-pending-job.md)
- [plan-limit](plan-limit.md)
- [realtime-topic](realtime-topic.md)
- [reseal-sso-secrets-job](reseal-sso-secrets-job.md)
- [role-permission-matrix](role-permission-matrix.md)
- [rule-proof](rule-proof.md)
- [seat](seat.md)
- [shop-access-service](shop-access-service.md)
- [shop-cell-moved-event](shop-cell-moved-event.md)
- [shop-cell](shop-cell.md)
- [shop-guard](shop-guard.md)
- [shop-onboarding-submitted-event](shop-onboarding-submitted-event.md)
- [shop-rejected-event](shop-rejected-event.md)
- [shop-status-changed-event](shop-status-changed-event.md)
- [shop-status-history](shop-status-history.md)
- [shop-status](shop-status.md)
- [shop-verification-changed-event](shop-verification-changed-event.md)
- [shop-verified-event](shop-verified-event.md)
- [slug-policy](slug-policy.md)
- [tenancy-shop-events](tenancy-shop-events.md)
<!-- used-by:end -->
