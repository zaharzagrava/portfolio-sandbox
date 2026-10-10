# Contract: exported services (R1) of `@app/domains/tenancy`

All return DTOs, never models. Errors are `AppError` subclasses with FR-100 codes. Every method that takes ids is batched where the name says so.

| Export | Signature | Rules |
|---|---|---|
| `ShopAccessService` | `assertMember(shopId: ShopId, userId: UserId, permission?: ShopPermission): Promise<{ role: ShopRole }>`; `getRole(shopId, userId): Promise<ShopRole \| null>` | non-member, unknown, malformed or `DELETED` → not-found; missing permission → forbidden; status gate and strong read for sensitive permissions as the guard; cache as the guard |
| `ShopQueryService` | `getShopsByIds(ids: ShopId[]): Promise<Map<ShopId, ShopSummaryDto>>` | ≤ 500 (501 → `TooManyIdsError`-style validation error); one query; duplicates collapse; unknown absent; suspended and tombstoned included with status |
| `ShopSummaryDto` | `{ id, slug, name, plan, status, verificationStatus, payoutsEnabled, region, isSandbox, sandboxOf: ShopId \| null, shopVersion }` | no payment-provider id |
| `MembershipQueryService` | `getMembersByShopIds(shopIds: ShopId[], roles?: ShopRole[]): Promise<Map<ShopId, {userId, role}[]>>` | ≤ 500; one query; order `(shopId, createdAt, userId)`; runs under `crossTenant('membership.mine')`-style audited bypass only if RLS requires it (otherwise per-shop context is impossible for a batch) |
| `ShopProvisioningService` | `ensureShopsForLegacySellers(sellerIds: UserId[]): Promise<Map<UserId, ShopId>>`; `ensureSandboxShop(liveShopId: ShopId): Promise<ShopSummaryDto>` | ≤ 200 distinct; whole batch in one transaction; slug `seller-<id>`; second call creates nothing; sandbox: slug `<slug>-sandbox`, no members, refuses sandbox-of-sandbox, unknown live → not-found; bypass reason `legacy.provision` |
| `ShopCellService` | `cellOf(shopId): Promise<{ cell: string; region: string }>` | cache 5 min, dropped on move |
| `TenantConnectionResolver` | `connectionFor(shopId)` | per-cell pool; unknown/unreachable cell → `503 cell_unavailable`, never pooled |
| `ShopTransactionRunner` | `inShop(shopId, fn)`; `crossTenant(reason: CrossTenantReason, fn)` | reasons: `invite.accept`, `sso.provision`, `shop.purge`, `legacy.provision`, `membership.mine`; others throw before any query |
| `ShopScoped(permission?)` | decorator | authenticated + member + permission + status gate; puts `shopId`, role in the request context |
| `ShopPermission`, `ShopRole`, DTO types, event definitions | types | no model exports after consumers migrate (transitional exports listed in plan Risk 1) |

Tenancy consumes from identity only: `UserDirectoryService.getUsersByIds` / `findByEmail`, `SessionRevocationService.revokeAllForUser`, `SecretBox.seal/open(value, context)`, `OidcProviderRegistry.registerResolver/invalidate`, `Firewall`, `@User()`, `AuthenticatedUser`.
