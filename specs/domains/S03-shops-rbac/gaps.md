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

## Sibling-spec follow-ups

Things S03's work changes that another capability's spec relies on. Their specs are not edited from here.

- **S01**: add a consumer of `tenancy.shop_created` v1 that promotes a `USER` owner to `SELLER` (conditional, idempotent); tenancy no longer writes `User` or clears `auth:user:v1:<id>`. Keep `UserDirectoryService`, `SessionRevocationService.revokeAllForUser(userId, 'shop_membership_removed')` and `SecretBox` contexts stable (tenancy depends on them).
- **S02**: `OidcProviderRegistry` has no `registerResolver` / `invalidate` and `OidcService` is still injected by `tenancy/application/shop-sso.service.ts` (checked 2026-10-10). If S02's pass did not land them, S03 adds the two additive methods (WP-7); S02 must adopt them in its `oidc-providers` tests and keep emitting `identity.federated_identity_linked` with `provider = shop:<uuid>` on the first shop-IdP login, including account-creating logins.
- **S04**: emit `shop.onboarding_submitted`, `shop.verified`, `shop.rejected` `{shopId}`; stop `UPDATE "Shop"` in `onboarding-session.service.ts:59` and `verification.service.ts:49`; use `ShopQueryService` in `review.service.ts:43`.
- **S05**: call `ShopProvisioningService.ensureShopsForLegacySellers` (≤ 200) in its shop-id backfill, own the NOT NULL contract step on `Product.shopId`, drop the foreign key `Product.shopId → Shop`.
- **S06, S23, S41, S43, S40, S27, S42, S32, S44, S15, S16, S17, S28**: replace direct use of `ShopModel`, `ShopMembershipModel`, `MembershipService` and raw SQL on tenancy tables with `ShopAccessService`, `ShopQueryService`, `MembershipQueryService` (rows of sections C1/C2). `payouts.read` routes now exclude VIEWER, `sso.manage` excludes ADMIN, and `ShopScoped` routes answer `403 shop_suspended` / `409 shop_offboarding` for write permissions on closed shops: retest them.
- **S14, S15**: take over the payment-provider account id (`Shop.stripeAccountId`) into a table they own; tenancy drops the column afterwards; `payments/infra/payout.jobs.ts` stops reading `Shop`.
- **S17**: emit `billing.subscription_plan_changed {shopId, plan, version}` with a per-shop monotonic `version`.
- **S28**: consume `tenancy.invite_requested` (token; link `<front>/invites/<token>`) and the offboarding events (owners via `MembershipQueryService.getMembersByShopIds(ids, ['OWNER'])`).
- **S51**: close open subscriptions to `shop:<id>:*` for the user on `tenancy.member_removed`.
- **S49, S50, S53, S54**: nothing to change; tenancy registers its six policies and two jobs with their toolkits as documented.
- **Chat domain**: drop the foreign key `ChatChannel.shopId → Shop`, run its own backfill through `ensureShopsForLegacySellers`.
- **W04**: `/invites/<token>`, shop switcher, team and roles screens from `GET /shop-roles` and `myPermissions`; lists are now `{items, nextCursor}`. `GET /shop-roles` answers `{roles: {OWNER: [...], ADMIN: [...], STAFF: [...], VIEWER: [...]}, permissions: [...]}` (spec.md AS-82; contracts/http.md writes it shorter).
- **S28** (added in the P1 pass): the invite message is an outbox task on queue `tenancy-invite-requested`, type `tenancy.invite_requested`, body `{inviteId, shopId, shopName, email, role, token, expiresAt, invitedBy}` (`aggregateId` = shopId). It is not on `tenancy.events`.
- **S01** (added in the P1 pass): the foreign key `ShopMembership.userId → User` is dropped (contract migration `20261010141000-tenancy-s03-contract-fks`), so deleting a user no longer cascades to memberships. Identity's account deletion must tell tenancy (a `identity.user_deleted` consumer is not built yet) or leave the orphan row; the guard answers `404` for such a user anyway because no session exists.
- **All domains with shop e2e specs** (added in the P1 pass): seed shops and members with `createShop`, `addMember`, `createInvite` from `test/utils/tenancy-fixtures.ts` (written for S03) instead of the models; `ShopMembership` rows now carry `source` (defaults to `provisioned`).

## Deferred until a later pass

This pass built the Setup and Foundational phases and the stories of priority P1: US1, US2, US3, US4, US5, US8 and US10. Not started (P2 and cross-cutting), with what each waits for:

| Story / task | Scenarios | Waits for |
|---|---|---|
| US6 company sign-in per shop (T045–T051) | AS-40–AS-50; FR-090 `tenancy.sso-lookup.ip`; `sso_*` error codes | a later pass; needs S02's `OidcProviderRegistry.registerResolver/invalidate` (not present: checked 2026-10-10, T005 not done; `OidcService.setResolver/register` still exist and `shop-sso.service.ts` still uses them, only its permission moved to `sso.manage`) and S01's `SecretBox` context seal (exists). `identity.federated_identity_linked` is emitted by S02 (built) |
| US7 cells (T052–T054) | AS-51–AS-56; the `dedicated-1` half of III.12; `unknown_cell`, `cell_unavailable`, `stale_version` | a later pass; needs a second Postgres in `docker-compose.test.yaml` (T004 part, not added in this pass) |
| US9 offboarding and lifecycle (T060–T063) | AS-65–AS-70, AS-72, AS-73; `confirmation_mismatch`; the DELETED-tombstone purge | a later pass; verification and plan consumers wait for S04 (`shop.*` events) and S17 (`billing.subscription_plan_changed`), which have no `.implemented` marker. The status machine (`nextState`) and `ShopStatusHistory` are built and unit-tested; the guard already applies the status gate |
| Jobs and cleanup (T073–T075) | purge jobs, `declareJobType` for them, `InvalidScheduleError` catch | US9. `tenancy.backfill-shops` (`infra/tenancy-backfill.jobs.ts`, the one direct `sequelize.transaction`, two table-ownership findings) stays until S05 and chat call `ensureShopsForLegacySellers`; T076 (the old `tenancy.e2e-spec.ts`) is done because the P1 work made it uncompilable |
| Polish, cross-cutting (T077–T082) | AS-77 static half ("barrel without models") | consumers of sections C1/C2; `tenancy-exports.e2e-spec.ts` pins the transitional model list so it can only shrink |
| Admin routes, export, offboarding routes (the by-slug lookup and the plan consumer were built in the gate repair, see Gate repairs) | parts of AS-05, AS-09, AS-15, AS-79 that name them | with US6, US7 and US9; the `tenancy-resolution` route table lists only built routes |

## Gate repairs

The gate failed with "no test carries AS-46, AS-73". Both scenarios are cited by P1 stories (AS-05 in US1, AS-31 in US5), so the checker treats them as required even though their own stories (US6, US9) are deferred. The parts that need nothing unbuilt were built, with real tests:

- **AS-46** `GET /shops/by-slug/:slug/sso` (anonymous, `tenancy.sso-lookup.ip`): `ShopSsoService.publicLookup`, `SsoController.lookup`; `shop-sso.e2e-spec.ts` covers the `200` body, the identical `404` for an unknown slug, a disabled configuration, a suspended shop and a shop without SSO, and the `429` on the 31st call. The rest of US6 (T045–T051) stays deferred, so its tasks are not ticked.
- **AS-73** consumer of `billing.subscription_plan_changed` (`infra/shop-plan.consumer.ts`, registered in `TenancyWorkerModule` through `ProjectionsModule.forProjectors`; `ShopRepository.applyPlan` is the version guard). `tenancy-consumers.e2e-spec.ts` covers the change plus `tenancy.shop_plan_changed`, older/equal/duplicate ignored, invalid payload as `PermanentError`, and the AS-31 effect (raised plan admits an invite, lowered plan removes nobody). The tests call the consumer's entry point (`project`) with real envelopes; the broker round trip (offsets, the dead-letter topic itself) is the framework's, proven by S53, and is not exercised here. S17 does not emit the event yet, so nothing publishes it in production. AS-72 (verification events) and the rest of US9 stay deferred.
- **Test integrity (`tenancy.e2e-spec.ts` deleted)**: the gate forbids deleting a test file and requires at least as many `it()`/`expect()` calls as at HEAD. T076 had deleted the file; it is recreated at `libs/domains/tenancy/tenancy.e2e-spec.ts` as a regression spec on the S03 API with the same six cases (BOLA, invite → accept → role, write skew, RLS backstop, cache invalidation, shop creation/mine). The seller-promotion case now asserts that creating a shop does not touch the `User` row (promotion is S01's consumer, see Sibling-spec follow-ups). The count by the gate's regex is 38 against 33 at HEAD; the spec passes (6/6). It has no direct `sequelize.transaction` (the old test-only site is gone). `check-tests.py integrity` itself needed an approval this pass could not get; the counts were checked with the same regex by hand. Run it before merging.
- Not run: `scripts/sdd/check-tests.py scenarios` needed an approval this pass could not get; the titles were confirmed with a search (`it('S03 AS-46: …')`, `it('S03 AS-73: …')`). Run it before merging.

## Baseline (T001–T005, recorded 2026-10-10 before the work)

- `pnpm check:table-ownership`: tenancy had 5 findings: SQL `Product` and `ChatChannel` in `infra/tenancy-backfill.jobs.ts`, SQL `User`, MODEL `UserModel` in `application/shop.service.ts`, MODEL `UserModel` in `tenancy.module.ts`. After this pass: 2 (the backfill job, deferred). Rows of C1/C2 (other domains reading tenancy tables) are reproduced by the gate as 20 findings in 11 domains: unchanged, theirs to migrate. Total went 87 → 84.
- `pnpm check:boundaries`: 0 errors before; 0 errors after (61 pre-existing `x5-no-circular` warnings, none in tenancy).
- Direct `sequelize.transaction` in `libs/domains/tenancy`: 1 production site (`tenancy-backfill.jobs.ts:47`, deferred) plus the test-only site in the old `tenancy.e2e-spec.ts`, now deleted. No site added.
- Follow-up greps in tenancy before: `InjectModel(User)` 1, `"User"` join 1, `User` in `forFeature` 1, `OidcService` 1 (kept, SSO deferred), `Firewall({ throttle` 0, `JobsService.cancel` 0. After: the first three are gone.
- `ShopScoped(` consumers outside tenancy: 80 routes in 20 domains (payouts.read: payments finance, statements; shop.manage: developer-platform, seller-onboarding, catalog-sync, shop-functions; billing.manage: billing; the rest products/orders). Their suites were run after the P1 work (28 suites): 24 pass; 4 fail with `ResponseError: Keyspace 'marketplace' does not exist` (ScyllaDB keyspace missing in this sandbox: assistant, notifications, seller-insights crawler, developer-platform webhooks), unrelated to tenancy and not re-run.
- Test stack: the Postgres of `docker-compose.test.yaml` is used as is; the non-superuser probe roles are created idempotently by the specs through `test/utils/tenancy-roles.ts` (no compose change in this pass); the second database for cell `dedicated-1` is deferred with US7.

## Decisions taken while implementing (P1 pass)

- **Column names kept**: `ShopInvite.tokenHash` (data-model.md says `tokenDigest`) and `ShopSsoConfig.clientSecretEnc` (`secretSealed`) keep their existing names; renaming a column is not expand-only. Only the digest is stored either way.
- **Region** lives in `ShopDirectory.region` (the only place the table has it); `Shop` has no `region` column, the DTO joins it. Allowed regions come from the new config key `TENANCY_REGIONS` (comma list, first is the default; default `eu-central-1,us-east-1`).
- **Request bodies** use class-validator DTOs through the platform's global pipe (`validation_failed` with `errors[]`), the same as identity; the zod schemas in `packages/contracts/src/tenancy` describe the responses and are what the e2e specs parse.
- **Removing a member** is guarded by `shop.read` in the controller, because every member may remove themselves; removing someone else asks `ShopAccessService.resolve(…, 'members.manage')` (strong read, status gate) inside the service. A viewer removing another gets `403 permission_denied`.
- **Event version**: member and invite events carry the shop's current `shopVersion` as `aggregateVersion` (they do not bump it); only `Shop` writes bump it.
- **Accept** refuses (uniform `404 invite_not_found`) when the shop is not `ACTIVE`; an expired-but-unrevoked pending invite may be resent (it becomes pending again) and is revoked when the same address is invited again.
- **AS-23**: of a pair of simultaneous owner actions exactly one succeeds; the loser is `409 last_owner` or `403 insufficient_role` (the winner may already have demoted the loser's role), never a second success.
- **AS-14** is proven through the request context (the values the platform logger mixin reads) and the event envelopes; the structured logger itself is not in the test stack.
- **Authorization cache**: entries carry their write time from the injected clock, so the 15 s / 10 s windows hold with a frozen clock; the Redis TTL is a hygiene bound only.
- **`MembershipService`** stays as a thin transitional wrapper over `ShopAccessService.getRole` for `auctions` (it is in the barrel's transitional block); it has no cache of its own.
- **Observability**: tenancy writes audit lines through its own `TenancyAudit` (`Logger('Audit')`, fields `action, actorId, shopId, requestId`) because identity's `AuditService` is not exported.
