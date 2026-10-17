# Implementation Plan: S06 — Collaborative listing drafts (domain `catalog`)

**Branch**: `S06-collab-editor` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted, no line edited by a human). Constitution: `.specify/memory/constitution.md`. Design artifacts: [research.md](research.md), [data-model.md](data-model.md), [contracts/http.md](contracts/http.md), [contracts/collab-ws.md](contracts/collab-ws.md), [contracts/events-services.md](contracts/events-services.md), [quickstart.md](quickstart.md).

## Summary

S01, S03, S05, S49, S50, S52, S53 and S54 are built. Today the draft code is one 222-line service, one 212-line room, a controller with two DTOs, a store and a ticket helper. It authorises with a membership SQL and a role name, loads a draft before comparing the shop, publishes with raw `UPDATE "Product"` in three separate commits, never revokes a socket, signs tickets with the session key, and has one e2e that calls services directly. The plan rebuilds the draft part of `catalog` to the spec (the product part is S05's and stays):

- **Pure rules in `domain/`** (unit-tested, I.2): draft status machine, listing document read/write and spec render/parse (exact inverses), frame policy (ability × frame type, size and rate classes), hash ring (extend to AS-45), cursor codec, close-code table, draft errors with stable `code`. Ports and tokens for draft repository, version repository, update log, snapshot store, ring registry, backplane, ticket service, membership reader, product gateway (closes D-6).
- **One publish path**: claim `DRAFT → PUBLISHING` with a 60 s lease (conditional update, one row) → freeze the room through its owner (3 s) → read the frozen state → validate with S05's limits → `TransactionRunner.run`: `ProductCommandService.create/update` (joins the ambient transaction), version row, conditional `PUBLISHING → PUBLISHED` on the lease id, `outbox.append(catalog.draft_published)`. Snapshot object is written **before** the transaction (no network call inside it; orphans are cleaned by the daily job). Failure releases the claim. `Idempotency-Key` through the S54 facility.
- **Access**: `ShopScoped('products.read'|'products.write')` on all eight routes, every predicate carries `shopId`, `404 draft_not_found` for cross-tenant. Ticket service: dedicated key, pinned `HS256`, `iss/aud/jti`, single use (Redis `SET NX` consumed only on a successful join), `Origin` allowlist, `?ticket=` redacted.
- **Rooms**: per-update ability check against a refreshed ability; `permission denied` message; revocation by `DraftsProjectorModule` (five consumers → Redis pub/sub backplane → rooms) plus a 60 s batched re-check through `MembershipQueryService.getMembersByShopIds` and `can(role, permission)`; ring watcher that closes rooms no longer owned; unload barrier; limits and close codes; store retry with identical-bytes success, backlog cut-off, entry splitting; snapshot-pointer-forward-only compaction; timeouts on every store call; metrics, structured logs, readiness tied to ring registration, ordered shutdown.
- **Boundary**: expand/contract migration (drop the three foreign keys, add columns/statuses), public entry point exports only `DraftsModule`, `CollabModule`, `DraftsProjectorModule` (D-8); no `ShopModel`/`ShopMembershipModel`/`Product` SQL (D-7, D-12).

### Follow-ups from built specs (treated as requirements)

| From | Requirement | Where planned |
|---|---|---|
| S03 | replace `ShopModel`, `ShopMembershipModel`, `MembershipService`, raw SQL on tenancy tables with `ShopAccessService`, `ShopQueryService`, `MembershipQueryService` | WP-2 (routes, tickets), WP-7 (re-check), WP-11 (e2e fixtures); `check:table-ownership` finding "SELECT … FROM ShopMembership" closes |
| S03 | `payouts.read` excludes VIEWER, `sso.manage` excludes ADMIN, `ShopScoped` answers `403 shop_suspended` / `409 shop_offboarding` for write permissions on closed shops: retest | AS-06 table in `drafts-api.e2e-spec.ts` (WP-11) covers suspended/offboarding on all eight routes; the other two changes do not touch draft routes (stated in the e2e header, no extra test) |
| S05 | publish calls `ProductCommandService.update` (never `UPDATE "Product"`); `ShopAccessService.assertMember` instead of `SELECT … ShopMembership` (`drafts.service.ts:68`) | WP-3, WP-2 |
| S05 | draft without brand is published as `Unbranded`, price 0 is refused `400`; S06 may require brand in the editor | decided: publish validation reports `brand` `required` as `422 listing_invalid` (S05 limits 1–100); `Unbranded` fallback removed; W04 follow-up in gaps.md |
| S49 | `declareJobType` with payload contract next to the `JobPayloads` augmentation for both jobs; adapt to the discriminated `JobsService.cancel` result; catch `InvalidScheduleError` | WP-8 (`drafts.release-stale-publishing`, `drafts.purge-superseded-snapshots`; `upsertSchedule` wrapped; S06 has no `cancel` caller, verified by grep in WP-0) |
| gaps.md | A1–A34, B (D-6, D-7, D-8, D-12), C (table-ownership rows), D (new things) | Gap coverage table below |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; `packages/backend` (`libs/domains/catalog`, `apps/collab`, `apps/core`, `apps/projector`, `apps/worker`); schemas in `packages/contracts/src/catalog`; Yjs (`yjs`, `y-protocols`) already used by `room.ts`.

**Primary Dependencies** (all present, **no new runtime dependency**): `@nestjs/sequelize`, `TransactionRunner`/`@Transactional` (`@app/infrastructure/context`), `OutboxService` + `defineEvent` (`@app/infrastructure/events`, `…/outbox`), consumer framework `Projector`/inbox (`@app/infrastructure/projections`, `…/inbox`), idempotency facility (`@app/infrastructure/idempotency`: `@Idempotent` interceptor), S49 `JobHandler`/`declareJobType`/`JobsService`, S50 `definePolicies`/`@RateLimit`, `MetricsRegistry`, `CLOCK`, `AppError`, `ApiConfigService`, Redis client (`@app/infrastructure/redis`), `DynamoModule`, `StorageModule`; from tenancy `ShopScoped`, `ShopAccessService`, `MembershipQueryService`, event classes `MemberRemoved`, `MemberRoleChanged`, `ShopStatusChanged`, `ShopOffboardingStarted`, `ShopDeleted`; from identity `Firewall`, `User`. Test only: `fast-check`, `ws`, `test/fakes/tcp-fault-proxy.ts`, tenancy fixtures.

**Storage**: PostgreSQL `ListingDraft`, `ListingDraftVersion` (altered; already `domain:catalog` in `db/ownership.ts`); DynamoDB `DocUpdates` (update log + snapshot pointer); S3/MinIO snapshot objects (`drafts/<draftId>/…`, `versions/<versionId>`); Redis (instance registry, ticket `jti`, backplane channel, rate limits, idempotency). Kafka topic `drafts.events`.

**Testing**: Jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (seven files of the test plan), four table-driven unit specs (+ `fast-check` for render/parse), real Postgres/Redis/DynamoDB Local/MinIO, real WebSocket clients, TCP fault proxy, second Nest app for routing. Playwright journey is W04's.

**Target Platform**: Linux containers: `apps/core` hosts `DraftsModule`; `apps/collab` hosts `CollabModule` (and must boot standalone, L-018: it imports every module its providers need); `apps/projector` (or `worker`) hosts `DraftsProjectorModule`; `apps/local-monolith` imports all three.

**Project Type**: web-service (backend domain) + contracts package; web editor is W04.

**Performance Goals**: broadcast p99 < 100 ms at 50 editors (in-memory fan-out, no I/O on the path); persist ≤ 250 ms (100 ms batch); publish p95 < 2 s for ≤ 20 KB; ~5,000 rooms/instance. Per-room memory is bounded by the 2 MiB document cap and 50 connections.

**Constraints**: no network call inside a transaction; every Dynamo/S3/Redis/Postgres call has an explicit timeout (Dynamo 1 s, S3 3 s, Redis 250 ms, Postgres by `db_statement_timeout_ms`, freeze 3 s); no unbounded list or in-memory key set in compaction (page by 100); migrations expand/contract with `lock_timeout`; metrics carry no draft/shop/user label; logs never carry ticket or content.

**Scale/Scope**: 8 HTTP routes (1 existing re-shaped route set + new archive, version read, keyset list), 1 WebSocket endpoint, 5 consumers, 2 jobs, 3 rate policies, 1 event, 2 tables altered; 56 acceptance scenarios (seven e2e files, four unit specs, one W04 journey).

### Pool arithmetic and `statement_timeout` (III.12)

- Adds no pool; uses the shared S54 pool (see S05 plan, "Pool arithmetic").
- Longest transaction: publish = one product write + version insert + status update + 2 outbox rows (≈ 6 statements, no I/O). Purge on `shop_deleted` ≤ 100 drafts per transaction. Open-draft cap = one conditional `INSERT … SELECT … WHERE count < 200` under a per-shop advisory lock (`pg_advisory_xact_lock(hashtext(shopId))`).
- Collab rooms hold **no** database connection while idle; the membership re-check is one statement per shop per 60 s per instance.

## Constitution Check

*Gate: before Phase 0, re-checked after Phase 1.* Result: **PASS, no unjustified violation** (Complexity Tracking lists the two deliberate deviations).

| Principle | Check | How the plan meets it |
|---|---|---|
| I Layered modules | Domain pure; application uses ports; infra adapters; no `infra/` import from `application/` | WP-1 ports and tokens (D-6); `room.ts`/`room-manager` receive `UpdateLog`, `SnapshotStore`, `RingRegistry`, `Backplane` by token |
| II Pipeline/routing | Guards/pipes/interceptors, routes under `/api`, no business logic in controllers | `ShopScoped`, `ZodValidationPipe` on `packages/contracts` schemas, `@Idempotent`, `@RateLimit`; controller = parse → service → view |
| III Data/transactions | Shop in every predicate, conditional updates assert one row, keyset, `TransactionRunner`, no I/O in tx, money integer, expand/contract | WP-2/WP-3/WP-9; zero `sequelize.transaction` sites in S06 files (verified WP-0; current count 0, the two `// S54 T037 audit` markers, if any are found in touched files, are migrated and deleted) |
| IV Module/service communication | R1 for product and membership, events for reactions, inbox idempotency, outbox, bounded batches, timeouts | WP-3 (`ProductCommandService`), WP-7 (consumers, DLQ), WP-9 (timeouts) |
| V Contracts/errors | Zod schemas in contracts, problem+json with `code`, 404 for cross-tenant | contracts/http.md; codes table |
| VI Frontend | Not touched (W04) | Sibling follow-up |
| VII Testing | Every AS has a test at the lowest layer; real stores; fakes only at edges; frozen clock; no `A or B` assertions | test-plan.md; WP-11; L-003, L-005, L-006 rules in WP-11 |
| VIII Operational safety | Config validated at start, secrets dedicated, no secrets in logs, graceful shutdown, health | WP-6 (config keys, ticket key, redaction), WP-10 (health/shutdown) |
| IX DB isolation | No cross-owner FK/SQL/model; technical-table exception only for the outbox | WP-9 migration drops 3 FKs; table-ownership strict = 0 `catalog` draft findings |
| X Monorepo/boundaries | Barrel exports only module entry points | WP-12: export `DraftsModule`, `CollabModule`, `DraftsProjectorModule`; remove `DraftStore` exports |

Post-design re-check: PASS. Complexity Tracking below.

## Project Structure

### Documentation (this feature)

```text
specs/domains/S06-collab-editor/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ http.md  collab-ws.md  events-services.md
└── tasks.md            # /speckit-tasks
```

### Source code (web-service + contracts; paths under `packages/backend/libs/domains/catalog/` unless stated)

```text
domain/        draft-status.ts(+spec) listing-doc.ts(+spec) frame-policy.ts(+spec) hash-ring.ts(+spec, extended)
               draft-cursor.ts draft-errors.ts draft-limits.ts close-codes.ts draft-ports.ts (tokens)
application/   drafts.service.ts (create/list/archive/connect)  draft-publish.service.ts  draft-versions.service.ts
               draft-ticket.service.ts  draft-access.service.ts (ability + re-check)  room.ts  room-manager.service.ts
               draft-revocation.service.ts  draft-metrics.ts  events/draft-events.ts
api/           drafts.controller.ts  collab-server.service.ts  collab-origin.ts
infra/         draft.repository.ts  draft-version.repository.ts  draft-store.ts (update log + snapshots, timeouts)
               collab-ticket.ts (jti store)  instance-registry.ts  collab-backplane.ts
               drafts-consumers.ts (5 consumers)  drafts.jobs.ts  models/listing-draft*.model.ts
drafts.module.ts  collab.module.ts  drafts-projector.module.ts  rate-limit-policies.ts (+3 policies)
drafts-api|collab-rooms|drafts-publish|draft-versions|collab-routing|drafts-consumers|collab-ops .e2e-spec.ts
packages/backend/migrations/<ts>-catalog-s06-expand.js, <ts>-catalog-s06-contract.js
packages/contracts/src/catalog/drafts.ts (+ index export)
docs/spec/capabilities/S06-collab-editor.md       # living page (WP-0)
```

**Structure Decision**: extend `libs/domains/catalog` (the domain that owns the draft tables); split the 222-line service by use case; keep `room.ts` free of infrastructure imports.

## Work packages (order = dependency order)

- **WP-0 Baseline and living page.** Run `check:table-ownership` and record the real `catalog` draft findings against gaps.md section C; grep `sequelize.transaction` in S06 files and `JobsService.cancel` callers; create `docs/spec/capabilities/S06-collab-editor.md` (rules/behaviors of the new design, `[proof:]`/`[code:]` true, `python3 scripts/livespec/check.py`); never touch `*.reviewed.json`. Page is edited **first**, the code follows.
- **WP-1 Domain and contracts.** Pure modules and port tokens (A31, D-6), contracts schemas `drafts.ts` (A3, FR-041), error classes with `code`, close-code table, limits. Units: S, L (spec render/parse with `fast-check`, `priceMinor` integer, A11/A12), F, H extended to AS-45 (A21). `price` → `priceMinor` (A11).
- **WP-2 Drafts HTTP.** `ShopScoped` on all routes, strict Zod bodies (A3), create (blank/from product via `getForShop`, base version, archived check, atomic 200-cap) (A4), keyset list (A5), archive (A16), connect with owner lookup, rate policies, fail-closed (A2, A30), cross-tenant 404 with shop in every predicate (A1). Problem+json codes.
- **WP-3 Publish.** Lease claim, freeze, validation with `ProductValidationError` → `422`, `create`/`update` with `expectedVersion`/acknowledged version, changed-fields-only, unchanged detection by `version` equal to expected, version row + `catalog.draft_published` in one transaction, failure release, lease-guarded completion, `@Idempotent` with 24 h TTL, frozen-clock version name (A6–A10, A12, A13).
- **WP-4 Versions.** Flush barrier, named version create (limit 200, name rules, kind), keyset list, detail read from snapshot, `503 version_unavailable` (A14, A15).
- **WP-5 Ticket and handshake.** Dedicated key/audience/`jti`, pinned alg, `Origin` allowlist, single use consumed on successful join only, `4001` redirect before consumption, early-frame buffering, log redaction, `4004` (A17, A18). Config keys validated at startup (VIII.5).
- **WP-6 Rooms.** Per-update ability + denied message + counter (A19), limits and close codes (A21, A22), presence ownership/size/timeout (A21), liveness ping, unload barrier (A23), store retry/backoff/jitter, identical-bytes success, backlog cut-off `4013`, entry splitting (A24), ring watcher + `4001`/`4002` (A28), freeze/flush endpoint on the owner for publish and versions, archive/publish close `4005`.
- **WP-7 Revocation and consumers.** `DraftsProjectorModule`: five consumers (strict Zod payloads, inbox idempotency, DLQ), backplane publish (best effort, timeout), instance-side subscriber, 60 s batched re-check with `can`, resumable `shop_deleted` purge in ≤ 100-draft transactions (A20, A34).
- **WP-8 Jobs.** `drafts.release-stale-publishing` (every minute), `drafts.purge-superseded-snapshots` (daily; orphan version objects > 1 h); `declareJobType` with payload contract, `upsertSchedule` catching `InvalidScheduleError`, `fleetConcurrency: 1` (A25, S49 follow-up).
- **WP-9 Persistence.** Migrations (expand: columns, status `PUBLISHING`, `kind`, indices; contract: drop three FKs with `lock_timeout`), repositories, compaction (pointer forward only, paged trim, grace-based superseded deletion), timeouts on every call (A24–A26, A33).
- **WP-10 Operations.** Metrics (AS-54 list), structured logs, readiness after ring registration, shutdown order readiness → leave ring → flush → close (A27, A29), standalone boot of `apps/collab` imports checked by reading its module graph against `CollabModule` providers (L-018; running it is deferred to the final checkpoint).
- **WP-11 Tests.** Replace `collab.e2e-spec.ts` (A32) by the seven e2e files + `YClient`, delivery/fault helpers; each test creates its own shop/user/product (L-005, L-006); no "A or B" assertions (L-003); scenario→file map kept in the test-plan table (L-017).
- **WP-12 Boundary.** `drafts.module.ts`/`collab.module.ts` export only modules; update `index.ts` (D-8), `db/ownership.ts` unchanged; delete `catalog` draft imports of tenancy models; app modules (`apps/core`, `apps/collab`, `apps/projector`, `apps/local-monolith`) updated.

## Gap coverage

| Gaps | WP | | Gaps | WP |
|---|---|---|---|---|
| A1, A2, A3, A4, A5, A16, A30 | 2 | | A17, A18 | 5 |
| A6–A10, A12, A13 | 3 | | A19, A21–A24, A28 | 6 |
| A11 | 1 | | A20, A34 | 7 |
| A14, A15 | 4 | | A25 | 8, 9 |
| A26, A33 | 9 | | A27, A29 | 10 |
| A31 | 1, 12 | | A32 | 11 |
| B D-6, D-7, D-8, D-12 | 1, 12 | | C rows | 2, 3, 9, 12 |

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Snapshot object written before the publish transaction, orphan cleaned by a job | FR-026 forbids network I/O inside the transaction | Writing inside would hold a connection across S3 latency (III.12) |
| `unchanged` detected by comparing the returned `version` with `expectedVersion` | S05 `update` returns the member view without an outcome flag; avoids waiting on a sibling change | Asking S05 for a new return type blocks S06; the comparison is exact because S05 bumps `version` on every write |
