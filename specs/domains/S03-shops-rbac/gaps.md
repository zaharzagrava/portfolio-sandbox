# Gaps: S03 — current `tenancy` code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/` unless stated; line numbers are those read on 2026-10-05. **Check not run:** `pnpm check:table-ownership` needs approval an unattended session cannot get, so section C is reconstructed from searches over `libs/` (every use of `Shop`, `ShopMembership`, `ShopInvite`, `ShopDirectory`, `ShopSsoConfig` and `@app/domains/tenancy`). Run the real check first and reconcile.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | No outbox, no events at all; every mutation commits without an event | `libs/domains/tenancy/application/shop.service.ts` (all methods) | FR-072, AS-78, Provides events |
| A2 | `create` writes identity's `User` table (`UPDATE "User" SET role`), injects the `User` model and clears an identity cache key | `application/shop.service.ts:27,46,49` | FR-001, FR-071, AS-01 (S01 consumer promotes) |
| A3 | `create` has no shop limit, no reserved slugs, no region, no code on the conflict (`Slug is taken`), returns the ORM model (payment-provider id included) | `application/shop.service.ts:40-55`; `api/shop.controller.ts:21` | FR-002, FR-003, FR-004, AS-02–AS-04 |
| A4 | `mine` and `members` are unbounded raw SQL; `members` joins identity's `User`; no pagination | `application/shop.service.ts:58-62,70-74` | FR-005, AS-07, AS-20; e-mails via R1 `UserDirectoryService.getUsersByIds` |
| A5 | `get` loads by primary key (`findByPk`) and returns `raw` | `application/shop.service.ts:66` | FR-004, FR-011, III.4 |
| A6 | Invite returns `inviteUrl` with the token to the inviter; uses `Date.now()` and `new Date()` | `application/shop.service.ts:78-84,94` | FR-030, AS-28; clock injected (I.3 spirit), token only in `tenancy.invite_requested` |
| A7 | Accept compares `user.email` (access tokens carry no e-mail), upserts and overwrites the role of existing members, runs the lookup under an RLS bypass with a free-text reason | `application/shop.service.ts:92-103`; `api/shop.controller.ts:55-58` | FR-032, FR-033, AS-32–AS-35 |
| A8 | No revoke, resend, seat limit, duplicate/pending check, per-shop unique pending invite, `acceptedBy`, `revokedAt`; list shows `acceptedAt: null` rows only and returns raw rows (digest included) | `application/shop.service.ts:86-89`; `infra/models/shop-invite.model.ts` | FR-006, FR-031, AS-28–AS-39 |
| A9 | `changeRole` / `removeMember`: no escalation rule (ADMIN can create owners), 422 on last owner, no event, no no-op detection, no self-leave route, no retry bound, no session revocation for SSO members | `application/shop.service.ts:112-135`; `api/shop.controller.ts:60-72` | FR-021–FR-023, AS-18–AS-26 |
| A10 | Permission matrix gives VIEWER `payouts.read`, ADMIN `sso.manage`; lacks `orders.read`, `shop.export`; `domain/permissions.ts` imports `ShopRole` from `infra/` (I.2) | `domain/permissions.ts:1,22-34` | FR-020, AS-16, AS-17 |
| A11 | Guard: cache has an in-process layer (`l1: 'hot'`), 60 s TTL, no sensitive-permission strong read, no status gate, no header/path mismatch check, 403 text names the permission, `api/` imports an `infra/` type | `application/membership.service.ts:22-24`; `api/shop.guard.ts:6,35-44,47-48` | FR-010–FR-015, AS-10, AS-12, AS-13 |
| A12 | SSO: no discovery/SSRF validation, secret sealed without context, `enabled` forced true, no read/disable, no `defaultRole`, returns a GET `loginUrl`, ADMIN allowed, no status check in the resolver, uses `OidcService.setResolver`/`register` | `application/shop-sso.service.ts:4,17-22,30-36`; `infra/models/shop-sso-config.model.ts` | FR-040–FR-043, AS-40–AS-46; S02 `OidcProviderRegistry` |
| A13 | No membership provisioning for shop-IdP users; no consumer of `identity.federated_identity_linked` | (missing) | FR-042, AS-47–AS-49 |
| A14 | `ShopTransactionRunner.crossTenant` accepts any reason string, no counter, no log; no startup check of the database role | `infra/shop-transaction.ts:28-36` | FR-053, AS-59, AS-60 |
| A15 | RLS only on `ShopInvite` and `ShopSsoConfig`; none on `ShopMembership`; no `WITH CHECK` proof | `migrations/20261001140000-shops-tenancy-expand.js:76-88` | FR-053, AS-57 |
| A16 | `ShopMembership.userId` has a foreign key to identity's `User`; `Product.shopId`, `ChatChannel.shopId` have FKs to `Shop` | `migrations/20261001140000-shops-tenancy-expand.js:35,73-74` | FR-054, AS-61, IX.4 (the last two are S05 / chat migrations) |
| A17 | Schema lacks: `Shop.planVersion`, `shopVersion`, `purgeAt`, `sandboxOf` (used by raw SQL but absent from model and migration), status `DELETED`, `ShopInvite.revokedAt/acceptedBy` and the partial unique index, `ShopDirectory.version`, `ShopSsoConfig.defaultRole`, membership `source`, status history table, `ShopMembership (userId, createdAt)` index for `mine` | `migrations/20261001140000-shops-tenancy-expand.js:23-71`; `infra/models/*.ts` | Key Entities, FR-006, FR-007, FR-050, AS-61 |
| A18 | Resolver silently falls back to the pooled database for an unknown cell, reads `process.env` directly, hard-codes pool size 10, has no acquire timeout, no cache invalidation hook, no directory service | `infra/tenant-connection.resolver.ts:25,32,38-47` | FR-050–FR-052, AS-51–AS-56 (config validated at startup, VIII.5) |
| A19 | No admin endpoints (suspend, reinstate, directory move), no status machine, no history | (missing) | FR-007, FR-050, AS-52, AS-64, AS-65 |
| A20 | No offboarding, export, purge job or tombstone | (missing) | FR-060–FR-062, AS-66–AS-70 |
| A21 | No consumers for verification (`shop.*`) or plan changes; seller-onboarding writes `Shop` itself | (missing); see C | FR-008, AS-71–AS-73 |
| A22 | Backfill job runs raw SQL on `Product` and `ChatChannel`, uses `Date.now()`, owns the NOT NULL contract constraint on another domain's table | `infra/tenancy-backfill.jobs.ts:33,52,56,64,72-83` | FR-055, AS-62: replace by `ShopProvisioningService.ensureShopsForLegacySellers`; delete the job and register nothing in `TenancyWorkerModule` except the new purge jobs |
| A23 | Batch read controller issues raw SQL (II.1), shows suspended and closing shops, has no cap besides `parseIdList` | `api/shop-batch-read.controller.ts:15,22` | AS-80; move to a repository and `ShopQueryService` |
| A24 | Realtime topic policy reads the model directly and ignores status | `api/realtime-topics.ts:5,18-21` | AS-83 |
| A25 | Controller and DTOs: `UserRawDto` instead of `AuthenticatedUser`, DTOs not in `packages/contracts`, no response DTOs, no problem+json codes from FR-100, no rate-limit policies, no `Firewall({ sensitive })` on admin routes | `api/shop.controller.ts:5,20-78`; `api/tenancy.dto.ts` | V.1, V.2, V.3, FR-090, FR-100, AS-79 |
| A26 | Layering: `application/` and `api/` import `infra/` models and runners directly (D-6) | `application/shop.service.ts:6-9,15`; `application/membership.service.ts:3`; `application/shop-sso.service.ts:5,6`; `api/shop.guard.ts:6` | I.2: repository ports in `domain/`, adapters in `infra/` |
| A27 | Module imports and registers identity's `User` model and `AuthModule`; global module exports `ShopService` | `tenancy.module.ts:8,31,34` | FR-071; export only R1 services |
| A28 | Barrel exports five models, `MembershipService`, `ShopBatchReadModule`, `ShopTopicsModule` | `index.ts:7-15` | FR-070, X.4; export R1 services, `ShopScoped`, DTOs and event contracts; drop models after C is done |
| A29 | Existing e2e covers 5 of 83 scenarios; seeds memberships through the model; concurrency case calls the service, not HTTP; no outbox, validation, 401, replay or consumer assertions | `tenancy.e2e-spec.ts:87-98,119-128` | `test-plan.md`: split into the files named there |

## B. Debt-register rows (open) that name `tenancy` or S03

| Row | What | Replacement for tenancy's part |
|---|---|---|
| D-6 | Layering inside the domain (`api/` and `application/` import `infra/`) | A26: ports in `domain/`, adapters in `infra/`; the guard depends on a port (`MembershipReader`) |
| D-7 | Other domains import `ShopModel`, `ShopMembershipModel` | **R1** `ShopQueryService`, `ShopAccessService`, `MembershipQueryService`; then remove the five model exports from the barrel (C1) |
| D-8 | Barrel exports internals; `OidcService` is used by tenancy | **R1** `OidcProviderRegistry` (S02); tenancy's own barrel per A28 |
| D-12 | Raw SQL on tables owned by another domain | Both directions: others reading tenancy tables (C2) → R1 / R3; tenancy reading others (A2, A4, A22) → R1 `UserDirectoryService`, owner-run backfills |

D-4 (batch reads) is resolved in the register, but the controller still runs raw SQL (A23); treat it as a regression of II.1 to fix here. D-15 and D-11 do not involve tenancy.

## C. `check:table-ownership` lines for this domain (reconstructed)

### C1. Others using tenancy models (MODEL rows) → R1, then drop the barrel exports

| Where | Use | Mechanism |
|---|---|---|
| `libs/domains/notifications/infra/notification-router.projector.ts:3,27` | injects `ShopMembership` to find recipients | R1 `MembershipQueryService.getMembersByShopIds` (batch) or an R3 projection of `tenancy.member_*` events inside notifications |
| `libs/domains/launch-events/live.module.ts:4,10`; `api/live.controller.ts:7,35` | `forFeature([ShopMembership])`, `@InjectModel(ShopMembership)` | R1 `ShopAccessService.assertMember` / `getRole` |
| `libs/domains/payments/infra/payout.jobs.ts:5`; `payments/finance-worker.module.ts:4` | reads `Shop` (payout settings, payment-provider account id) | R1 `ShopQueryService.getShopsByIds` for status/verification; payment-provider account id moves into payments' own table (S14/S15) |
| `libs/domains/auctions/application/auction.service.ts:7,47` | injects `MembershipService` (an application service, but not an R1 contract) | R1 `ShopAccessService` |
| Test fixtures: `statements.e2e-spec.ts:10`, `auctions.e2e-spec.ts:11,92`, `seller-insights/crawler.e2e-spec.ts:16,20,81`, `leaderboards.e2e-spec.ts:11`, `seller-onboarding/onboarding.e2e-spec.ts:15,22,88`, `assistant/knowledge.e2e-spec.ts:17,26,87`, `catalog/collab.e2e-spec.ts:16,27,111`, `notifications/notifications.e2e-spec.ts:14,27`, and ~20 more (`grep ShopModel libs/domains --include=*.e2e-spec.ts`) | seed shops and memberships through the models | shared fixtures `createShop` / `addMember` in `test/` (test code may touch every table, IX.6); no barrel model export remains |

### C2. Others running SQL on tenancy tables (SQL rows) → R1 for lookups, R3 for lists

| Where | Query | Mechanism |
|---|---|---|
| `seller-insights/application/leaderboard.service.ts:58,69` | `LEFT JOIN "Shop"`, `SELECT name FROM "Shop"` | list: R3 read model of shop name from `tenancy.shop_created/updated` (owner S40); single lookup: R1 `getShopsByIds` |
| `seller-insights/application/crawler.service.ts:155` | `JOIN "ShopMembership" … role = 'OWNER'` | R1 `MembershipQueryService.getMembersByShopIds(shopIds, ['OWNER'])` |
| `content/application/stories.service.ts:100,115,175` | `SELECT slug FROM "Shop"`, `JOIN "Shop"` for story lists and sitemap | single: R1 `getShopsByIds`; lists and sitemap: R3 projection of slug/name into content (S27) |
| `developer-platform/application/api-keys.service.ts:124-129` | `INSERT INTO "Shop"` for sandboxes, `SELECT … WHERE "sandboxOf"` | R1 `ShopProvisioningService.ensureSandboxShop` (A17) |
| `developer-platform/application/webhook-deliverer.service.ts:132` | owners and admins of a shop | R1 `getMembersByShopIds(shopIds, ['OWNER','ADMIN'])` |
| `developer-platform/application/public-catalog.service.ts:96,114` | `JOIN "Shop"` on product lists and detail | lists: R3 shop fields in the catalog read model (S42/S32); detail: R1 `getShopsByIds` |
| `developer-platform/application/widget.service.ts:96` | `SELECT name FROM "Shop"` | R1 `getShopsByIds` |
| `seller-onboarding/application/onboarding-session.service.ts:59`; `verification.service.ts:49` | `UPDATE "Shop"` verification and payouts flag | events `shop.onboarding_submitted`, `shop.verified` consumed by tenancy (A21); S04 stops writing |
| `seller-onboarding/application/review.service.ts:43` | `JOIN "Shop"` for the review queue | R1 `getShopsByIds` (domain-map §2) |
| `catalog/infra/product-search.projector.ts:40` | `SELECT id FROM "Shop" WHERE "sandboxOf" IS NOT NULL` | R1 `getShopsByIds` (`isSandbox`) or carry `isSandbox` on the product event (S32) |
| `catalog/application/drafts.service.ts:68` | `SELECT role FROM "ShopMembership"` | R1 `ShopAccessService.getRole` |
| `seller-onboarding/onboarding.e2e-spec.ts:112` | test reads `"Shop"` directly | allowed in tests (IX.6) via fixture helper |

### C3. Tenancy's own cross-domain access (to be zero)

| Where | Access | Mechanism |
|---|---|---|
| `application/shop.service.ts:27,46,71` | `User` model injected; `UPDATE "User"`; `JOIN "User"` | R1 `UserDirectoryService`; S01 consumes `tenancy.shop_created` (A2) |
| `tenancy.module.ts:8,31` | `forFeature([…, User])` | drop; import the identity module only for R1 services |
| `infra/tenancy-backfill.jobs.ts:33,52,56,72-83` | raw SQL on `Product`, `ChatChannel` | owner-run backfills with R1 `ensureShopsForLegacySellers` (A22) |
| `application/shop-sso.service.ts:4,17-22,36` | `OidcService.setResolver/register` (barrel coupling) | R1 `OidcProviderRegistry` (S02) |
| `migrations/20261001140000-shops-tenancy-expand.js:35,73-74` | foreign keys across owners | drop in an expand/contract migration (A16) |

## D. Suggested order

1. Schema (expand): columns and tables of A17, RLS on membership (A15), drop the FK to `User` (A16), `DELETED` status; migration scenario AS-61 first.
2. Domain pure logic: permission matrix, `canManage`, shop and verification state machines, seat policy; their unit tests (AS-16–AS-18, AS-64, AS-71).
3. Repositories and ports (A26), outbox integration (A1), guard rewrite (A11), DTOs and contracts (A25).
4. Members, invites, shops (A3–A9), then SSO (A12, A13), cells (A18, A19), offboarding (A20), consumers (A21).
5. R1 services and barrel (A28); migrate consumers in C1 and C2 in their capabilities' PRs, then drop the model exports; make `check:table-ownership --strict` a gate for tenancy's tables.
6. Delete the backfill job (A22) once S05 and the chat domain call the R1 provisioning service.
7. Split `tenancy.e2e-spec.ts` into the files of `test-plan.md` (A29).
