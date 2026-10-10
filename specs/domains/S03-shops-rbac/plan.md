# Implementation Plan: S03 — Shops as Tenants (domain `tenancy`)

**Branch**: `S03-shops-rbac` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md`.

## Summary

S01, S02, S49, S50, S53 and S54 are built; `tenancy` is the oldest domain and still reads and writes identity's tables, has no events, and puts business rules in `api/` and `application/` on top of `infra/` models. The plan rebuilds it in the S01/S02 shape without changing the table owner: pure rules in `domain/` (permission matrix, `canManage`, shop status machine, verification machine, seat policy, slug rules, cursor); repository ports in `domain/ports` with adapters in `infra/`; every mutation one `TransactionRunner.run` with `OutboxService.append` inside; conditional updates assert one affected row (invite use, status, directory version); the "keeps an owner" invariant under serializable isolation with bounded jittered retry; seat and shop-limit checks serialised with a per-shop row lock and a per-user advisory lock. The guard becomes a thin adapter over `ShopAccessService` (shared-store cache 15 s, strong read for sensitive permissions, status gate, answer order 401 → 404 → 403 → status). RLS is extended to `ShopMembership` and the bypass is an allowlist with counter and startup role check. SSO is re-wired to `OidcProviderRegistry.registerResolver('shop:', …)` with discovery through `safeRequest`, secrets sealed with context `shop-sso:<shopId>`, and membership provisioning as a consumer of `identity.federated_identity_linked`. Cells fail closed with per-cell bounded pools. Offboarding, purge jobs (S49), verification and plan consumers, the five R1 services and a model-free barrel finish the capability; the old backfill job and the cross-owner foreign keys are removed.

Follow-ups from built specs, treated as requirements:

| From | Requirement | Where planned |
|---|---|---|
| S01 | drop `@InjectModel(User)`, the `"User"` join in `shop.service.ts` and `User` in `tenancy.module.ts`; use `UserDirectoryService` | WP-3 (no `User` anywhere in tenancy), WP-4 (members list batch), WP-5 (accept) |
| S01 | principal is `{id, role, sessionId, amr}`, no e-mail; finish `ShopController.accept` move; type `@User()` as `AuthenticatedUser` | WP-5 (accept compares address from the directory), WP-3 (controllers) |
| S01 | replace any `Firewall({ throttle … })` | none present (`grep` over `tenancy`: only `Firewall()` and `Firewall({anonymous})`); routes get `@RateLimit` policies (WP-1, WP-3); a lint-style assertion in `tenancy-errors` is not needed, the type already rejects the option |
| S02 | `OidcService.setResolver/register` gone: register `shop:` via `OidcProviderRegistry.registerResolver`, `invalidate('shop:<id>')` after every change, pass the plain secret opened with `SecretBox`; issuer `https` message at configure time; membership provisioning from `identity.federated_identity_linked` / `identity.user_registered`; shop-IdP accounts have `email = null` and never link by e-mail | WP-7 (adopt the S02 minimal edit, own the rest), WP-7 consumer |
| S49 | `declareJobType` with a payload contract next to the `JobPayloads` augmentation for every job; adapt to the discriminated `JobsService.cancel` result; catch `InvalidScheduleError` | WP-9 (`tenancy.purge-deleted-shops`, `tenancy.purge-expired-invites`; the backfill job and its `JobPayloads` entry are deleted; `upsertSchedule` wrapped in the `InvalidScheduleError` catch; no `cancel` caller exists in tenancy, verified in WP-0) |
| S54 rule (4) | no new direct `sequelize.transaction`; migrate the site in `tenancy-backfill.jobs.ts:47` and delete its `// S54 T037 audit` comment | WP-10 deletes the file (baseline 1 → 0); every new transaction uses `TransactionRunner.run` / `@Transactional` |
| gaps.md | every item A1–A29, B (D-6, D-7, D-8, D-12), C1–C3 | Gap coverage table below |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; `packages/backend`, domain `tenancy`; schemas in `packages/contracts`; web screens are W04's (not a deliverable).

**Primary Dependencies**: existing: `@nestjs/sequelize` + `sequelize-typescript`, `TransactionRunner` / `@Transactional` (`@app/infrastructure/context`), `OutboxService` + `defineEvent` (`@app/infrastructure/events`), projection consumers (`Projector`, idempotency `inbox`; `@app/infrastructure/projections`), `InboxService`, S50 `definePolicies` / `@RateLimit` / `RateLimiterService`, S49 `JobHandler` / `declareJobType` / `JobsService.upsertSchedule`, `safeRequest` (`@app/infrastructure/net`), `MetricsRegistry`, `AuditService`, `ApiConfigService`, `CLOCK`, from identity `UserDirectoryService`, `SessionRevocationService`, `SecretBox`, `OidcProviderRegistry`, `Firewall`, `@User()`, `AuthenticatedUser`. Test only: `fast-check` (present), S02's `test/fakes/fake-oidc-provider.ts`. No new runtime dependency.

**Storage**: PostgreSQL pooled control plane (tenancy tables, expand-only plus one contract step with `lock_timeout`; one new table `ShopStatusHistory`; new columns; RLS on `ShopMembership`); a second PostgreSQL database as cell `dedicated-1` in tests (cell-resident data of other domains only); Redis for the authorization cache (shared store, 15 s) and S50 counters.

**Testing**: Jest e2e via `/opt/sdd/repo/scripts/sdd/test-spec.sh`; table-driven unit specs for the four pure modules; real Postgres/Redis, a non-superuser application role plus an RLS probe role; fakes only for the OIDC provider, DNS in the SSRF guard, mail (outbox message read instead) and clock ([test-plan.md](test-plan.md)). Playwright journey is W04's.

**Target Platform**: Linux containers: `apps/core` hosts controllers and guard; `apps/worker` hosts jobs and consumers (`TenancyWorkerModule`).

**Project Type**: web-service (backend domain) + contracts package.

**Performance Goals**: guard resolution one Redis read (non-sensitive) or one indexed PK read (sensitive); `mine`/`members`/`invites` one query per page plus one batched directory call; `getShopsByIds`/`getMembersByShopIds` exactly one query for ≤ 500 ids; cell lookup zero queries when cached.

**Constraints**: no network I/O in a transaction (SSO discovery before, revocation and cache delete after commit); no `User` access; cache never a source of truth (III.9); serializable only where the owner invariant needs it, 3 attempts; every error problem+json with a FR-100 code; metrics carry no shop/user label; migrations expand/contract, reversible, `lock_timeout`; every pooled, per-cell and probe connection or role carries a `statement_timeout` (III.12, below).

### Pool arithmetic and `statement_timeout` (III.12)

- **Pooled control plane**: tenancy adds no pool. It uses the shared pool of S54 (`db_pool_max` P = 10 × 12 DB-holding instances at the production ceiling = 120, plus replica 30 = 150, under `max_connections` 200 with 25 reserved; see S54 plan "Pool arithmetic").
- **Each cell** (`TENANCY_CELLS`, own database and own `max_connections`, default 100 with 20 reserved): per-cell pool max C (default 5) × instances that route to cells (core 6 + worker 4 = 10; the projector and bff apps never open a cell pool) = 50, under 80 usable. A cell with a different limit sets its own C; boot validation rejects `C × max_instances` ≥ the cell limit minus reserved (same rule as AS-144, T053).
- **`statement_timeout`**: the pooled pool and every cell pool take `statement_timeout` from `ApiConfigService.db_statement_timeout_ms` (dialect option, so it holds on each pooled connection). The application role and the RLS probe role used in tests are created with `ALTER ROLE … SET statement_timeout`, so a connection that bypasses the app pool still has one. `tenancy-startup` (T057) reads `SHOW statement_timeout` through each pool and fails boot on `0`/unset.

**Scale/Scope**: 25 HTTP routes (most re-shaped, the rest new), 6 tables (1 new), 13 events + 1 single-consumer message, 3 projectors (identity, onboarding, billing topics), 6 rate policies, 2 jobs, 5 R1 services, 83 acceptance scenarios (nineteen e2e files, four unit specs, one W04 journey).

## Constitution Check

*GATE before Phase 0; re-checked after Phase 1.*

| Rule | Status | How |
|---|---|---|
| I.1 / I.2 / D-6 layering | Pass (closes the tenancy part of D-6) | `api/` → `application/` → ports in `domain/ports`; adapters, models and runners only in `infra/`; the guard depends on `MembershipReader`; `domain/permissions.ts` stops importing `ShopRole` from `infra/` |
| I.3 clock | Pass | `CLOCK` injected; no `Date.now()` / `new Date()` in application code (A6, A22) |
| II.1 no SQL in controllers | Pass | batch read controller goes through `ShopQueryService` (A23) |
| II request pipeline | Pass | `Firewall({anonymous})` only on the two public routes; `Firewall({sensitive:true})` on `/admin/shops/*`; `@RateLimit` metadata; strict DTOs with `forbidNonWhitelisted` |
| III.1 / IX.1 owner-only data access | Pass | only `infra/` repositories touch tenancy tables; none touches `User`, `Product`, `ChatChannel` |
| III.2 / rule (4) transactions | Pass | `TransactionRunner.run`; direct count in the domain falls 1 → 0 |
| III.3 no I/O in a transaction | Pass | discovery before; revocation, cache delete, registry invalidate after commit |
| III.4 principal in the predicate | Pass | every lookup carries `(shopId, userId)` or `(shopId, id)` (FR-011); no `findByPk` + check |
| III.6 / III.7 invariants, state machines | Pass | conditional updates assert one row; `nextState` + `assertNever`; status history row in the same transaction (table `ShopStatusHistory`) |
| III.9 cache not truth | Pass | shared store only, 15 s/10 s, delete after commit, sensitive set reads the database |
| III.10 pagination | Pass | opaque cursor, unique tiebreaker, max 100 |
| III.11 migrations | Pass | expand, one reversible contract step (FK drops), `lock_timeout`, `CONCURRENTLY` indexes outside the transaction, duplicate pre-check for the partial unique index |
| IV.1 / IV.8 module communication | Pass | identity through exported R1 services only; OIDC through the registry; `safeRequest` for discovery behind an `OidcDiscoveryPort` |
| IV.3 / IV.4 events | Pass | outbox only; `tenancy.invite_requested` single-consumer message (the one token carrier) |
| IV.5 consumers | Pass | three projectors with `idempotency: 'inbox'` (provisioning, verification) and `versionGuard` (plan); zod payloads; DLQ by the runner |
| IV.6 outbound | Pass | discovery timeout 3 s, one attempt, no retry on POST-like paths; startup config validation (cells, regions) |
| V.1–V.5 contracts | Pass | explicit DTOs in `packages/contracts`; stable codes; POST/PUT/DELETE semantics; `Retry-After` on 429/503 |
| VII testing | Pass | rows of test-plan.md; units only for pure logic; frozen clock; `Promise.all` for every race |
| VIII.1 audit/metrics | Pass | audit lines without e-mail/token/secret; counters by reason, no tenant label |
| VIII.5 startup validation | Pass | regions, cells, role attributes checked at boot |
| VIII.6 scheduler | Pass | two S49 jobs, single run |
| IX.3 registry | Pass | `ShopStatusHistory` added to `db/ownership.ts` in the same change |
| IX.4 / D-7 / D-12 | Pass for tenancy's own side; consumer migration tracked | zero foreign keys across owners; C1/C2 rows are the other capabilities' changes (Sibling-spec follow-ups in gaps.md) |
| IX.8 `shopVersion` | Pass | incremented by every `Shop` write; carried by events |
| X.4 / X.5 barrels | Pass at the end of WP-10 | barrel exports module, `ShopScoped`, R1 services, DTO types, event contracts; models removed once `check:table-ownership` shows consumers migrated, else kept as a listed transitional export (Risk 1) |
| Open debt D-6, D-8 | Closed for tenancy | WP-3, WP-7 |
| Open debt D-7, D-12 | Tenancy side closed; consumer side tracked | WP-10, gaps.md follow-ups |

Post-design re-check: unchanged. Departures in Complexity Tracking.

## Complexity Tracking

| Departure | Why | Simpler alternative rejected because |
|---|---|---|
| Serializable isolation for last-owner writes while the rest uses row locks | The invariant spans several rows (write skew, P0310); a row lock on the shop row would also serialise unrelated reads of members | A shop-row lock for all member changes is simpler but makes every role change contend with seat counting; chosen split is in research R-05 |
| Per-user advisory lock for the 10-shop limit | The counted rows (`ShopMembership` owner rows) cannot be locked without a table lock; the user's row belongs to identity (IX.4) | A lock on `User` crosses the owner boundary; a counter column on tenancy would duplicate derived data |
| Cache with a 15 s bounded-stale window kept for non-sensitive permissions | Hot path of every shop-scoped request (notes 10/04 §2) | Reading the database on every request removes a bounded risk at a measurable cost; sensitive permissions already do |
| One new table (`ShopStatusHistory`) although III.7 allows the event stream | Spec Key Entities and FR-007 require a history record per transition with actor and reason; retention of `tenancy.events` is not guaranteed to be `full-history` for the admin console | Event-only history would couple audit queries to Kafka retention |
| Transitional model exports kept until consumers migrate (if their PRs have not landed) | D-7 is closed by the *consumers*, whose specs do not exist yet for all domains | Deleting exports now breaks the build of 20+ files outside this change; the check stays at its baseline count and may not rise |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S03-shops-rbac/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ (http.md, events.md, services.md)
├── spec.md  test-plan.md  gaps.md  questions.md   # inputs
└── tasks.md                                       # /speckit-tasks, not created here
```

### Source Code

```text
packages/backend/libs/domains/tenancy/
├── domain/
│   ├── permissions.ts  role-policy.ts  shop-status.ts  verification-status.ts   (+ *.spec.ts beside each, table-driven)
│   ├── seat-policy.ts  slug-policy.ts  cursor.ts  invite-token.ts  cross-tenant-reason.ts
│   ├── events.ts  errors.ts  tenancy-rate-policies.ts  shop-types.ts
│   └── ports/index.ts   (SHOP_REPOSITORY, MEMBERSHIP_REPOSITORY, INVITE_REPOSITORY, SSO_CONFIG_REPOSITORY,
│                         DIRECTORY_REPOSITORY, STATUS_HISTORY_REPOSITORY, AUTHZ_CACHE, OIDC_DISCOVERY,
│                         TENANT_DB_ROLE_CHECK, MembershipReader)
├── application/
│   ├── shop.service.ts  membership-admin.service.ts  invite.service.ts  shop-sso.service.ts
│   ├── shop-access.service.ts  shop-query.service.ts  membership-query.service.ts
│   ├── shop-provisioning.service.ts  shop-cell.service.ts  shop-lifecycle.service.ts  (suspend/reinstate/offboard/purge)
│   ├── sso-provisioning.service.ts  verification.service.ts  plan.service.ts
│   └── tenancy-observability.ts   (audit + counters)
├── infra/
│   ├── models/ shop.model.ts  shop-membership.model.ts  shop-invite.model.ts  shop-directory.model.ts
│   │           shop-sso-config.model.ts  shop-status-history.model.ts  + *.repository.ts
│   ├── authz-cache.redis.ts  oidc-discovery.adapter.ts  tenant-db-role.check.ts
│   ├── shop-transaction.ts (allowlist, counter, log)  tenant-connection.resolver.ts (per-cell pools, fail closed)
│   ├── projectors/ sso-provisioning.projector.ts  verification.projector.ts  plan.projector.ts
│   └── jobs/ purge-shops.jobs.ts   (delete tenancy-backfill.jobs.ts)
├── api/
│   ├── shop.controller.ts  members.controller.ts  invites.controller.ts  sso.controller.ts  offboarding.controller.ts
│   ├── admin-shops.controller.ts  shop-roles.controller.ts  shop-batch-read.controller.ts
│   ├── shop.guard.ts  realtime-topics.ts  tenancy.dto.ts  (zod, from packages/contracts)
├── index.ts  tenancy.module.ts  tenancy-worker.module.ts  realtime-topics.module.ts  batch-read.module.ts
└── *.e2e-spec.ts  (nineteen files of test-plan.md)  testing/ (fixtures: createShop, addMember, clock helpers)
packages/backend/migrations/<ts>-tenancy-s03-expand.js   <ts>-tenancy-s03-contract-fks.js   db/ownership.ts (+1 entry)
packages/backend/libs/common/config/api-config.service.ts   (regions, cells, pool sizes validated at boot)
packages/backend/test/  (shared fixtures createShop / addMember, IX.6)
packages/contracts/src/tenancy/   (shopSchema, shopListItemSchema, shopMemberSchema, shopInviteSchema, shopSsoConfigSchema,
                                   shopSsoLookupSchema, shopExportSchema, shopRolesSchema, shopDirectorySchema, pageSchema)
```

**Structure Decision**: keep the single `tenancy` domain; split the monolithic `ShopController` / `ShopService` by feature so each file fits a screen; ports in `domain/`, adapters in `infra/`, as in `identity`. Cross-domain readers use only the R1 services in the barrel.

## Work packages (tasks.md derives from these)

Order follows gaps.md section D. Each package ends with its narrowest test green.

| WP | Content | Gaps / debt | Proof |
|---|---|---|---|
| WP-0 Baseline | Run `pnpm check:table-ownership` and `pnpm check:boundaries`; reconcile gaps.md section C with real rows; record direct `sequelize.transaction` count (1), `grep` for `Firewall({ throttle`, `JobsService.cancel`, `OidcService` in tenancy; read `ShopScoped` consumers (`grep ShopScoped libs`) to list routes affected by the matrix/status changes | caveat, C | gate output noted in tasks |
| WP-1 Pure units and contracts | `permissions` (matrix of FR-020, `orders.read`, `shop.export`), `role-policy` (`canManage`), `shop-status`, `verification-status`, `seat-policy`, `slug-policy`, `cursor`, `invite-token`, `cross-tenant-reason`; errors with FR-100 codes; events via `defineEvent`; 6 rate policies; contracts schemas | A10, A25 (codes, policies), A1 (contracts) | unit specs (AS-16–18, 64, 71) |
| WP-2 Schema | migration expand: columns (`planVersion`, `shopVersion`, `purgeAt`, `sandboxOf` modelled, `DELETED`, `ShopInvite.revokedAt/acceptedBy`, partial unique `(shopId, lower(email)) WHERE pending`, `ShopDirectory.version`, `ShopSsoConfig.defaultRole`, `ShopMembership.source`, `(userId, createdAt)` index), `ShopStatusHistory`, RLS on `ShopMembership` with `WITH CHECK`, re-seal step for SSO secrets (job-driven, idempotent), registry entry; contract migration: drop FK to `User` (and, listed for their owners, `Product.shopId` / `ChatChannel.shopId`), `lock_timeout` | A15, A16, A17, A22 (contract ownership), C3 | `tenancy-schema`, `tenancy-isolation` e2e |
| WP-3 Ports, repositories, module wiring | models + repositories behind ports; drop `User` from `forFeature`, import identity only for exported R1 services; module exports only R1 services + `ShopScoped`; controllers typed `AuthenticatedUser`; DTOs from contracts | A26, A27, A25, S01 follow-ups, C3 | `tsc`, `check:boundaries` |
| WP-4 Isolation core | `ShopTransactionRunner` (allowlist, counter, log), startup role check, `TenantConnectionResolver` (per-cell pool, acquire timeout, fail closed, config validation, cache 5 min), `ShopCellService`, directory repository | A14, A18 | `tenancy-isolation`, `tenancy-startup`, `shop-cells` (AS-51, 53–55, 57–60) |
| WP-5 Guard and authorization | `ShopAccessService`, Redis authz cache (shared only, 15/10 s, delete after commit, outage fallback), strong read set, status gate, header/path mismatch, uniform 404, request-context `shopId`; guard as adapter; `GET /shop-roles` | A11, A10 | `tenant-resolution`, `shop-roles` e2e |
| WP-6 Shops, members, invites | create (limit, reserved slugs, region, events, no `User` write), `mine`/`get`/`patch`, members list (batched directory), role change/removal/self-leave with serializable retry and escalation rule, session revocation after commit; invites (digest, outbox message, seats, duplicates, accept with directory address, revoke, resend, list, rate policies) | A1–A9, A25 | `shop-lifecycle`, `shop-members`, `shop-invites`, `shop-roles` |
| WP-7 SSO | `OidcDiscoveryPort` over `safeRequest` (3 s), configure/read/delete, `SecretBox` context `shop-sso:<shopId>`, `registerResolver('shop:', …)` + `invalidate`, public slug lookup, provisioning projector (inbox, seat check, status check, `provisioned` counters) | A12, A13, S02 follow-ups | `shop-sso`, `shop-sso-provisioning` |
| WP-8 Lifecycle and consumers | status machine + history, admin suspend/reinstate/directory move, offboarding start/cancel, export, verification and plan projectors, realtime topic policy | A19, A20, A21, A24 | `shop-offboarding`, `shop-cells`, `tenancy-consumers`, `shop-members` (AS-83) |
| WP-9 Jobs and provisioning | `tenancy.purge-deleted-shops`, `tenancy.purge-expired-invites` with `declareJobType`, `InvalidScheduleError` catch; `ShopProvisioningService` (`ensureShopsForLegacySellers`, `ensureSandboxShop`) | A20, A22, S49 follow-up | `shop-offboarding`, `tenancy-provisioning` |
| WP-10 R1 services, batch read, barrel, cleanup | `ShopQueryService`, `MembershipQueryService`, batch controller via repository, delete `tenancy-backfill.jobs.ts` (and its worker-module registration), barrel per A28, ownership entry, observability | A23, A28, A22, A29 | `tenancy-exports`, `shop-batch-read`, `tenancy-observability`, `tenancy-events`, `tenancy-errors` |
| WP-11 Cross-spec | gaps.md `## Sibling-spec follow-ups` (written), UNVERIFIED rows (written), quickstart ops artifacts (written) | C1, C2 | review |
| WP-12 Finish | split/delete old `tenancy.e2e-spec.ts` (A29) once the new files cover it; whole tenancy suite once, `tsc`, ESLint, `check:boundaries`, `check:table-ownership`, `check:model-registry`; record the green run | — | `test-spec.sh libs/domains/tenancy` |

## Gap coverage (every row of gaps.md)

| Gap | WP | | Gap | WP | | Gap | WP |
|---|---|---|---|---|---|---|---|
| A1 | 1, 6 | | A11 | 5 | | A21 | 8 |
| A2 | 3, 6 | | A12 | 7 | | A22 | 9, 10 |
| A3 | 6 | | A13 | 7 | | A23 | 10 |
| A4 | 6 | | A14 | 4 | | A24 | 8 |
| A5 | 5, 6 | | A15 | 2 | | A25 | 1, 3, 6 |
| A6 | 6 | | A16 | 2 | | A26 | 3 |
| A7 | 6 | | A17 | 2 | | A27 | 3 |
| A8 | 6 | | A18 | 4 | | A28 | 10 |
| A9 | 6 | | A19 | 8 | | A29 | 12 |
| A10 | 1, 5 | | A20 | 8, 9 | | B: D-6 / D-7 / D-8 / D-12 | 3 / 10 + follow-ups / 7 / 3, 9, 10 |
| C1, C2 | WP-11 (other domains' PRs) | | C3 | 2, 3, 7, 9 | | | |

## Risks

1. **Consumers still import tenancy models** (C1/C2: ~30 files). The barrel keeps the five model exports as transitional until `check:table-ownership` shows their owners migrated; the count may not rise; the AS-77 static test asserts the final state and is expected red until then (recorded as a blocker in tasks if unmet, not hidden).
2. **Matrix and status-gate changes break other domains' routes** (`ShopScoped('payouts.read')`, writes on suspended shops). WP-0 lists the routes; their e2e files are run once after WP-5 and failures that stem from the new rules are fixed in the fixtures, not by weakening the rule.
3. **Events consumed by specs that do not exist yet** (S04 `shop.rejected`, S17 plan event): consumers validate strictly and ignore unknown types; contract lines are in `contracts/events.md`.
4. **RLS on `ShopMembership`** is also read by `mine` and by other domains through the model today; every read must run inside `inShop` or `crossTenant('membership.mine')`. Covered by `tenancy-isolation` and the full tenancy suite.
5. **Re-seal of SSO secrets** sealed without context: done by an idempotent job, `open` falls back to the context-less form until it ran; the fallback is removed in a later contract task (listed deferred).
6. **Dedicated-cell test database** needs a second Postgres in `docker-compose.test.yaml`; if absent, WP-4 adds it and the compose change is noted in tasks.
