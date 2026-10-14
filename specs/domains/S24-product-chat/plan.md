# Implementation Plan: S24 — Product Chat (channels, idempotent send, per-channel sequence, sync on reconnect, unread, receipts, presence, offline push) — domain `chat`

**Branch**: `S24-product-chat` | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md` (v3.1.0). Design artifacts: [research.md](research.md), [data-model.md](data-model.md), [contracts/http.md](contracts/http.md), [contracts/events.md](contracts/events.md), [contracts/services.md](contracts/services.md), [quickstart.md](quickstart.md).

## Summary

Today's `chat` (≈ 2,500 lines) works but is an IDOR (any signed-in user reads any channel), keeps logic in `application/` that reaches `infra/` and raw SQL, authorizes by a stored role, scopes idempotency per channel, counts own messages as unread, trusts a 30 s cache for deleted bodies, joins `"User"`, writes the outbox from a trigger, has no partitioning and covers 9 of 58 scenarios through services rather than HTTP. S24 replaces it with:

- **Pure rules in `domain/`**: `message-body`, `read-position`, `moderation-rules`, `escalation-decision`, `history-cursor`, `partition-months`, ports (G-37, D-6).
- **Database-owned sequence** (R-01) kept in the trigger, extended with the author's read position, a chat-owned `ChatMessageIndex` (cross-month uniqueness and sync path, R-02) and a deterministic `eventId` (R-03); `ChatMessage` monthly partitioned by an expand/backfill/contract swap.
- **One-statement decisions** (R-04): send, join, conditional state transitions; membership in every predicate (III.4); read-only diagnosis only picks the error code.
- **Live authority** (R-06): `assertMember(shopId, userId, 'products.write')` on every manager action, no cache; strictly-higher-rank rule.
- **Offline push** (R-07): scheduler with `dedupeId`, check worker with pure decision, `outbox.append` of `chat.message_escalated`, slot confirmed after append.
- **Lifecycle**: shop-deleted purge consumer, batched `shopId` backfill job, partition maintenance job.
- **Wiring and cleanup**: barrel exports modules only, `ChatProjectorModule`, `redis-pubsub` deleted, nine contract schemas, seven rate policies, counters, injected clock, models without cross-owner associations.

## Follow-ups from already-built specs (each is a requirement, planned and tested here)

| From | Requirement | Where planned / proven |
|---|---|---|
| S01 | replace the `"User"` join in `chat-offline.ts` and the `User` associations in the three models; replace `issueTokensFor` in the e2e | WP-4 (join and associations **removed**; chat shows no author name), WP-8 (`SessionIssuer` in all new specs); proven by `check:table-ownership --strict` (7 identity lines → 0) and AS-48, AS-58 |
| S01 | the 7 `owned by identity` accesses; `KNOWN_FOREIGN_ROWS` to 0 | chat's share is closed by WP-4; the other owners' rows (S28, S14, S03 test kit) are theirs — stated in the report and in gaps |
| S05 | replace `ProductModel`/`ProductDtoService.requestProduct`, drop `ChatChannel → Product` and `ProductDtoModule` | WP-4 (model), WP-5 (`ProductLookup` adapter over `getProductsByIds`); AS-01, AS-04, AS-58 |
| S28 | keep emitting `chat.message_escalated` v1 with `dedupeKey`; `NotificationRouter` and `NotificationsCoreModule` gone | WP-7 (handler appends via outbox; module imports trimmed); AS-48 asserts the outbox row and `dedupeKey`; S28 regression run |
| S30 / S48 (S25/S24/S19/S11/S21/S38) | replace the loose chat schema in `packages/contracts/src/bff/upstream.ts` under the same exported name | WP-2 re-export of `chatUnreadPageSchema`; BFF e2e green with `UPSTREAM_INVALID` absent |
| S49 | `declareJobType` with payload contracts; `InvalidScheduleError` caught | WP-7 (`chat.partition-maintenance`, `chat.backfill-shops`); AS-29 sends a malformed payload |
| S50 | derive `chat_limiter_unavailable_total` from `rate_limit_store_unavailable_total` by policy prefix | WP-2/WP-9 (R-09); AS-18 |
| S51 | move chat to `publish`; delete `redis-pubsub` (`grep` empty) | WP-6 (R-08); AS-19, AS-35; gate in WP-10 |
| S53 | adopt `dedupeId`; row contract for framework-free writers | WP-1 (trigger `eventId`), WP-7 (`dedupeId = eventId:recipientId`); AS-20, AS-42, AS-46 |
| W07 | `ChatService.createChannel` compares `product.sellerId`; convert to shop/membership rule, drop the mirror and the dev-seed backfill line | WP-5 (rule), WP-9 (mirror at `catalog/infra/product.repository.ts:110` and seed line removed after chat stops reading `sellerId`; catalog suite re-run) ; AS-01, AS-02 |
| Rule 4 (S54) | `TransactionRunner.run`; no new `sequelize.transaction`; delete audit comments | the domain has 0 direct sites and 0 `// S54 T037 audit` comments (grep, 2026-10-14); new multi-statement writes use `TransactionRunner.run`; `.tx.baseline` stays 0. The migrations' own `queryInterface.sequelize` use is in `migrations/`, outside the domain |
| Rule 2 | criteria no test proves | SC-001/SC-003 at full counts, SC-004, SC-005/SC-006 wall-clock, SC-009, start, fresh stack, large-table migration: `quickstart.md` "Ops artifacts" + 6 rows in `specs/UNVERIFIED.md` (written in this plan), status `not run` |
| Rule 0 | living spec first | WP-0 |
| Rule 1 | sibling follow-ups | `gaps.md` "Sibling-spec follow-ups" (written) |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; domain `packages/backend/libs/domains/chat`; schemas `packages/contracts/src/chat`.

**Primary Dependencies**: all present — `@nestjs/sequelize`, `TransactionRunner`, `OutboxService`/`defineEvent`, `TaskQueue`, `Projector`, `JobsService`/`@JobHandler`/`declareJobType`, S50 `definePolicies`/`@RateLimit`, S51 `TopicRegistry`/`RealtimePublisher`, S52 `CacheService.getOrLoad`, `CLOCK`, `ProductQueryService`, `ShopAccessService`, `ShopProvisioningService`, zod, `fast-check` (dev), Node `crypto` (hash, ticket). **No new library.**

**Storage**: PostgreSQL (`ChatChannel`, `ChatChannelMember` reshaped; `ChatMessage` partitioned; `ChatMessageIndex` new); Redis (presence, coalescing slot, recent-window cache, limiter, live buses); ElasticMQ/SQS `chat-offline-notify`; Kafka `chat.events` and consumed `tenancy.events`.

**Testing**: Jest e2e through `scripts/sdd/test-spec.sh` (eight files, test-plan), six table-driven unit specs under `domain/`, one contracts spec; real Postgres, Redis, queue; faults only at system edges. UI journey is W05's.

**Target Platform**: Linux; `apps/core` (`ChatModule`, `ChatSyncModule`), `apps/worker` (`ChatOfflineWorkerModule`), `apps/projector` (`ChatProjectorModule`), `apps/sse-gateway` (`ChatTopicsModule`); the Rust gateway is untouched.

**Project Type**: web-service (backend domain) + contracts package.

**Performance Goals**: sync p99 < 100 ms at 50k rps (SC-004, ops), 25k msg/s ingest (SC-009, ops); hot paths are single indexed statements.

**Constraints**: no network I/O inside a transaction (R1 services are called before it); injected clock; sequence gap-free for every writer; fail open on limiter, presence, bus, hub; fail closed on authority and membership; log lines carry IDs and lengths, never bodies.

**Scale/Scope**: 20 routes, 2 events, 1 queue, 2 jobs, 7 rate policies, 6 counters, 1 new table + 2 reshaped + 1 partitioned, 4 migrations, 6 pure modules, 8 e2e files + 1 contracts spec, 58 acceptance scenarios.

### Pool arithmetic and `statement_timeout` (III.12)

No pool is added. Send = 1 statement (+ 1 read for a replay lookup, + 1 diagnosis read only on refusal); the trigger adds 3 statements inside the same call under the channel row lock (a hot channel is serialized by design, hold ≈ single-digit ms). Moderation = 1 R1 call (outside) + 1–2 statements. Sync ≤ 50 channels = 3 statements total (membership filter, index range for all channels, body fetch), never per channel. Backfill and purge are batched ≤ 200 / ≤ 500 rows, one short transaction each, `fleetConcurrency: 1`. `lock_timeout` 3 s on the swap and on every DDL; request statements use the global `statement_timeout`.

## Constitution Check

*Gate evaluated before Phase 0; re-checked after Phase 1 (same table).*

| Principle / PR gate | Status | How |
|---|---|---|
| 1 Boundaries (I) | PASS | ports in `domain/ports.ts`, thin controllers, adapters in `infra/`, models not exported; no `forwardRef`, no `Scope.REQUEST`. Closes D-6 |
| 2 Controllers (II) | PASS | zod pipes from `packages/contracts`, `Firewall()`, `@RateLimit`, `ParseUUIDPipe` on every ID, one `ChatExceptionFilter` mapping domain errors (no `try/catch` in controllers) |
| 3 Data access (III) | PASS | `TransactionRunner.run` only; conditional updates asserting one row; membership in every predicate; constraints decide races (unique product, key index); no I/O in a transaction; keyset pages; integer sequences below 2^53 |
| 4 Migrations (III.11) | PASS | expand → backfill → contract, `lock_timeout`, `CONCURRENTLY`, `NOT VALID` → validate, guarded swap (R-02) |
| 5 Messaging (IV) | PASS with exception | consumers idempotent, zod-validated, DLQ; timeouts on outbound calls. **Exception**: `chat.message_posted` still written by a DB trigger (see Complexity Tracking) |
| 6 Contracts (V) | PASS | nine schemas + error codes in `packages/contracts`, problem+json, `409`/`404`/`422` semantics, `Retry-After`; send idempotency is the `clientMessageId` key (V.6 by design) |
| 7 Web (VI) | N/A | W05 owns it; follow-up recorded |
| 8 Tests (VII) | PASS | 58 rows at the lowest layer, VII.2/VII.3 for each endpoint, VII.4 for the scheduler, check worker and purge consumer, Gate-9 fault tests, green run recorded; L-003 no "A or B" |
| 9 Operational (VIII) | PASS | no PII or bodies in logs, new jobs single-run and idempotent, probe semantics unchanged, config validated at startup |
| 10 Isolation (IX) | PASS | `ChatMessageIndex` registered with owner `chat`; no FK to `User`/`Shop`/`Product`; no foreign table access (findings → 0, `--strict`); the outbox trigger is the one exception above |
| 11 Monorepo (X) | PASS | barrel exports modules, policies, event definitions only; `ChatProjectorModule` replaces the class import in `apps/projector`; `check:boundaries`, `check:module-graph` |

**Gate result**: no unjustified violation. **Post-design re-check**: same table; the design adds imports `chat → catalog`, `chat → tenancy` (public R1 services) only; nothing imports `chat` except the apps.

## Complexity Tracking

| Violation (rule) | Why needed | Simpler alternative rejected because | Removal date |
|---|---|---|---|
| IV.4 / IX.4 / IX.6: the `chat_message_assign_seq` trigger appends `chat.message_posted` to `"Outbox"` (a function of chat writing infrastructure's table) | The Rust gateway inserts messages without the app; only the database sees every writer; S53's connector captures only the `Outbox` table, so CDC of `ChatMessage` is unavailable (R-03); the row satisfies S53's framework-free-writer contract | Emitting from the API loses gateway messages (FR-015); polling `ChatMessage` needs a cursor table and loses per-channel ordering guarantees | **2027-03-31** (or when S53 ships a connector for `ChatMessage`) |
| III.3-adjacent: write amplification of `ChatMessageIndex` (extra row per message) | Cross-month uniqueness cannot be enforced on a partitioned table (R-02); also the sync access path | Unique index on the parent needs the partition key in the key (breaks FR-011/FR-012 across months) | none (design choice, measured by the SC-009 ops artifact) |
| X-adjacent: `ChatMessage_old` kept for one release after the swap | rollback safety for the table swap | dropping immediately leaves no `down` path | **2026-12-15** (`chat-s24-drop-old`) |

## Project structure (target state, `packages/backend/libs/domains/chat`)

```text
domain/        chat.constants.ts (roles/status enums, moved here)  ports.ts  errors.ts  config.ts
               message-body.ts  read-position.ts  moderation-rules.ts  escalation-decision.ts
               history-cursor.ts  partition-months.ts  (+ six *.spec.ts)
application/   chat-channel.service.ts  chat-moderation.service.ts  chat-message.service.ts  chat-sync.service.ts
               chat-read-state.service.ts  chat-presence.service.ts  chat-ticket.service.ts
               chat-offline-check.service.ts  chat-partition.service.ts  chat-shop-backfill.service.ts
               chat-authority.ts  events/chat-events.ts
api/           chat-channel.controller.ts  chat-message.controller.ts  chat-sync.controller.ts
               chat-presence.controller.ts  chat-moderation.controller.ts  chat.dto.ts (re-exports contracts)
               chat.exception-filter.ts  realtime-topics.ts
infra/         channel.repository.ts  membership.repository.ts  message.repository.ts  read-state.repository.ts
               presence.store.ts  live-bus.adapter.ts  coalescing-slot.ts  escalation-facts.adapter.ts
               product-lookup.adapter.ts  shop-authority.adapter.ts  recent-window.cache.ts
               chat-offline.scheduler.ts  chat-offline.worker.ts  chat-shop-purge.consumer.ts  chat.jobs.ts
               models/chat-channel.model.ts  chat-channel-member.model.ts  chat-message.model.ts  chat-message-index.model.ts
chat.module.ts  chat-sync.module.ts  chat-offline-worker.module.ts  chat-projector.module.ts  realtime-topics.module.ts
rate-limit-policies.ts  chat-metrics.ts  index.ts (trimmed)
chat-channels | chat-messages | chat-sync | chat-read-state | chat-presence | chat-offline-push | chat-moderation | chat-lifecycle  .e2e-spec.ts
chat-contracts.spec.ts
packages/contracts/src/chat/            channel.ts message.ts sync.ts unread.ts presence.ts ticket.ts events.ts index.ts
packages/backend/migrations/            <ts>-chat-s24-expand.js  <ts>-chat-s24-contract.js  (later) <ts>-chat-s24-drop-old.js
packages/backend/scripts/load-tests/    chat-sync.test.js (k6, ops artifact; created if absent)
docs/spec/capabilities/S24-product-chat.md   (living spec page)
```

Deleted: `application/chat.service.ts`, `application/chat-sync.service.ts` (split above), `infra/chat-dto.service.ts`, `chat-dto.module.ts`, `infra/chat-offline.ts` (split into scheduler/worker), `libs/infrastructure/redis-pubsub/` (last importers gone), the two old e2e specs (scenarios carried into the eight files; the old `chat.e2e-spec.ts` assertions map to AS-01, AS-02, AS-05, AS-49, AS-51; the old `chat-sync.e2e-spec.ts` ones to AS-09, AS-14, AS-21, AS-30, AS-37 — L-017: scenarios, not files, must not disappear). Edits outside the domain (minimal): `apps/projector` module import, `catalog/infra/product.repository.ts:110`, `scripts/seed/dev-seed.ts`, `packages/contracts/src/bff/upstream.ts`, `db/ownership.ts`, `elasticmq.conf` (verify only).

## Work packages (dependency order; tests first inside each)

- **WP-0 Living spec first (rule 0)**: create `docs/spec/capabilities/S24-product-chat.md` (Purpose, Entry points, Rules each with `[proof: S24 AS-nn]` and `[code: …]` clauses, `scope` globs `packages/backend/libs/domains/chat/**`, `packages/contracts/src/chat/**`); describe **today's** behavior is replaced by the new rules in the same edit; run `python3 scripts/livespec/check.py`; never touch `*.reviewed.json`. Also run `pnpm --dir packages/backend check:table-ownership` and reconcile section 3 of gaps (the command was not run at spec time).
- **WP-1 Migrations and models (G-15, G-16, G-17, G-18, G-31, G-37 models, D-7)**: [data-model.md](data-model.md) §4. Expand, backfill script, contract; trigger function (sequence, index row, author read position, deterministic `eventId`); models with plain IDs and the new columns; ownership registry. Proven by migration up on an empty and on a legacy-populated database (down only on a throwaway DB), by AS-14/AS-58 (gateway statements) and AS-28.
- **WP-2 Contracts, config, policies, metrics (G-33, G-34, G-14)**: `packages/contracts/src/chat/*`; BFF re-export; `rate-limit-policies.ts` (seven policies); validated config defaults; `chat-metrics.ts` (six counters + derived limiter counter); `chat-contracts.spec.ts`.
- **WP-3 Pure domain (G-10, G-23, G-37, G-36)**: `message-body`, `read-position` (+ `fast-check`), `moderation-rules`, `escalation-decision`, `history-cursor`, `partition-months`, errors, ports, constants; the six unit specs first (`it.each`).
- **WP-4 Repositories and adapters (G-01, G-03, G-21, G-37; ownership lines of section 3)**: Sequelize/SQL adapters behind the ports; parameterised arrays; conditional upsert join; keyset queries; no `User`/`Product` associations or reads; `ProductLookup`, `ShopAuthority` adapters over R1.
- **WP-5 Channels, membership, moderation, ticket (G-01…G-06, G-08, G-12, G-26; AS-01…AS-08, AS-49…AS-55)**: `ChatChannelService`, `ChatModerationService`, `ChatAuthority`, ticket service, controllers with pipes, exception filter, new `unmute`/`demote` routes, `204`s, `ChatTopics` UUID check. e2e files `chat-channels`, `chat-moderation` first.
- **WP-6 Send, sync, history, unread, receipts, presence (G-07, G-09, G-10, G-11, G-13, G-19…G-25; AS-09…AS-41)**: message service (one-statement send, replay compare), sync (3 statements), history page, unread page, mark read (best-effort publish, huge-channel suppression), presence (fail open, co-membership, one multi-get), recent-window cache with `deleteEpoch`, live-bus adapter and move off `redis-pubsub`. e2e files `chat-messages`, `chat-sync`, `chat-read-state`, `chat-presence`.
- **WP-7 Offline push, lifecycle, jobs (G-27…G-30; AS-42…AS-48, AS-56, AS-57, AS-29)**: scheduler (`dedupeId`), check worker with `escalation-decision`, coalescing slot token, outbox append in `TransactionRunner.run`, retries and DLQ; shop-purge consumer; `chat.backfill-shops` and `chat.partition-maintenance` with `declareJobType`; trimmed worker module. e2e files `chat-offline-push`, `chat-lifecycle`.
- **WP-8 Specs rewrite (L-017)**: the eight e2e files per `test-plan.md`, `SessionIssuer` instead of `issueTokensFor`, no `UserModel`/`ProductModel` injection, fixtures only; the old two specs deleted only after each of their scenarios exists in a new file (checklist in the task list).
- **WP-9 Wiring and cleanup (G-32, G-36, D-7, D-8, W07)**: barrel trim, `ChatProjectorModule` and `apps/projector` import, delete `ChatDtoModule`, delete `libs/infrastructure/redis-pubsub`, remove the catalog `sellerId` mirror and the dev-seed backfill line (re-run the catalog suite), ownership registry, correct the P0318 status note in `docs/work/architecture/pattern-map.md` after AS-28/AS-29 pass.
- **WP-10 Static gates**: `tsc --noEmit`, ESLint (backend and contracts), `check:boundaries`, `check:table-ownership --strict` (chat 0), `check:module-graph`, `check:model-registry`, `grep redis-pubsub` empty, `grep sequelize.transaction` in the domain empty, `.ownership.baseline`/`.tx.baseline` not risen.
- **WP-11 Whole-capability proof**: `libs/domains/chat` suite in batches of fresh processes (L-008); BFF, notifications and catalog regression; `python3 scripts/livespec/check.py`; start `apps/core`, `apps/worker`, `apps/projector`, `apps/sse-gateway` each alone (L-004, L-015, L-018, L-019); queue and table existence against the doctor (L-002, L-011); recorded in `specs/UNVERIFIED.md` as `not run` if the sandbox denies a start, never as passed.

## Gap coverage

| Gap | WP | Gap | WP | Gap | WP |
|---|---|---|---|---|---|
| G-01 | 4, 5 | G-14 | 2, 6 | G-27 | 7 |
| G-02 | 5 | G-15 | 1 | G-28 | 3, 7 |
| G-03 | 4, 5 | G-16 | 1, 7 | G-29 | 7, 9 |
| G-04 | 5 | G-17 | 1 | G-30 | 7 |
| G-05 | 5 | G-18 | 1 (+ Complexity row) | G-31 | 1, 7 |
| G-06 | 5 | G-19 | 6 | G-32 | 9 |
| G-07 | 6 | G-20 | 6 | G-33 | 2 |
| G-08 | 5 | G-21 | 4, 6 | G-34 | 2 |
| G-09 | 1, 6 | G-22 | 6 | G-35 | out of scope (W05), gaps follow-up |
| G-10 | 3, 6 | G-23 | 6 | G-36 | 3 and every service |
| G-11 | 6 | G-24 | 6 | G-37 | 1, 3, 4 |
| G-12 | 5 | G-25 | 6 | | |
| G-13 | 6 | G-26 | 5 | | |

Debt rows (gaps §2): D-6 → WP-3, 4; D-7 → WP-1, 9; D-8 → WP-9; D-12 → WP-4 (join dropped), WP-7 (backfill moved into chat). Ownership lines (gaps §3): all nine rows → WP-1 (models, FKs, trigger), WP-4 (reads), WP-7 (join drop, backfill); proven by `check:table-ownership --strict`.

## Scenario → success criterion map

SC-001 AS-14 (20 senders × 20 runs; 1,000 is an ops artifact) · SC-002 AS-21/AS-22 · SC-003 AS-10/AS-13 (20 sequential + 20 concurrent; 1,000 is an ops artifact) · SC-004 ops artifact (k6; AS-23 proves the 3-statement shape) · SC-005 AS-43/AS-44 (frozen clock) · SC-006 AS-37/AS-38 · SC-007 AS-07/24/27/33/35/39 · SC-008 AS-18/19/35/40 · SC-009 ops artifact · SC-010 AS-30/31/32.

## Risks and how the plan handles them

1. **Table swap under live writers** (R-02): guarded swap with `lock_timeout` 3 s and retry; `ChatMessage_old` kept until 2026-12-15; large-table drill is an ops artifact. The default partition keeps inserts alive if a month is missing.
2. **Trigger on a partitioned parent**: BEFORE ROW triggers on partitioned tables need PG ≥ 13; AS-58 runs the gateway's three literal statements, and AS-14 inserts through them concurrently.
3. **Hot channel contention**: the channel counter row serializes one channel only; the send statement holds no I/O; recorded for SC-009.
4. **Authority lookups on every manager action**: one in-process R1 call, outside the transaction; no cache by design (AS-54).
5. **Breaking contracts for W05**: pages instead of arrays, `204`s, `404` for strangers; every change is in `questions.md` and `gaps.md` follow-ups; the BFF section is covered by the BFF e2e.
6. **Redis bus compatibility with the Rust gateway** (R-08): if `RealtimePublisher` cannot address `chat:channel:*`, a chat-owned `LiveBusPort` keeps the raw publish; decided in WP-6 by reading the publisher before coding; the deletion of `redis-pubsub` stands either way.
7. **Crash window in the escalation** (R-07): bounded to 30 s of coalescing by the `pending` slot; AS-47 forces the failure.
8. **Wiring failures** (L-015, L-018): the e2e files boot the real modules and WP-11 starts the four apps alone.
9. **Queue/table existence** (L-002, L-011): `chat-offline-notify` and DLQ verified in `elasticmq.conf`; new tables and partitions exist in the test stack through the real migrations.
10. **Time-based tests** (L-007): injected clock everywhere; tests advance it, never sleep.
11. **Real start blocked in the sandbox**: row stays `not run` in `specs/UNVERIFIED.md`.
