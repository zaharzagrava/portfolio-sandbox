# Research: S24 — Product chat

Each entry: decision, rationale, alternatives rejected. All "NEEDS CLARIFICATION" of the Technical Context are resolved here. Facts were read from the code on 2026-10-14 (`libs/domains/chat`, `migrations/20261001260000-chat-sequences.js`, `20261009150000-chat-outbox-envelope.js`, `libs/infrastructure/{outbox,sqs,realtime,events}`, S53 `contracts/envelope.md`).

## R-01 Sequence stays in the database, in the existing trigger

- **Decision**: keep `chat_message_assign_seq` (BEFORE INSERT row trigger on `ChatMessage`): `UPDATE "ChatChannel" SET lastSeq = lastSeq + 1 … RETURNING lastSeq INTO NEW.seq`. The channel row lock serializes writers of one channel; a failed statement rolls the increment back, so no gap (AS-15). The trigger is extended (one `CREATE OR REPLACE`) to also (a) advance the author's `lastReadSeq` monotonically (G-17), (b) bump `activeMemberCount`-independent state nothing else, (c) write the chat-owned `ChatMessageIndex` row (R-02), (d) write the outbox row with a deterministic `eventId` (R-03).
- **Rationale**: the Rust gateway inserts plain rows and cannot call the app (D1); only the database can number every writer. Different channels never contend. The test `AS-14`/`AS-58` runs the gateway's literal statements.
- **Rejected**: Redis `INCR` per channel (not transactional with the insert → gaps on rollback, loses counter on flush); advisory locks in the app (gateway bypasses them); `MAX(seq)+1` in the insert (race, slow).

## R-02 Monthly partitioning with a chat-owned index table for cross-month uniqueness (P0318, AS-28)

- **Decision**: `ChatMessage` becomes `PARTITION BY RANGE ("createdAt")`, primary key `(id, "createdAt")`, one partition per UTC month, plus `ChatMessage_default`. A small non-partitioned table **`ChatMessageIndex`** `(channelId, seq)` PK, `messageId`, `createdAt`, `authorId`, `clientMessageId NULL`, `bodyHash`, with a partial unique index `(channelId, authorId, clientMessageId) WHERE clientMessageId IS NOT NULL`, is written by the same trigger in the same statement. It is the cross-month guard for both uniqueness rules (a partitioned table cannot enforce them across months) and the access path for sync: `WHERE channelId = :c AND seq > :cursor ORDER BY seq LIMIT 200` hits one index, then fetches bodies by `(id, createdAt)` with partition pruning. The API's idempotent send catches `unique_violation` on the key index, reads the original through the index, compares `bodyHash`/`replyToId`, and answers `200 duplicate` or `422 idempotency_key_reuse`; the failed statement rolled the sequence back.
- **Rationale**: one extra narrow row per message buys atomic cross-month uniqueness, a partition-independent sync path and the author-scoped key (G-09) with no application-side race. SC-009 (25k msg/s) is an ops artifact; write amplification is recorded as a risk.
- **Migration path** (III.11, expand/contract, each with `lock_timeout`): (1) expand: create `ChatMessage_new` partitioned + partitions for the oldest message month … current + 3, `ChatMessageIndex`; (2) backfill in batches ≤ 5,000 ordered by `id` (copy rows into `_new`, rows into the index) while the old table stays authoritative; writers keep inserting into the old table, whose trigger already writes the index; (3) contract: in one short transaction (`lock_timeout 3s`, retried by the migration runner) take `ACCESS EXCLUSIVE` on the old table, copy the tail (rows newer than the last batch), rename `ChatMessage → ChatMessage_old`, `ChatMessage_new → ChatMessage`, recreate trigger on the new parent; `ChatMessage_old` is dropped by a later migration (`gaps` item, removal 2026-12-15). Gateway statements keep working: same table name, same columns, trigger on the parent (BEFORE ROW triggers on partitioned tables are supported from PG 13; the repo runs a newer major, asserted by AS-58).
- **Default partition** keeps inserts alive when a month is missing; `chat_history_partition_missing_total` counts rows landing in it (read by the maintenance job, AS-29).
- **Rejected**: partition by `channelId` hash (no time-based retention, no month-boundary story); wide-column store (the notes' "next step", out of scope); unique index on the parent including `createdAt` (does not give `(channelId, seq)` uniqueness across months).

## R-03 `chat.message_posted` emission: the trigger stays as a recorded, dated exception

- **Decision**: CDC of `ChatMessage` is **not available**: S53 R-16 / AS-22 ships a connector that captures **only** the `Outbox` table (`infra/debezium/outbox-connector.json`). The default in `questions.md` therefore falls to its fallback: the trigger keeps writing the outbox row, under the **row contract of `S53 contracts/envelope.md` "framework-free writers"** (already satisfied by migration `20261009150000`), recorded in Complexity Tracking with removal date **2027-03-31** (rule IX.4/IX.6). The change: `eventId` becomes deterministic per message — a UUID whose first 48 bits are the message id's (UUIDv7 timestamp) and whose rest is `md5('chat-msg:' || id)`, version nibble `7`, variant `8` — and the outbox row `id` equals it, so a re-run can only collide, never duplicate. The envelope's `aggregateId = channelId`, `aggregateVersion = seq` are unchanged.
- **Rationale**: the spec's "exactly one event per stored message, whichever writer" is only achievable at the data layer; a second CDC connector is an S53 change. The follow-up "(from S53) adopt `dedupeId`" is met by (a) the deterministic `eventId` on the row (consumers dedupe on it) and (b) `dedupeId = <eventId>:<recipientId>` on every scheduled check (R-07); chat events are `kind='event'` rows, task rows (with the outbox row id as queue dedupe id) are not used by chat.
- **Removal condition**: when S53 ships a second connector for `ChatMessage` (or the gateway appends to the outbox itself), delete the outbox insert from the trigger in a contract migration; the test AS-20 stays unchanged (it asserts the event, not the mechanism).
- **Rejected**: emitting from the API after insert (gateway rows get no event); polling `ChatMessage` by a job (needs a cursor table, loses ordering, still a gap window).

## R-04 Message send: one statement decides, a diagnosis read only picks the error code

- **Decision**: `INSERT INTO "ChatMessage" … SELECT … FROM "ChatChannelMember" m JOIN "ChatChannel" c … WHERE m.channelId = $1 AND m.userId = $2 AND m.status = 'ACTIVE' AND (m."mutedUntil" IS NULL OR m."mutedUntil" <= $now) AND c."isArchived" = false AND ($replyTo IS NULL OR EXISTS (SELECT 1 FROM "ChatMessageIndex" … same channel)) RETURNING …`. Zero rows → one read-only query classifies the refusal (`404`, `403 banned`, `403 muted`+`mutedUntil`, `409 channel_archived`, `422 reply_target_invalid`); the classification never grants anything (III.4). The insert's `$now` comes from the injected clock. Body normalization (`trim`, code-point length 1–4000) is the pure `domain/message-body.ts`; the zod schema calls it.
- **Rejected**: load membership then insert (race with a ban, III.4); `SELECT … FOR UPDATE` on the member (the insert already serializes on the channel row).

## R-05 Channel creation and the unique constraint

- **Decision**: `ChatChannel` gets `shopId` (plain UUID, no FK), the unique constraint on `productId` already exists (`20260925090000-create-chat-tables.js:25`), `INSERT … ON CONFLICT ("productId") DO NOTHING RETURNING`; zero rows → `409 channel_exists`. Authority: `ProductQueryService.getProductsByIds([id])` → product's `shopId`/`status`; `ShopAccessService.assertMember(shopId, userId, 'products.write')` (both before the transaction; in-process R1 services, no network inside the transaction). The creator's `OWNER` member row and the channel row are written in one `TransactionRunner.run`.
- **W07 follow-up (`product.sellerId`)**: chat no longer reads `Product.sellerId`; after the chat change lands, the catalog writer's mirror `"sellerId" = createdBy` (`catalog/infra/product.repository.ts:110`, `$3,$3`) and the dev-seed backfill line (`scripts/seed/dev-seed.ts`, the `sellerId` assignment) are removed (WP-9). The column stays (other readers: load-test seeds); only the mirror write goes.

## R-06 Manager authority is live and uncached; rank of a target

- **Decision**: `ChatAuthority` (application) asks `ShopAccessService.assertMember(channel.shopId, userId, 'products.write')` on every manager action; the result is not stored. Rank of a target = `getRole(shopId, targetId)` non-null with `products.write` → STAFF(3); stored `MODERATOR` → 2; `MEMBER`/stored `OWNER` without shop role → 1. The pure `domain/moderation-rules.ts` takes the two ranks and the action and answers allow / `forbidden` / `invalid_transition`. Transitions are conditional updates (`UPDATE … WHERE status = :from`, one row asserted).
- **Rejected**: caching authority in Redis (stale authority is a security bug, `questions.md` CONTRACT); trusting the stored `OWNER` role.

## R-07 Offline push: pure decision, appended event, slot confirmed after append

- **Decision**: scheduler (`ChatProjectorModule`, Projector on `chat.events`) enqueues ≤ 50 delayed checks per event with `dedupeId = <eventId>:<recipientId>`. The check worker handler is `ChatOfflineCheckService.check`: reads the facts (message deleted?, recipient active member?, channel archived?, `lastReadSeq`, presence, slot) through ports and calls the pure `domain/escalation-decision.ts` → `read | online | deleted | ineligible | notified | coalesced`. On `notified`: take the slot as `pending` (`SET NX EX 30`), `outbox.append(ChatMessageEscalated)` in a `TransactionRunner.run`, then confirm the slot (`SET XX EX 300`); on append failure delete the slot only if it still holds this check's token and rethrow (queue retries ≤ 5 → DLQ). A crash between take and append loses at most 30 s of coalescing, never 5 minutes. Store outage on presence or slot → treated as offline / not coalesced (fail toward notifying) plus counter. `dedupeKey = chat:<recipientId>:<channelId>:<messageId>`; S28 deduplicates on it.
- **Rationale**: honours AS-43…AS-48 and the S28 CT-1 contract already shipped.
- **Rejected**: taking the 300 s slot first (current code: failed dispatch loses the push); a stored "check" table (spec: not in the primary database).

## R-08 Live bus: move chat to the S51 publisher and delete `redis-pubsub`

- **Decision**: the gateway-compatible buses (`chat:channel:<id>`, `chat:moderation`) keep their names and JSON formats. S51 `RealtimePublisher.publish(topic, event, payload, { replay })` supports them? **Check at WP-5 start**: if the publisher cannot address the raw `chat:channel:*` Redis channel the Rust gateway subscribes to, the compatibility bus stays behind a chat-owned `LiveBusPort` whose adapter (`infra/chat-live-bus.adapter.ts`) is the **only** user of `RedisService.publish`, and `libs/infrastructure/redis-pubsub` is still deleted (its only importers are `chat.module.ts` and `chat.service.ts`, verified with grep). `read` and `presence` go through `RealtimePublisher.publish(..., { replay: false })` on topic `chat:<channelId>`. Publishing is after commit, best effort, counted `chat_push_failed_total{kind}`.
- **Rationale**: closes the two S51 follow-ups; `grep -rn redis-pubsub packages/backend` must be empty (gate).

## R-09 Limits and metrics

- **Decision**: seven policies in `chat/rate-limit-policies.ts` via `definePolicies` (names and values from the spec), applied with `@RateLimit`; all fail open. `chat_limiter_unavailable_total` is **derived** from S50's `rate_limit_store_unavailable_total` by policy prefix `chat.` (follow-up from S50): a recording rule/alias in the chat metrics module, not a second counter incremented in code. Other counters are plain S54 registry counters (`chat_push_failed_total{kind}`, `chat_presence_unavailable_total`, `chat_escalation_failed_total`, `chat_history_partition_missing_total`, `chat_purge_noop_total`, `chat_offline_check_total{outcome}`).

## R-10 Recent-messages window cache

- **Decision**: S52 `CacheService.getOrLoad` keyed `chat:recent:<channelId>:<lastSeq>:<deletionEpoch>`; `deletionEpoch` is `ChatChannel.deleteEpoch` (BIGINT, incremented in the same transaction as a delete). A delete changes the key, so an old window is never served (AS-26) and needs no eviction race. Tombstones are produced from the row (`deletedAt`), never cached as bodies.
- **Rejected**: evict-after-commit only (a reader between commit and evict, or a failed evict, serves a deleted body); no cache (SC-004 target).

## R-11 Huge-channel threshold

- **Decision**: `ChatChannel.activeMemberCount INT NOT NULL DEFAULT 0`, maintained in the membership transactions (join insert, ban/unban status flips) with the same conditional-update statements; backfilled in the migration; a nightly-free approach is not needed because every writer goes through those statements (the gateway's create-if-absent membership statement is also covered by a trigger on `ChatChannelMember` that adjusts the count — the statement is unchanged, AS-58).
- **Rejected**: `COUNT(*)` per receipt/heartbeat (hot path).

## R-12 Shop-id backfill and purge

- **Decision**: `ChatShopBackfillJob` (S49 job `chat.backfill-shops`, concurrency 1, batch ≤ 200 channels `WHERE shopId IS NULL`, keyset by id): products via `getProductsByIds`, legacy sellers via `ensureShopsForLegacySellers`; idempotent; self-stops when no row is left; the contract migration `shopId SET NOT NULL` (`NOT VALID` check then `VALIDATE`) runs after the job reports zero (migration refuses otherwise). The tenancy raw `UPDATE "ChatChannel"` job **no longer exists** in the tree (verified: no tenancy file names `ChatChannel`), so there is nothing to delete there; S03 is told in gaps.
- **Purge**: `ChatShopPurgeConsumer` (Projector on `tenancy.events`, `tenancy.shop_deleted` v1 `{shopId}`), zod-validated, deletes messages → index → members → channels in batches ≤ 500 keyed by `channelId` (messages deleted per partition by `channelId` index), idempotent, `chat_purge_noop_total` when nothing is left; invalid payload → DLQ by the framework.

## R-13 Layering (D-6) and the barrel (D-7, D-8)

- **Decision**: `domain/` ports (`ChannelRepository`, `MembershipRepository`, `MessageRepository`, `UnreadRepository`, `PresenceStore`, `LiveBus`, `ShopAuthority`, `ProductLookup`, `EscalationFacts`, `Clock` = `CLOCK`), pure modules (`message-body`, `read-position`, `moderation-rules`, `escalation-decision`, `history-cursor`, `partition-months`), `application/` services use ports only, `infra/` holds Sequelize/SQL/Redis adapters and the three models (not exported). Barrel exports: `ChatModule`, `ChatSyncModule`, `ChatTopicsModule`, `ChatOfflineWorkerModule`, `ChatProjectorModule`, rate policies, event definitions, DTO types. `apps/projector` imports `ChatProjectorModule`; `ChatDtoModule`/`ChatDtoService` are deleted (their only job was model access for the two services).
- **Models**: drop `@BelongsTo(User|Product)`/`@ForeignKey` (G-37, section 3); the UserDirectory follow-up is satisfied by **removing** the reads, not by calling `getUsersByIds` (chat shows no author name — `questions.md` CONTRACT, which asks S01 to drop S24 from its consumer list). The chat e2e specs use `SessionIssuer` instead of `issueTokensFor`.

## R-14 Contracts

- **Decision**: `packages/contracts/src/chat/{channel,message,sync,unread,presence,ticket,events}.ts` + `index.ts`; the nine named schemas plus `chatErrorCodeSchema`. `packages/contracts/src/bff/upstream.ts` re-exports `chatUnreadPageSchema` under the BFF's existing exported name (follow-up S48/S30): the BFF's section `chat unread page` keeps its name, its shape changes from the loose object to the paged `{items, nextCursor}`; the BFF e2e must stay green with `UPSTREAM_INVALID` absent. Web `lib/api/chat.ts` is W05's (gap G-35): recorded as a sibling follow-up, not edited.

## R-15 Time, transactions, jobs

- Every `new Date()`/`Date.now()` in `application/` becomes `this.clock.now()` (`CLOCK`). The domain has **0** direct `sequelize.transaction` sites (verified by grep; `.tx.baseline` = 0): all new multi-statement writes use `TransactionRunner.run`; no `// S54 T037 audit` comment exists in the domain. Job types `chat.partition-maintenance` and `chat.backfill-shops` are declared with `declareJobType` next to their `JobPayloads` augmentation (S49 follow-up: payload contract = empty object); schedule registration catches `InvalidScheduleError`.

## R-16 WS ticket

- **Decision**: same 60 s signed credential (`sub`, `typ: "ws"`), clock injected, `chat.ws-ticket.user`; key and claims via the S01/S54 configuration the ticket code already reads; session revocation is honoured because the route sits behind `Firewall()` (a revoked session cannot call it). Ticket is not accepted by the API firewall (`typ: "ws"` rejected as a bearer — asserted in AS-55).

## R-17 Failure classes (lessons) applied

- L-001: no FIFO options anywhere (chat uses a standard queue; `dedupeId` is accepted by the port for standard queues — verified by `InvalidEnqueueOptionsError` test in AS-46). L-002/L-011: queue `chat-offline-notify` and its DLQ must be in `elasticmq.conf`; `ChatMessageIndex` and the partitions in the test stack's migrations; checked by the doctor in WP-11. L-003: no "A or B" assertions; the outage faults assert the fault was reached. L-005/L-006: every e2e creates its own shop, product, channel, users. L-007: injected clock, no sleeps. L-008: suite in batches. L-010: channel creation answers `409`, never a duplicate. L-015/L-018: `apps/core`, `apps/worker`, `apps/projector`, `apps/sse-gateway` each started alone (WP-11).

## R-08 addendum (T004, decided during implementation)

- `RealtimePublisher.publish` (S51) writes its own envelope `{id,topic,type,data,ts}` to the hub channel `channelName(topic)` (and a stream when replayable). It cannot produce the gateway-compatible raw Redis channels `chat:channel:<id>` / `chat:moderation` with the Rust gateway message formats. **Decision**: the gateway buses stay behind a chat-owned `LiveBusPort` whose adapter (`infra/live-bus.adapter.ts`) publishes through the platform `RedisService` client (the only chat user of Redis `PUBLISH`); `read` and `presence` events (hub topic `chat:<channelId>`) use `RealtimePublisher.publish(..., {replay:false})`. `libs/infrastructure/redis-pubsub` is deleted either way.
