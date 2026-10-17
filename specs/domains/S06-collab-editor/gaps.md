# Gaps: S06 — current collaborative-draft code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/` unless stated; line numbers are those read on 2026-10-05. **Check not run:** `pnpm --dir packages/backend check:table-ownership` needs an approval that an unattended session cannot get, so section C is reconstructed from searches over `libs/domains/catalog` (every table name in raw SQL, `@InjectModel`, `forFeature`, entry-point imports) and the migration. Run the real check first and reconcile. Product CRUD, cache and events are S05 and are listed only where draft code writes the product table.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Cross-tenant: every route loads the draft by id and only then compares `shopId`, answering `403`; `assertShop` is called by hand in five handlers | `libs/domains/catalog/application/drafts.service.ts:152-154`; `api/drafts.controller.ts:38,45,52,59` | FR-001, AS-08 (III.4, V.4) |
| A2 | `connect` uses `@Firewall()` and a membership SQL, then `role !== 'VIEWER'` as the write test; no permission model, no shop status gate | `api/drafts.controller.ts:35-40`; `application/drafts.service.ts:66-77` | FR-007, FR-008, AS-06, AS-09 |
| A3 | No input classes beyond two DTOs: no unknown-field rejection, no contracts schemas, responses are raw rows (`updatedAt` on list only, `createdBy` missing) | `api/drafts.controller.ts:8-16`; `application/drafts.service.ts:58-62,81-86` | FR-002, FR-041, AS-03 |
| A4 | Create from a product reads `"Product"` with SQL and casts `price` to a number; no archived check; no base version recorded; no open-draft limit | `application/drafts.service.ts:42-52` | FR-003, FR-005, AS-02, AS-04, AS-05 |
| A5 | List is `LIMIT 100` with no cursor and no status filter | `application/drafts.service.ts:58-63` | FR-006, AS-07 |
| A6 | Publish is read-then-write: `draft.status !== 'DRAFT'` is checked in memory, the product write, the version and the status update are three separate commits, so a crash or two requests create two products or leave a product with a `DRAFT` draft | `application/drafts.service.ts:109-142` | FR-024–FR-028, AS-33–AS-37 |
| A7 | Publish writes the product with raw SQL (`UPDATE "Product"`) and its own outbox row (`outbox.notify({productId})`), bypasses S05's version and event rules, has no optimistic check against the base version, and uses `ProductService.create` with `as never` | `application/drafts.service.ts:117-133` | FR-026, FR-029, AS-28–AS-30 (S05 A23) |
| A8 | No `Idempotency-Key`; no `PUBLISHING` state or lease; no `acknowledgeProductVersion`; double publish answers `400` | `application/drafts.service.ts:110`; `api/drafts.controller.ts:55-61` | FR-004, FR-024, AS-33–AS-35 |
| A9 | Publish does not freeze the room: it reads the stored state, so edits in the last 100 ms or edits typed during the publish are lost or arrive after | `application/drafts.service.ts:111`; `application/room.ts` (no freeze) | FR-025, AS-38 |
| A10 | Content validation is `!c.title || price === null || price < 0` with a `400`: zero price, fractional price, over-limit values pass; no `422 listing_invalid` field errors | `application/drafts.service.ts:113` | FR-027, AS-31 |
| A11 | Document key is `price`; the value type is not checked (`num()` accepts any number, fractions included) | `domain/listing-doc.ts:21-28,38-39` | FR-012, AS-31 |
| A12 | Specs are appended to the description on every publish and never parsed back, so editing a published product duplicates spec lines | `application/drafts.service.ts:114-115`; `domain/listing-doc.ts:36-45` | FR-030, AS-39 |
| A13 | `publish` names the published version with `new Date()` in application code | `application/drafts.service.ts:136` | AS-28 (frozen clock; I.3) |
| A14 | Named version reads the stored state without asking the room to flush, so it can be 100 ms behind; no name rules beyond length; no limit; no `kind`; unreadable-snapshot path does not exist (`createVersion` returns the full content in the create response) | `application/drafts.service.ts:90-102` | FR-031, FR-032, AS-40–AS-44 |
| A15 | Version list is an unpaged raw query | `application/drafts.service.ts:82-88` | AS-42 |
| A16 | No archive route; status `ARCHIVED` is in the CHECK but never used | `api/drafts.controller.ts`; `migrations/20261001270000-listing-drafts.js` | FR-004, AS-11 |
| A17 | Ticket: signed with the shared `jwt_secret`, `jwt.verify` without `algorithms`, no issuer, audience or `jti`, reusable for 60 s; ticket carries no shop; no `Origin` check on upgrade; the upgrade path does not redact `?ticket=` from logs | `infra/collab-ticket.ts:16-27`; `api/collab-server.service.ts:62-69` | FR-009–FR-011, AS-13 |
| A18 | A redirect (`4001`) happens after the ticket is accepted, and nothing consumes the ticket; with single use it must be consumed only by a successful join | `api/collab-server.service.ts:85-86` | FR-009, FR-034, AS-46 |
| A19 | Viewer writes are dropped silently; no denied-write message, counter or log; the ability is fixed at join (never rechecked) | `application/room.ts:118-123` | FR-020, AS-22, AS-23 |
| A20 | Revocation is never triggered: `DraftsService.revoke` has no caller, no consumer of `tenancy.member_removed` / `member_role_changed` / `shop_status_changed` / `shop_offboarding_started` / `shop_deleted` exists, there is no periodic re-check, and the pub/sub payload is parsed with `JSON.parse` without validation | `application/drafts.service.ts:80-83`; `application/room-manager.service.ts:35-39` | FR-021–FR-023, AS-23–AS-27 |
| A21 | Limits: frame cap 1 MiB (spec 512 KiB), room cap 50 but no per-user cap, no document-size cap, no per-connection rate, no presence size cap, no ownership check of presence ids, no presence timeout | `api/collab-server.service.ts:13-14,95`; `application/room.ts:70-79,127-129` | FR-015, FR-016, AS-18, AS-19 |
| A22 | Malformed frame handling closes `4000` only from the server wrapper; a frame that decodes but would exceed the document cap is not detected | `api/collab-server.service.ts:100-107` | AS-19 |
| A23 | Unload race: `unload` deletes the room from the map before `close()` finishes flushing, so a concurrent `acquire` loads stale state and the two rooms conflict on the log sequence | `application/room-manager.service.ts:70-76` | FR-018, AS-21 |
| A24 | Persistence error handling: the pending batch is swapped out before the write and not restored; any error (timeout, throttle) sets `failed`, closes sockets `4002` and drops the batch; no retry, no backlog limit, no identical-bytes check on conflict, no entry-size split | `application/room.ts:143-170`; `infra/draft-store.ts:70-82` | FR-019, FR-035, FR-037, AS-49, AS-52, AS-53 |
| A25 | Compaction never deletes superseded snapshots; no job for orphaned version objects; `compact` trims the log with unbounded in-memory key lists and no timeout | `infra/draft-store.ts:84-116` | FR-036, AS-51, AS-56 |
| A26 | No explicit timeouts on Dynamo, S3, Redis or Postgres calls in the draft paths | `infra/draft-store.ts`; `infra/instance-registry.ts`; `application/drafts.service.ts` | FR-038, SC-009 (IV.6) |
| A27 | Registry heartbeats every 5 s and the ring refreshes every 2 s as specified, but readiness is not tied to registration and shutdown does not order "leave ring → flush → close" (the registry removal and room flush run in different hooks) | `infra/instance-registry.ts:26-45`; `api/collab-server.service.ts:58-61`; `application/room-manager.service.ts:78-82` | FR-038, AS-47, AS-55 |
| A28 | Rooms do not release ownership when the ring changes (no rebalancing close), so after a scale-out the old instance keeps writing the moved draft until a sequence conflict | `application/room-manager.service.ts` (no ring watcher) | FR-034, AS-48 |
| A29 | No metrics and no structured fields on logs (`room X persistence failed: …` strings); `Logger.warn` prints error messages | `application/room.ts:164`; `api/collab-server.service.ts:92,103` | FR-040, AS-54 |
| A30 | No problem+json codes: `BadRequestException('Collaboration service unavailable')` is a `400` | `application/drafts.service.ts:73-74` | FR-002, AS-10 |
| A31 | Application layer imports `infra/` classes and `@nestjs/sequelize` connections directly (no ports), and `application/room.ts` imports `DraftStore` | `application/drafts.service.ts:3-15`; `application/room.ts:8`; `application/room-manager.service.ts:5` | I.2 (D-6) |
| A32 | The existing e2e calls services directly (`drafts.create`, `drafts.publish`) instead of HTTP, imports tenancy models and `Product` model, and asserts only the happy paths; there are no tests for idempotency, concurrency, IDOR, `401`, consumers, split brain or limits | `collab.e2e-spec.ts` (whole file) | VII.2, VII.3, VII.8; test-plan.md |
| A33 | Migration references other owners' tables with foreign keys (`Shop`, `Product`, `User`) and has no base version, lease, or `kind` columns | `migrations/20261001270000-listing-drafts.js:14-19,29` | FR-039, IX.4 (see D) |
| A34 | `DraftsModule` imports `ProductModule` and `AuthModule`; the collab app module imports `TenancyModule` but nothing hosts consumers or jobs | `drafts.module.ts:7-17`; `apps/collab/src/collab-app.module.ts:17` | Provides (modules) |

## B. Debt-register rows that name `catalog` or S06

| Row | Open? | What it means for S06 | Replacement mechanism |
|---|---|---|---|
| D-6 (I.2 layering) | open | `drafts.service.ts`, `room.ts`, `room-manager.service.ts` import `infra/` classes (A31); there are no repository ports | Define draft repository, update-log, snapshot, ring and backplane ports in `domain/`, adapters in `infra/`; inject by token |
| D-7 (IX.4 model imports) | open | The catalog barrel exports `ProductModel` (S05); S06's e2e imports tenancy models (`ShopModel`, `ShopMembershipModel`) | **R1** `ShopAccessService` / S05 services in the e2e fixtures and the code; drop the model usage from `collab.e2e-spec.ts` |
| D-8 (X.4 barrels export internals) | open | `index.ts` exports `CollabModule` and `DraftsModule` (fine) but apps also reach `DraftStore` through those modules' exports (`exports: [RoomManager, CollabServer, DraftStore]`, `[DraftsService, DraftStore]`) | Export only the three modules of the Provides section; add `DraftsProjectorModule`; stop exporting services and the store |
| D-12 (IX.4 raw SQL on other domains' tables) | open | See section C | **R1** (`ProductCommandService.getForShop/create/update`, `ShopAccessService`, `MembershipQueryService`) |
| D-15 (catalog → discovery cycle) | open, not S06 | S06 has no discovery import | none (S05/S32) |
| D-1, D-3, D-4, D-5, D-9, D-13, D-16 | resolved | — | — |
| D-10, D-11, D-14, D-17 | open, not `catalog` drafts | — | — |

## C. `check:table-ownership` lines for `catalog` draft code (reconstructed; run the real check)

| Kind | Finding | Where | Replacement |
|---|---|---|---|
| SQL | `SELECT … FROM "Product"`: `Product` is in `owned(catalog)`, so the check should not flag it, but the draft path duplicates S05's read rules and reads columns S05 renames (`price` → `priceMinor`) | `application/drafts.service.ts:44` | S05's in-domain exported service `ProductCommandService.getForShop(shopId, productId)` (an R1-style call, so the read rules live once) |
| SQL | `SELECT role FROM "ShopMembership"` (tenancy table) | `application/drafts.service.ts:68` | **R1** `ShopAccessService.assertMember(shopId, userId, 'products.read'|'products.write')`; the periodic re-check uses **R1** `MembershipQueryService.getMembersByShopIds` |
| SQL | `UPDATE "Product" SET …` plus its own outbox row | `application/drafts.service.ts:128-133` | **R1** `ProductCommandService.update(shopId, productId, input & { expectedVersion })` joining S06's transaction; S05 writes the event |
| Model | `drafts.module.ts` imports `ProductModule` and the e2e registers `Shop`, `ShopMembership`, `Product` models | `drafts.module.ts:7`; `collab.e2e-spec.ts:18-19,32` | the exported services of S03 and S05 only |
| FK | `"ListingDraft" REFERENCES "Shop"("id")`, `REFERENCES "Product"("id")`, `REFERENCES "User"("id")` (×2: `createdBy`) | `migrations/20261001270000-listing-drafts.js:14-16,19,29` | plain id columns; contract-step migration (drop constraints with `lock_timeout`), no replacement mechanism needed because no query joins them |
| Own tables | `ListingDraft`, `ListingDraftVersion` raw SQL in `drafts.service.ts` and `draft-store.ts` is inside `owned(catalog)` (`db/ownership.ts:66-67`) | `application/drafts.service.ts`, `infra/draft-store.ts` | stays; move into repository adapters (D-6) |
| Technical table | `outbox.notify` of `products.events` from draft code | `application/drafts.service.ts:133` | `outbox.append(draft_published)` inside S06's transaction (IX.6) and let S05 write the product event |

## D. New things the spec needs that do not exist at all

- Contracts schemas and all new routes: archive, version read, keyset list, publish with `Idempotency-Key`.
- Migration (expand/contract): drop the three foreign keys; add `baseProductVersion`, `publishLeaseId`, `publishLeaseExpiresAt`, version `kind`; allow status `PUBLISHING`; a constraint-safe way to cap open drafts at 200; registry entries stay (`db/ownership.ts` already lists both tables).
- `DraftsProjectorModule` with five consumers (inbox-based idempotency, zod validation, DLQ), the membership re-check, and two jobs (`drafts.release-stale-publishing`, `drafts.purge-superseded-snapshots`).
- Ticket service with dedicated key, `jti` single use (Redis `SET NX` with TTL), origin allowlist, log redaction.
- Frame policy (pure), room freeze, flush barrier, permission-denied message, ring watcher, backlog limit, entry splitting, identical-bytes conflict check.
- Metrics, structured logs, readiness tied to ring registration, shutdown ordering.
- Config keys: ticket key, origin allowlist, collab public URL, instance id (schema-validated at startup, VIII.5).
- Tests: the seven e2e files, four unit files and the Playwright journey of `test-plan.md`; replace `collab.e2e-spec.ts`.
- `hash-ring.spec.ts` already exists; extend it to the exact assertions of AS-45 (balance within 115% for 5 nodes, moved share ≤ 1/(N+1) + 5%, all moved ids go to the new node, empty ring).

## Sibling-spec follow-ups

- **S03**: export the pure permission check from the barrel (`can(role, permission)` in `domain/permissions.ts` exists but `index.ts` does not export it; spec asked for the name `roleHasPermission`). S06 needs it for the 60 s re-check and the per-update ability decision. Until then S06 maps the role through `ShopAccessService.assertMember(shopId, userId, 'products.write')` on connect and the re-check, and uses a local table-free call per shop batch only after the export lands.
- **S03**: `tenancy.shop_offboarding_started` and `tenancy.shop_deleted` payloads must carry `shopId` (strict consumers dead-letter anything else); topics keyed by `shopId`.
- **S05**: `ProductCommandService.update` returns the member view with no "unchanged" flag. S06 detects unchanged by `version` equal to `expectedVersion`; S05 must keep bumping `version` on every real write and keep not bumping it for an unchanged update (S05 AS-09). Also keep `ProductValidationError.fields` shape `{field, code}[]` stable.
- **S54**: the idempotency facility's reuse code must map to `idempotency_key_reuse` (spec name) or S06 translates it; confirm the facility's error `code` strings (`idempotency_key_required`, `_invalid`, `request_in_flight`).
- **S51**: no Redis pub/sub backplane library exists (`libs/infrastructure/redis-pubsub` absent); S06 keeps its adapter behind a port in `catalog/infra/collab-backplane.ts` and can move to a shared one when S51 offers it.
- **W04**: the draft editor page must consume the Provides section: connect, close-code handling and reconnect with backoff, `acknowledgeProductVersion` dialog, version list, publish with a per-attempt `Idempotency-Key`, require a brand before publish (`422 listing_invalid` field `brand`), and own `packages/web/tests/listing-editor.spec.ts`.

## Spec changes

- No `*.reviewed.json` exists for S06 and none is touched. `docs/spec/capabilities/S06-collab-editor.md` does not exist yet; WP-0 of the plan creates it before any code change. Behavior changes that alter what S05's signed page describes (publish no longer defaults the brand to `Unbranded`; `price` → `priceMinor` in the draft document) are S06-only and do not edit `docs/spec/capabilities/S05-products.md`; if a human sign-off covers a line of that page that mentions drafts, say so here when WP-0 finds it.

## Implementation notes (build pass)

Result of the build: no signed line changed. `docs/spec/capabilities/S05-products.md` mentions drafts nowhere (only its own `status: draft` front matter) and no `*.reviewed.json` exists, so the removal of the `Unbranded` fallback and the `price` → `priceMinor` key touch no human sign-off.

Decisions taken where the spec left room (each is visible in a test):

- **Sibling-spec follow-ups, additions.** **S05**: `product-boundary.e2e-spec.ts` pins the entry-point exports; its list was edited on purpose: `CollabModule`, `DraftsModule` and the new `DraftsProjectorModule` are now listed with the modules (the first two left the transitional block). **S53**: the framework wants one consumer group per consumer, so the five consumers run in groups `catalog-drafts-member-removed`, `-member-role-changed`, `-shop-status`, `-shop-offboarding` and `-shop-deleted` instead of one group `catalog-drafts`. **S03**: payloads carry `shopId` as a non-empty string, not a UUID; S06 checks UUIDs strictly itself and dead-letters anything else.
- **Publish validation** pre-checks the content with S05's own create parser (no copy of its limits); `brand` is required, `category` defaults to `uncategorized` (S05 requires one, the spec only names the brand), `quantity` to 0. A fractional or mistyped price is reported `invalid`, a missing one `required`.
- **Unchanged publish** (AS-39): the product answers unchanged (same version, no product event) and the draft still becomes `PUBLISHED` with its `published` version and a `catalog.draft_published` event; the test plan's "no new event" is read as "no new product event".
- **Ticket consumption** happens just before the upgrade completes, after the ownership (`4001`), draft (`4004`) and membership checks, so a redirect never burns the ticket but a join that the room then refuses (`4008`) has used it. The contract text said "after the room accepts the join"; a replay must be refused with `401` at the upgrade, which needs the consumption before it.
- **Owner endpoints** gained `unfreeze` (`POST /api/internal/collab/:draftId/unfreeze`): without it a failed publish could not let the room accept writes again (AS-36). All three are under the global `/api` prefix and signed with an HMAC of action, draft, lease and timestamp.
- **Read-only handshake**: the empty state frame every client sends to answer the server's first sync message is accepted silently from a read-only member; any state frame with content is denied (AS-22).
- **Membership grants** without S03's pure `can(role, permission)` export: the write ability is asked per member through `ShopAccessService.assertMember(..., 'products.write')` and the roster through one `MembershipQueryService.getMembersByShopIds` call per shop; adopt `roleHasPermission` when S03 exports it.
- **Re-check, presence and ping periods** are configurable through the `COLLAB_TIMINGS` provider (defaults 60 s, 30 s, 30 s); specs shorten them or run one round by hand (`recheckAll`, `sweepPresence`, `pingSweep`) instead of sleeping.
- Tests that need a still clock hold the shared fake clock; the frame-rate window follows that clock, so a spec that sends more than 200 frames moves the clock by a second between batches.

Static gates after the build (T072): `tsc --noEmit` of the backend (it type-checks `packages/contracts`, which has no tsconfig of its own) clean; `eslint` clean on every file of S06 (one pre-existing error in `libs/common/config/search-config.ts`, not S06's); `check:boundaries` no violation; `check:table-ownership --strict` **0 → 0** findings (the tool reported none before either; the three `catalog` rows of section C are closed by construction: no `ShopMembership`, `Shop` or `Product` statement remains in draft code); direct `sequelize.transaction` sites in `libs/domains/catalog`: **0 → 0**, `// S54 T037 audit` markers 0.

Runs of the capability (test files by name, `scripts/sdd/test-spec.sh`): drafts-api 77, drafts-publish 35, draft-versions 15, drafts-consumers 6, collab-rooms 24, collab-routing 11, collab-ops 6, drafts-boundary 1, product-boundary 3 and the four unit specs 69 pass; the S05 files (product-write, -read, -query-stock, -views, -cache, -invalidation, -events, -import, -shop-lifecycle, product.e2e) pass. One run of `product-shop-lifecycle` failed once on `Product.shopId` being nullable (its own AS-79 block drops the constraint while it runs); the same file passed on the next run, so it was another run on the shared test database, not this change.

Not run here (deferred to the final checkpoint by the rules of this pass): the standalone boot of `apps/collab`, the fresh-stack run and the browser journey. Not covered by an automated test (rows in `specs/UNVERIFIED.md`): SC-001, SC-004, SC-007.

## Baseline (WP-0)

Recorded 2026-10-16 before any code change.

- `pnpm check:table-ownership` (non-strict) prints `0 cross-domain data accesses in 0 domains`; the three `catalog` draft findings reconstructed in section C are therefore not reported by the tool in its current form. Target stays 0 with `--strict`.
- `sequelize.transaction` in `libs/domains/catalog`: 0 sites; `// S54 T037 audit` markers: 0.
- `JobsService.cancel` callers in S06 files: none.
- `fast-check`, `ws`, `@types/ws`, `y-protocols`, `yjs`, `lib0` are already in `packages/backend/package.json` (T004: nothing to add).
- Living page `docs/spec/capabilities/S06-collab-editor.md` created before the code; no `*.reviewed.json` exists or was touched.

## Gate repairs

- **Gate failure of 2026-10-17, eleventh pass (no code change).** Same unbatched heap-limit abort (4 GB, core dumped; 503s before it). `stack-fix.sh smoke` ok; `catalog/(collab-routing|collab-ops|drafts-publish|product-views)` (4 suites, 63 tests) pass in one fresh process. The batched `gate()` in `scripts/sdd/implement-specs.sh` (`GATE_BATCH`, 6 GB heap) is in the tree; the failing run predates it.

- **Gate failure of 2026-10-17, tenth pass (no code change).** Same unbatched heap-limit abort (4 GB, core dumped; 503s in the suites before it). `stack-fix.sh smoke` ok; re-run alone `collab-routing` (11) and `drafts-publish` (35) pass. The batched `gate()` in `scripts/sdd/implement-specs.sh` (`GATE_BATCH`, 6 GB heap) is in the tree; the failing run predates it.

- **Gate failure of 2026-10-17, ninth pass (no code change).** Same unbatched heap-limit abort (4 GB, core dumped). `stack-fix.sh smoke` ok; re-run alone each passes: `drafts-publish` (35), `collab-routing` (11), `collab-rooms` (24), `collab-ops` (6), `product-views` (11), `catalog-sync/import-security` (12); `npx tsc --noEmit` clean. The batched `gate()` in `scripts/sdd/implement-specs.sh` is the fix and is in the tree.
- **Gate failure of 2026-10-17, eighth pass (no code change).** Same unbatched heap-limit abort. `stack-fix.sh smoke` ok; re-run alone each passes: `drafts-publish` (35), `collab-rooms` (24), `collab-ops` (6), `collab-routing` (11), `product-views` (11), `catalog-sync/import-security` (12); `npx tsc --noEmit` clean. The fix is the batched `gate()` in `scripts/sdd/implement-specs.sh` (fresh process per `GATE_BATCH` suites, 6 GB heap); the failing run predates it.

- `libs/domains/catalog/collab.e2e-spec.ts` had been deleted and carried no scenario id, so the integrity gate could not see a replacement. It is back as a small smoke spec (real WebSockets, new ticket and room API) whose titles carry S06 AS-13, AS-14, AS-22 and AS-28; the detailed scenarios stay in `collab-rooms`, `drafts-publish` and the other `collab-*` specs. It has at least as many `it()`/`expect()` calls as at HEAD.
- **Gate failure of 2026-10-16 (no code change).** The failing specs (`collab-routing`, `collab-rooms`, `drafts-api`, `product-write`, `product-shop-lifecycle`, `product-views`, `catalog-sync/import-security`) all passed when re-run alone and in two batches (`catalog/(collab|drafts|draft-)`: 9 suites, 179 tests; `catalog/(product|rate|listing)`: 11 suites, 241 tests; `import-security`: 12 tests); `tsc --noEmit` is clean and `stack-fix.sh smoke` reports the environment ok. The gate log shows one jest process growing to its 4 GB heap limit (`JavaScript heap out of memory`) with 503s and timeouts in the suites run just before it: an exhausted process, not a defect in S06 code. `scripts/sdd/checkpoint.sh` already runs batches of fresh processes with `--max-old-space-size=6144` (L-008); the gate should use that path, not one process with the default heap.
- **Gate failure of 2026-10-17 (no code change).** Same signature: one jest process hit the 4 GB heap limit (`JavaScript heap out of memory`, core dumped) after `collab-ops`, and the earlier suites in it failed with 503s and rate-limit counts. Re-run alone, `collab-routing` (11 tests), `product-read` (17), `product-views` (11) and `catalog-sync/import-security` (12) all pass. The run that failed was not batched; use the `checkpoint.sh` path (fresh process per batch, 6 GB heap).
- **Gate failure of 2026-10-17, second pass (no code change).** Same heap-limit abort. Re-run alone on a healthy stack (`stack-fix.sh smoke` ok): `drafts-api` (77), `collab-rooms` (24), `collab-routing` (11), `catalog-sync/import-upload` (30), `product-read` (17) all pass, and the S06 batch `catalog/(collab|drafts|draft-)` passes in one fresh process (9 suites, 179 tests). The 503s and rate-limit counts come from the exhausted process, not from S06 code.
- **Gate failure of 2026-10-17, third pass (gate script fixed).** Root cause: `gate()` in `scripts/sdd/implement-specs.sh` ran every e2e suite of the domain in one jest process with the default 4 GB heap. It now lists the specs and runs them in batches of `GATE_BATCH` (default 12), one fresh process per batch with `--max-old-space-size=6144`, the same way `checkpoint.sh` does (L-008). No S06 or S05/S07 code changed; all specs named in the digest pass alone.
- **Gate failure of 2026-10-17, fourth pass (no code change).** Same signature (one jest process, 4 GB heap abort after `collab-ops`; 503s and rate-limit counts in the suites before it). The batched `gate()` in `scripts/sdd/implement-specs.sh` from the third pass is the fix; the digest still shows an unbatched run. Re-run here: `collab-routing` (11) passes alone, and the batch `catalog/(collab|drafts|draft-|product-views)` passes in one process (10 suites, 190 tests).
- **Gate failure of 2026-10-17, fifth pass (no code change).** Same heap-limit abort in one unbatched jest process (digest unchanged). Re-run on a healthy stack: `catalog/(collab-routing|drafts-publish|product-views|product-invalidation)` (4 suites, 68 tests) and `catalog-sync/import-security` (12) pass. The batched `gate()` (`GATE_BATCH`, 6 GB heap) in `scripts/sdd/implement-specs.sh` is already in the tree; the failing run did not use it.
- **Gate failure of 2026-10-17, sixth pass (no code change).** Same unbatched heap-limit abort. Re-run alone: `collab-routing` (11), `drafts-publish` (35), `product-views` (11), `product-invalidation` (11), `catalog-sync/import-security` (12) pass, and `catalog/(collab|drafts)` passes in one process (8 suites, 164 tests). The fix is the batched `gate()` already in `scripts/sdd/implement-specs.sh`.
- **Gate failure of 2026-10-17, seventh pass (no code change).** Same unbatched heap-limit abort (digest unchanged). `stack-fix.sh smoke` ok; `catalog/(collab-routing|collab-ops|product-views)` (3 suites, 28 tests) pass in one fresh process. `gate()` in `scripts/sdd/implement-specs.sh` is batched (`GATE_BATCH`, 6 GB heap); the failing run did not use it.
