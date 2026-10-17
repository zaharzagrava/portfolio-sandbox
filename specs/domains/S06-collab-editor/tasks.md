# Tasks: S06 — Collaborative listing drafts (domain `catalog`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `data-model.md`, `contracts/{http,collab-ws,events-services}.md`, `research.md`, `quickstart.md`.
**Paths**: relative to `packages/backend/libs/domains/catalog/` (written `C/`) unless stated. Contracts: `packages/contracts/src/catalog/`. Run backend commands from `packages/backend`; e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`.
**Order rule**: for every test-plan row the failing test task comes before the code task. Tests are required (test-plan.md). Each e2e test creates its own shop/user/product (L-005, L-006), never asserts "A or B" (L-003), and keeps its scenario→file mapping from test-plan.md (L-017).
**Standing rules**: no `sequelize.transaction` (use `TransactionRunner.run`/`@Transactional`); no `ShopModel`/`ShopMembershipModel`/`"Product"` SQL; never touch `*.reviewed.json`; sibling needs go under "Sibling-spec follow-ups" in gaps.md (already listed there; T095 re-checks). No task here runs a runtime proof (fresh stack, standalone boot, journey/browser suite): those are deferred to the final checkpoint.

## Phase 1: Setup

- [X] T001 Create the living page `docs/spec/capabilities/S06-collab-editor.md` (rules and behaviors of the new design: access gates, publish protocol, rooms, revocation, limits, close codes, jobs, consumers) with `[proof: …]`/`[code: …]` lines naming the test files and source files of this plan; edit it BEFORE code; make `python3 scripts/livespec/check.py` pass; do not create or edit any `*.reviewed.json` (WP-0)
- [X] T002 Record baseline in `specs/domains/S06-collab-editor/gaps.md` under a new "Baseline (WP-0)" heading: output of `pnpm --dir packages/backend check:table-ownership` for `catalog` draft findings (reconcile with section C), `grep -rn "sequelize.transaction" C/` count and any `// S54 T037 audit` markers in touched files, `grep -rn "JobsService.cancel"` callers in S06 files (expected none)
- [X] T003 [P] Add config keys `collab_ticket_key`, `collab_origin_allowlist`, `collab_public_url`, `collab_instance_id` to the schema in `ApiConfigService` (`packages/backend/libs/infrastructure/config/`), validated at start (fail fast when missing in production), with test defaults in the test env file (VIII.5)
- [X] T004 [P] Add `fast-check`, `ws`, `y-protocols` usage check: confirm they are already in `packages/backend/package.json` devDependencies/dependencies; add only if missing (plan says no new runtime dependency)

## Phase 2: Foundational (blocks all stories)

**Purpose**: pure domain, ports, contracts schemas, migrations, test helpers.

### Tests first
- [X] T005 [P] Unit spec `C/domain/draft-status.spec.ts` (`it.each`): transitions `DRAFT→PUBLISHING`, `PUBLISHING→PUBLISHED` (needs lease id), `PUBLISHING→DRAFT`, `DRAFT→ARCHIVED`; every other pair is `invalid_transition`; archive of `PUBLISHING` is `publish_in_progress` (AS-11, AS-34)
- [X] T006 [P] Unit spec `C/domain/listing-doc.spec.ts`: total reading (wrong types become `undefined`, `priceMinor` must be integer), spec table render/parse exact inverses with `fast-check` round trip (keys sorted, no duplicate spec lines on re-edit) (AS-02, AS-31, AS-39)
- [X] T007 [P] Unit spec `C/domain/frame-policy.spec.ts`: ability × frame type table (viewer may send sync step 1 and awareness, not sync step 2/update) and size/rate classification (512 KiB frame, 8 KiB presence, 200 frames/s) (AS-19, AS-22)
- [X] T008 [P] Extend `C/domain/hash-ring.spec.ts` to the exact AS-45 assertions: determinism, 5-node balance within 115% of fair share, moved share ≤ 1/(N+1) + 5% on adding one node, every moved id goes to the new node, empty ring returns no owner
- [X] T009 [P] Test helper `packages/backend/test/fakes/y-client.ts` (`YClient`: real `ws` client speaking y-websocket, records messages/close codes/permission-denied) and delivery helpers; check `test/fakes/tcp-fault-proxy.ts` supports refuse/hang/delay/drop-reply, extend if not (WP-11)

### Code
- [X] T010 [P] Contracts schemas in `packages/contracts/src/catalog/drafts.ts` exported from the contracts index: `draftCreateRequestSchema` (`{title 1–120, productId?: uuid}` strict), `draftSchema` (`{id, shopId, productId|null, title, status, baseProductVersion|null, createdBy, createdAt, updatedAt, publishedAt|null}`), `draftPageSchema` (`{items, nextCursor}`), `draftConnectSchema` (`{url, ticket, canWrite, expiresAt}`), `draftVersionCreateRequestSchema` (`{name 1–80, no control chars}` strict), `draftVersionSchema` (`{id, name, kind: 'named'|'published', createdBy, createdAt}`), `draftVersionDetailSchema` (adds `content: {title, description, priceMinor, brand, category, quantity, specs}`), `draftVersionPageSchema`, `draftPublishRequestSchema` (`{acknowledgeProductVersion?: int}` strict), `draftPublishResultSchema` (`{productId, productVersion, versionId}`), `draftEventSchemas` (`catalog.draft_published` v1 payload `{draftId, shopId, productId, productVersion, versionId, publishedBy}`) (A3, FR-041)
- [X] T011 [P] `C/domain/draft-status.ts` state machine to satisfy T005 (data-model: every transition is `UPDATE … WHERE id AND shopId AND status = :from [AND publishLeaseId = :lease]` asserting 1 row — encoded as the transition table + error mapping)
- [X] T012 [P] Rewrite `C/domain/listing-doc.ts` to satisfy T006: `price` → `priceMinor` (integer minor units), total read, `renderSpecs`/`parseSpecs` as a "Specifications" description section (A11, A12)
- [X] T013 [P] `C/domain/frame-policy.ts` to satisfy T007
- [X] T014 [P] Extend `C/domain/hash-ring.ts` (virtual nodes) to satisfy T008 (A21)
- [X] T015 [P] `C/domain/draft-errors.ts` (errors with stable `code` per contracts/http.md), `C/domain/close-codes.ts` (table in contracts/collab-ws.md: 1001, 1009, 1012, 4000–4005, 4008, 4009, 4013, 4029), `C/domain/draft-limits.ts` (50 per room, 5 per user, 512 KiB, 2 MiB, 200 frames/s, 8 KiB presence, ping 30 s, presence silence 30 s, idle unload 30 s, 200 open drafts, 200 versions, backlog 8 MiB/30 s, entry cap 300 KB, freeze 3 s, lease 60 s), `C/domain/draft-cursor.ts` (keyset codec; bad cursor → `invalid_cursor`)
- [X] T016 `C/domain/draft-ports.ts`: port interfaces and injection tokens for draft repository, version repository, update log, snapshot store, ring registry, backplane, ticket service, membership reader, product gateway (closes D-6, A31)
- [X] T017 Expand migration `packages/backend/migrations/<ts>-catalog-s06-expand.js` (with `lock_timeout`): `ListingDraft` add `baseProductVersion integer NULL`, `publishLeaseId uuid NULL`, `publishLeaseExpiresAt timestamptz NULL`; widen status CHECK to (`DRAFT`,`PUBLISHING`,`PUBLISHED`,`ARCHIVED`); `ListingDraftVersion` add `shopId` (denormalised) and `kind` (`named`|`published`, default `named`); indexes `(shopId, updatedAt DESC, id DESC)`, partial `(shopId) WHERE status IN ('DRAFT','PUBLISHING')`, partial `(publishLeaseExpiresAt) WHERE status='PUBLISHING'`, `ListingDraftVersion (draftId, createdAt DESC, id DESC)` (`CONCURRENTLY` outside a transaction block) (A33)
- [X] T018 Contract migration `packages/backend/migrations/<ts>-catalog-s06-contract.js` (with `lock_timeout`): drop the foreign keys `ListingDraft.shopId`→Shop, `productId`→Product, `createdBy`→User, and `ListingDraftVersion.createdBy` if present; no data migration (A33, IX.4)
- [X] T019 Update Sequelize models in `C/infra/models/` (listing-draft, listing-draft-version) for new columns/status; plain id columns, no cross-owner associations; `db/ownership.ts` unchanged
- [X] T020 [P] Repositories behind ports: `C/infra/draft.repository.ts` and `C/infra/draft-version.repository.ts` (every predicate carries `shopId`; conditional transitions assert one row; keyset queries; atomic open-draft cap as one `INSERT … SELECT … WHERE count < 200` under `pg_advisory_xact_lock(hashtext(shopId))`; version cap 200 in the insert statement)
- [X] T021 Wire ports to adapters in `C/drafts.module.ts` and `C/collab.module.ts` by token (D-6); `room.ts`, `room-manager.service.ts`, `drafts.service.ts` stop importing `infra/` classes or `@nestjs/sequelize` connections (A31)
- [X] T022 [P] Rate-limit policies in `C/rate-limit-policies.ts` via `definePolicies`: `catalog.draft-connect.user` 30/min per user, `catalog.draft-write.shop` 120/min per shop, `catalog.draft-publish.shop` 10/min per shop, all fail closed (S50)

**Checkpoint**: units green (`npx jest C/domain`), `tsc --noEmit` for backend and contracts.

## Phase 3: User Story 1 — Create a draft and get into the editor (P1) 🎯 MVP

**Goal**: authenticated, tenant-safe create/list/archive/connect (WP-2, A1–A5, A16, A30). **Independent test**: `drafts-api.e2e-spec.ts` (AS-01…AS-11) passes.

- [X] T023 [US1] Write `C/drafts-api.e2e-spec.ts` (`describe('Listing drafts API')`) failing first, real `DraftsModule` + tenancy + identity + outbox + limiter, parsing responses with the T010 schemas and asserting persisted rows: AS-01 blank create; AS-02 create from product (seeded through real S05 service; first join receives product content); AS-03 validation, one case per class (unknown field, title length, bad uuid); AS-04 missing / other-shop / archived product (`product_not_found`, `product_archived`); AS-05 open-draft limit and `Promise.all` concurrent create at 199 (`draft_limit_reached`, exactly 200); AS-07 keyset pagination + status filter + `invalid_cursor`; AS-11 archive and illegal transitions
- [X] T024 [US1] In the same file add AS-06 table over the eight routes: `401`, non-member `404 shop_not_found`, `403 permission_denied` (viewer on write routes), `403 shop_suspended`, `409 shop_offboarding` (S03 follow-up retest); header comment states that the `payouts.read`/`sso.manage` changes do not touch draft routes
- [X] T025 [US1] In the same file add AS-08 cross-tenant: draft/version ids of another shop answer the same `404` as unknown ids on all six id routes; AS-09 connect (`canWrite` true for editor, false for viewer; ticket claims); AS-10 connect limits (real limiter `429` with `Retry-After`; Redis refused via fault proxy → fail-closed `503`; no instance registered → `503 collab_unavailable` with `Retry-After: 5`)
- [X] T026 [US1] Rewrite `C/api/drafts.controller.ts`: `ShopScoped('products.read'|'products.write')` per contracts/http.md on all eight routes, `ZodValidationPipe` on contracts schemas, `@RateLimit` policies, controller = parse → service → view; remove `@Firewall()`, `assertShop` and DTO classes; add archive route (A1–A3, A16, A30)
- [X] T027 [US1] Rewrite `C/application/drafts.service.ts` as create/list/archive/connect only: create blank or from product via `ProductCommandService.getForShop(shopId, productId)` (records `baseProductVersion`, refuses archived, product `price` → `priceMinor` into the document), atomic cap, keyset list, archive `DRAFT→ARCHIVED` closing rooms with `4005`, connect via `ShopAccessService.assertMember` (write = holds `products.write`) and owner lookup; every predicate carries `shopId`; cross-tenant → `404 draft_not_found`; problem+json codes (A1, A2, A4, A5, A16, A30; S03/S05 follow-ups)
- [X] T028 [US1] Remove `ProductModule`/`AuthModule` imports that only served raw SQL from `C/drafts.module.ts` and import what the providers need (tenancy, product command, outbox, limiter, idempotency) (A34)
- [X] T029 [US1] Delete the old `C/collab.e2e-spec.ts` once T023–T025 and the rooms specs of US2 cover its scenarios (A32; scenario map in test-plan.md)

**Checkpoint**: `$S libs/domains/catalog/drafts-api` green.

## Phase 4: User Story 2 — Edit together in real time (P1)

**Goal**: ticketed handshake, convergent rooms, presence, limits, unload barrier (WP-5, WP-6 part; A17, A18, A21–A23). **Independent test**: `collab-rooms.e2e-spec.ts` AS-12…AS-21.

- [X] T030 [US2] Write `C/collab-rooms.e2e-spec.ts` (`describe('Collaborative editing rooms')`) failing first with `YClient` on real sockets: AS-12 handshake accepted with early frames buffered in order; AS-13 table-driven refusals (missing/malformed/expired/wrong key/`alg:none`/wrong `iss`/`aud`/other draft/replayed `jti` → 401, bad `Origin` → 403, deleted draft → `4004`) with log capture asserting no ticket text; AS-14 concurrent edits converge; AS-15 duplicate update; AS-16 out-of-order updates; AS-17 offline resume sends fewer bytes than full state; AS-18 presence-only traffic leaves the log table unchanged
- [X] T031 [US2] In the same file add AS-19 table-driven limits, one case per limit and close code (50/room `4008`, 5/user `4008`, frame > 512 KiB `1009`, presence > 8 KiB `1009`, document > 2 MiB `4009`, > 200 frames/s `4029`, malformed `4000`); AS-20 dead peer terminated after one missed ping (period shortened by config); AS-21 room load/unload/join-during-unload (spy counts snapshot and log reads on the real store; join waits for in-flight unload)
- [X] T032 [P] [US2] `C/infra/collab-ticket.ts` + `C/application/draft-ticket.service.ts`: dedicated `collab_ticket_key`, pinned `HS256`, `iss`/`aud`/`jti`, ticket carries `shopId`+`draftId`; verify without consuming; `jti` consumed by Redis `SET NX EX 60` only on a successful join; 250 ms Redis timeout (A17, A18)
- [X] T033 [P] [US2] `C/api/collab-origin.ts`: `Origin` allowlist from `collab_origin_allowlist`; `?ticket=` redacted from every log line of the upgrade path
- [X] T034 [US2] Rewrite `C/api/collab-server.service.ts` following handshake order of contracts/collab-ws.md (verify → Origin → ownership `4001` without consuming → draft re-read `4004` → consume `jti` → join room, buffer early frames); frame policy and size/rate checks via `frame-policy.ts`; close codes from `close-codes.ts`; ping 30 s terminate after one miss; structured logs without ticket or content (A17–A19, A21, A22)
- [X] T035 [US2] Rewrite `C/application/room.ts` over ports only: per-connection rate, per-user cap, document-size cap checked on decode, presence entries owned per connection with size cap and 30 s timeout, early-frame buffer (A21, A22)
- [X] T036 [US2] `C/application/room-manager.service.ts`: unload barrier (room stays in the map until `close()` flush finishes; `acquire` awaits it), idle unload 30 s (A23)

**Checkpoint**: `$S libs/domains/catalog/collab-rooms` AS-12…AS-21 green.

## Phase 5: User Story 3 — Right people only; access can be taken away (P1)

**Goal**: ability per update, denied-write message, revocation by events and re-check (WP-6/7; A19, A20, A34). **Independent test**: `collab-rooms` AS-22…AS-25 and `drafts-consumers.e2e-spec.ts` AS-26/27.

- [X] T037 [US3] Add to `C/collab-rooms.e2e-spec.ts`: AS-22 read-only member's update is dropped, answered with message type `4` payload `read_only`, counted, logged, connection stays open; AS-23 role change to viewer delivered through the real consumer stops writes; AS-24 member removed on `appA`+`appB` (cross-instance) and lost notification (Redis channel dropped via fault proxy) revoked by the 60 s re-check with the frozen clock; AS-25 shop no longer active closes rooms `4003 shop_inactive`
- [X] T038 [US3] Write `C/drafts-consumers.e2e-spec.ts` (`describe('Draft tenancy event consumers')`) failing first, delivering real envelopes to the real consumer entry point: AS-26 for each of the five consumers — duplicate delivery (inbox), invalid payload (DLQ, no side effect), stale event (`shopVersion` guard); AS-27 `shop_deleted` with 250 drafts: purge ≤ 100 per transaction, versions/snapshots/log removed, crash after batch one then redelivery resumes, other shops untouched
- [X] T039 [P] [US3] `C/application/draft-access.service.ts`: ability from `ShopAccessService.assertMember` at join; per-update refreshed ability; 60 s batched re-check with `MembershipQueryService.getMembersByShopIds` (one call per shop) and `can(role, permission)` (S03 export tracked in gaps.md; until it lands, map through `assertMember`) (A19, A20)
- [X] T040 [P] [US3] `C/infra/collab-backplane.ts`: Redis pub/sub channel `collab:revoke` behind the backplane port, best effort with 250 ms timeout, strict Zod parse of every payload (no bare `JSON.parse`), instance-side subscriber delivering `revoke`/`recheck`/`close` to rooms (A20)
- [X] T041 [US3] `C/application/draft-revocation.service.ts` (replaces never-called `DraftsService.revoke`): kicks affected sockets with `4003`, sends denied message on downgrade, wired to rooms via the backplane subscriber and the 60 s timer
- [X] T042 [US3] `C/infra/drafts-consumers.ts` with five consumers (strict Zod payloads from events-services.md, inbox idempotency, DLQ, consumer group `catalog-drafts`): member_removed → `revoke`; member_role_changed → `recheck`; shop_status_changed (`to ≠ ACTIVE`, shopVersion guard) → `close(shop_inactive)`; shop_offboarding_started → `close(shop_inactive)`; shop_deleted → resumable purge ≤ 100 drafts per `TransactionRunner.run` + close rooms (A20, A34)
- [X] T043 [US3] `C/drafts-projector.module.ts` hosting the consumers and the jobs module; register it in `apps/projector` (or `apps/worker`) and `apps/local-monolith`; export `DraftsProjectorModule` from `C/index.ts` (A34, D-8)

**Checkpoint**: `$S libs/domains/catalog/collab-rooms` and `…/drafts-consumers` green.

## Phase 6: User Story 4 — Publish as a product revision (P1)

**Goal**: exactly-once, frozen, validated publish through S05 (WP-3; A6–A10, A12, A13). **Independent test**: `drafts-publish.e2e-spec.ts` AS-28…AS-39.

- [X] T044 [US4] Write `C/drafts-publish.e2e-spec.ts` (`describe('Draft publish')`) failing first; frozen clock; each test seeds its own product: AS-28 publish new product (asserts product row, draft row `PUBLISHED`, version row `kind=published`, snapshot object, outbox rows of both `catalog.draft_published` and S05 product event, version name from frozen clock); AS-29 publish a revision; AS-30 product changed since draft → `409 product_version_conflict` with `currentVersion`, success with `acknowledgeProductVersion`, stale acknowledge refused; AS-32 product gone → `product_not_found`
- [X] T045 [US4] Same file: AS-31 table-driven `422 listing_invalid` per field with `errors:[{field,code}]` (title, `priceMinor` 0 / fractional / over limit, `brand` required, quantity, text lengths; limits from S05 `ProductValidationError`, not copied); AS-33 idempotency (replay returns the stored result, in-flight with a gated product write → `409 request_in_flight`, different body → `422 idempotency_key_reuse`, header classes `idempotency_key_required`/`_invalid`, TTL 24 h with frozen clock); AS-34 illegal transitions (`invalid_transition`, `publish_in_progress`)
- [X] T046 [US4] Same file: AS-35 `Promise.all` for each of the three races (same key twice, two keys, publish vs archive) asserting exactly one product, one version, one event; AS-36 Postgres trigger raising on product `UPDATE` (and on outbox `INSERT`) leaves draft `DRAFT` and editable, retry with the same key succeeds; AS-37 publisher crash: lease expiry + `drafts.release-stale-publishing` run with frozen clock, late completion from the old lease affects zero rows; AS-38 freeze point with an editor on a real socket (edits typed before the freeze are included, later ones refused `4005`; owner unconfirmed via fault proxy → `503 collab_unavailable`); AS-39 spec round trip (publish, create from product, publish unchanged succeeds with no new event and same `version`)
- [X] T047 [P] [US4] `C/infra/product-gateway.ts` implementing the product gateway port over `ProductCommandService.getForShop/create/update` (joins the ambient transaction; maps `ProductValidationError.fields` to listing errors; `unchanged` detected by returned `version` equal to `expectedVersion`) (A7, A10; Complexity Tracking)
- [X] T048 [P] [US4] `C/application/events/draft-events.ts`: `defineEvent` for `catalog.draft_published` v1 on topic `drafts.events` keyed by `draftId` using `draftEventSchemas`
- [X] T049 [US4] `C/application/draft-publish.service.ts`: claim `DRAFT→PUBLISHING` with a 60 s lease (conditional update, one row) → freeze room through its owner (3 s) or read stored state if no room → read frozen state → validate (brand required, no `Unbranded` fallback) → write snapshot object BEFORE the transaction → `TransactionRunner.run`: `ProductCommandService.create/update` (with `expectedVersion`, changed fields only, `acknowledgeProductVersion` rule), version row `kind=published` named from `CLOCK`, conditional `PUBLISHING→PUBLISHED` on lease id, `outbox.append(catalog.draft_published)`; any failure releases the claim (lease-guarded); no network call inside the transaction (A6–A10, A12, A13, A7)
- [X] T050 [US4] Wire `POST …/publish` in `C/api/drafts.controller.ts`: `@Idempotent` (24 h TTL, key 1–128) with adapter mapping facility codes to `idempotency_key_required`/`_invalid`/`_reuse`/`request_in_flight`, body `draftPublishRequestSchema`, `catalog.draft-publish.shop` limit, problem+json for all publish codes (A8)
- [X] T051 [US4] `C/api/internal-collab.controller.ts`: `POST /internal/collab/:draftId/freeze` `{leaseId}` and `…/flush`, authenticated by HMAC (ticket key) of body + timestamp, 3 s client timeout, owner flushes, marks the room frozen (later updates closed `4005`) and returns `{seq}` (A9)

**Checkpoint**: `$S libs/domains/catalog/drafts-publish` green.

## Phase 7: User Story 5 — Version history (P2)

**Goal**: named versions, list, read, unreadable snapshot (WP-4; A14, A15). **Independent test**: `draft-versions.e2e-spec.ts` AS-40…AS-44.

- [X] T052 [US5] Write `C/draft-versions.e2e-spec.ts` (`describe('Draft version history')`) failing first: AS-40 create named version captures edits made in the last 100 ms (flush barrier) and the response has no content; AS-41 rules (name 1–80, control characters rejected, 200-version limit `version_limit_reached`, archived/published draft handling `invalid_transition`); AS-42 keyset list with `invalid_cursor`; AS-43 read detail with `content` from snapshot, other-draft version id → `404 version_not_found`; AS-44 gated object store → `503 version_unavailable` with `Retry-After`
- [X] T053 [US5] `C/application/draft-versions.service.ts`: flush barrier through the owner, version insert with cap in the statement, snapshot to `versions/<versionId>` with S3 3 s timeout, keyset list, detail read via snapshot decoded with `listing-doc.ts`
- [X] T054 [US5] Wire the three version routes in `C/api/drafts.controller.ts` (create `201 draftVersionSchema`, list, detail) with contracts schemas and problem codes

**Checkpoint**: `$S libs/domains/catalog/draft-versions` green.

## Phase 8: User Story 6 — Routing, durability, instance changes (P2)

**Goal**: ring routing, store resilience, compaction (WP-6/9; A24–A26, A28, A33). **Independent test**: `collab-routing.e2e-spec.ts` AS-45…AS-53.

- [X] T055 [US6] Write `C/collab-routing.e2e-spec.ts` (`describe('Collab routing and durability')`) failing first with `appA`+`appB`: AS-46 wrong instance closes `4001` with owner address and the same ticket works at the owner; AS-47 graceful stop and killed heartbeat (frozen clock) hand rooms over with zero lost edits; AS-48 scale-out closes moved rooms `4002` and clients reconnect via connect; AS-49 split brain (two rooms forced for one draft) yields one log entry per sequence number; AS-50 N updates in one window produce one log entry (micro-batching); AS-51 compaction after 200 flushes, lower-sequence compaction, crash between pointer move and trim, pointer never moves backward
- [X] T056 [US6] Same file: AS-52 DynamoDB Local behind fault proxy — timeout twice then success (retry, pending kept), ack dropped after write (identical bytes = success), outage past 8 MiB / 30 s backlog closes writers `4013`, true conflict evicts; AS-53 large update split into ≤ 300 KB entries and replays identically
- [X] T057 [P] [US6] `C/infra/instance-registry.ts`: registry in Redis `collab:ring` (heartbeat 5 s, TTL 15 s, 250 ms timeouts), ring refresh 2 s, instance id from `collab_instance_id` (A27)
- [X] T058 [US6] Ring watcher in `C/application/room-manager.service.ts`: on ring change close rooms no longer owned with `4002` after flush (A28)
- [X] T059 [US6] `C/infra/draft-store.ts` as update-log + snapshot-store adapters: Dynamo 1 s / S3 3 s timeouts on every call, conditional write `attribute_not_exists(seq)`, identical-bytes check on conflict, entry splitting at 300 KB, pointer item `seq=0` moving forward only, paged compaction (100 per page, no unbounded in-memory key lists), superseded snapshots recorded with `eligibleAt` (A24–A26, A33)
- [X] T060 [US6] Room persistence in `C/application/room.ts`: keep pending batch on error, retry with backoff + jitter (frozen-clock friendly), 100 ms batch, compaction every 200 flushes, backlog cut-off 8 MiB/30 s → close writers `4013`; only a true conflict evicts with `4002` (A24, FR-019, FR-035, FR-037)

**Checkpoint**: `$S libs/domains/catalog/collab-routing` green.

## Phase 9: User Story 7 — Operate it (P3)

**Goal**: metrics/logs, health and shutdown order, cleanup jobs (WP-8/10; A25, A27, A29). **Independent test**: `collab-ops.e2e-spec.ts` AS-54…AS-56.

- [X] T061 [US7] Write `C/collab-ops.e2e-spec.ts` (`describe('Collab operations')`) failing first: AS-54 metrics present with the AS-54 names and no draft/shop/user label, structured logs carry no ticket or content; AS-55 readiness false until ring registration, shutdown order readiness → leave ring → flush → close (`1012`) observable on a real client; AS-56 `drafts.release-stale-publishing` and `drafts.purge-superseded-snapshots` run twice (idempotent), superseded snapshots past 10 min grace and orphan `versions/` objects older than 1 h deleted, paged by 100, referenced objects kept
- [X] T062 [P] [US7] `C/application/draft-metrics.ts` via `MetricsRegistry` (rooms, connections, frames, denied writes, flush latency, store errors, close codes, publish outcomes; no draft/shop/user labels); replace string logs in `room.ts`/`collab-server.service.ts` with structured fields, `Logger.warn` stops printing error messages (A29)
- [X] T063 [P] [US7] `C/infra/drafts.jobs.ts`: `drafts.release-stale-publishing` (cron `* * * * *`, `fleetConcurrency: 1`, ≤ 500 per run, conditional on lease id) and `drafts.purge-superseded-snapshots` (daily, `fleetConcurrency: 1`); each calls `declareJobType` with a Zod payload contract next to its `JobPayloads` augmentation; `upsertSchedule` wrapped to catch `InvalidScheduleError`; no `JobsService.cancel` caller (A25; S49 follow-up)
- [X] T064 [US7] Readiness tied to ring registration and ordered shutdown (readiness off → leave ring → flush rooms → close sockets with `1012`) in `C/api/collab-server.service.ts`, `C/infra/instance-registry.ts`, `C/application/room-manager.service.ts` (A27)
- [X] T065 [US7] Read `apps/collab` module graph against `CollabModule` providers and import every module they need so the app can boot standalone (L-018/L-015; reading only, the boot run is deferred to the final checkpoint): `packages/backend/apps/collab/src/collab-app.module.ts` (A34)

**Checkpoint**: `$S libs/domains/catalog/collab-ops` green.

## Phase 10: Polish & cross-cutting

- [X] T066 Boundary: `C/drafts.module.ts` and `C/collab.module.ts` export only modules; remove `DraftStore`, `RoomManager`, `CollabServer`, `DraftsService` from `exports`; `C/index.ts` exports only `DraftsModule`, `CollabModule`, `DraftsProjectorModule`; update `apps/core`, `apps/collab`, `apps/projector`, `apps/local-monolith` imports (D-8, WP-12)
- [X] T067 Remove every remaining `ShopModel`, `ShopMembershipModel`, `MembershipService`, `"ShopMembership"`, `UPDATE "Product"` and `outbox.notify` use from `C/` draft code and from the tests (D-7, D-12; section C rows); grep to confirm zero; delete any `// S54 T037 audit` marker in touched files after migrating the site to `TransactionRunner.run`
- [X] T068 R1 usage proof (built as `C/drafts-boundary.e2e-spec.ts`, passing): add a test module in `C/drafts-api.e2e-spec.ts` (or `product-boundary.e2e-spec.ts` pattern) importing only `@app/domains/catalog` plus real S03/S05 modules and exercising create-from-product and connect
- [X] T069 [P] Update the living page `docs/spec/capabilities/S06-collab-editor.md` so every rule/behavior matches the final code and every `[proof:]`/`[code:]` points at an existing file; run `python3 scripts/livespec/check.py`
- [X] T070 [P] Gaps.md bookkeeping: under "Spec changes" note whether any signed line of `docs/spec/capabilities/S05-products.md` mentions drafts (brand default `Unbranded` removed, `price`→`priceMinor`); keep the "Sibling-spec follow-ups" bullets (S03 `roleHasPermission` export, S03 payload `shopId`, S05 unchanged/`fields` shape, S54 idempotency codes, S51 backplane, W04 editor requirements) accurate
- [X] T071 [P] Confirm `specs/UNVERIFIED.md` rows for SC-001, SC-004, SC-007 (status `not run`) and the "Ops artifacts" list in `quickstart.md` still match; SC-002/003/005/006/008/009 are proven by the named e2e/unit files (no change expected)
- [X] T072 Static gates: `npx tsc --noEmit` (backend and `packages/contracts`), `pnpm lint`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict` (target 0 `catalog` draft findings; record before → after in gaps.md)
- [X] T073 Run the whole capability suite once: `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/catalog` (S05 specs stay green); stop after 5 failed fixes of the same test and write the blocker into `questions.md`

## Dependencies & Execution Order

- Phase 1 → Phase 2 (T016 before T020/T021; T017 → T018 → T019 → T020) → stories.
- US1 (P1, MVP) first; US2 depends on US1's connect and on T032; US3 depends on US2 rooms; US4 depends on US1 (create) and T051 freeze endpoint (which needs US2 rooms); US5 depends on T051 flush; US6 touches `room.ts`/`room-manager` after US2/US3; US7 last. T062 and T063 are independent of rooms.
- Within each phase the failing test task precedes its code tasks.
- T029 (delete old e2e) only after US1 and US2 specs exist.

## Parallel opportunities

- Phase 2: T005–T009 together; T010–T015 together (distinct files); T022 alongside.
- US2: T032 and T033 in parallel; US3: T039 and T040; US4: T047 and T048; US6: T057 with T059; US7: T062 and T063; Polish: T069–T071.

## Implementation strategy

MVP = Phases 1–3 (domain, migrations, drafts HTTP API, tenant-safe access). Then US2 (rooms), US3 (revocation), US4 (publish) — all P1 — then US5/US6 (P2) and US7 (P3). Stop at each checkpoint and run its narrowest spec; run the whole capability once at T073.

## Gap coverage

A1–A5, A16, A30 → T026–T027; A6–A10, A12, A13 → T044–T051; A11 → T012; A14, A15 → T052–T054; A17, A18 → T032–T034; A19 → T037, T039; A20 → T038–T043; A21–A23 → T030–T036; A24–A26, A28, A33 → T017–T019, T055–T060; A27, A29 → T061–T064; A31 → T016, T021; A32 → T029, T023–T025; A34 → T028, T043, T065. B: D-6 → T016/T021; D-7, D-12 → T067; D-8 → T066. C rows → T027, T049, T018, T066–T067. Follow-ups: S03 (T024, T039, T067), S05 (T047, T049; brand required T045/T049), S49 (T063).
