# Gaps: S24 — Product chat (domain `chat`)

What the current code gets wrong or lacks versus [`spec.md`](spec.md), the open debt-register rows that touch this capability, and this domain's cross-domain access lines. This is the implementation agent's to-do list. All paths are under `packages/backend/libs/domains/chat/` unless stated; line numbers are those of the draft at spec time.

Existing tests: `chat.e2e-spec.ts` (5 tests: ticket, create, non-seller 403, mute, join/ban; no `401`, no cross-tenant, no validation, no concurrency; imports `UserModel` and `ProductModel`, `:9-11`) and `chat-sync.e2e-spec.ts` (4 tests that call `ChatSyncService` directly, never HTTP, so VII.2 is not met; raw-SQL seeding of `ChatChannel`/`ChatChannelMember` at `:45-48` is acceptable test-harness code). Both are split and rewritten against the 58 scenarios in the files named in `test-plan.md`.

`pnpm --dir packages/backend check:table-ownership` could not be run while writing this file (the command needs an approval that was not available in this unattended session). Section 3 is therefore built from reading the code; the implementation agent must run the command first, reconcile its `chat` lines with section 3, and finish with `--strict` green.

## 1. Gaps in the code (spec reference → what is wrong or missing → fix)

### Channels, membership, authorization (`application/chat.service.ts`, `api/chat.controller.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-01 | FR-001, AS-01…AS-04 | `:82-90` product from catalog's `ProductDtoService`; creator must equal `product.sellerId`; channel has no `shopId`; `:117-121` duplicate product is `400`; no archived-product check; `:86` message text. | S05 R1 `getProductsByIds([productId])`; S03 R1 `assertMember(product.shopId, userId, 'products.write')`; store `shopId`; `409 channel_exists` / `409 product_archived`; unique constraint decides concurrent creates; DTO `forbidNonWhitelisted`; `chat.channel-create.user` limit. |
| G-02 | FR-003, AS-07 | `:126-139`, `:153-166` any signed-in user receives any channel (`myRole` undefined for strangers); `by-product` and by-id are the same behaviour; `chat.controller.ts:62-76,88-96` have no `ParseUUIDPipe`. | By-id requires an active membership (the predicate carries `userId`, III.4) else `404`; `by-product` returns public fields, `myRole: null`; add the pipe to every route. |
| G-03 | FR-002, AS-05, AS-06 | `:145-151` `ensureMember` creates the row, then checks `BANNED` after the fact; archived is `403`; new members start at `lastReadSeq = 0` (so the whole history is unread); concurrency relies on `findOrCreate` in `chat-dto.service.ts:141-145`. | One conditional upsert that never touches role/status of an existing row; archived `409 channel_archived`; read position starts at the channel's current sequence. |
| G-04 | FR-004, AS-08 | `:168-199` archive/unarchive repeat silently succeeds; `new Date()` at `:186`; publish happens after the update outside any ordering guarantee; stored role `OWNER` is the only authority. | State transition as a conditional update (`WHERE isArchived = :from`, one row, III.7) → `409 invalid_transition`; injected clock; manager authority = R1 `assertMember(..., 'products.write')` (G-12); publish after commit. |
| G-05 | FR-040, AS-49…AS-52 | `:250-347` ban/unban/mute/promote use `ensureMember` on the target (`:257,280,304,333`), creating a row for any UUID; no transition guards; `unmute`/`demote` missing although the enums have them (`domain/chat.constants.ts:21-28`); `Date.now()` at `:303`; responses are `201 {success: true}` (`chat.controller.ts:116,127,138,149`). | Target must be an existing member (`404 member_not_found`); conditional status/role updates with `409 invalid_transition`; add `members/unmute` and `members/demote`; `204`; injected clock; events after commit. |
| G-06 | FR-040, AS-50, AS-53 | `:223-248` a moderator may delete anyone's message including the owner's; the delete is not idempotent (second call updates again, `chat-dto.service.ts:225-228`); event published even on repeat. | Strictly-higher-rank rule; `UPDATE ... WHERE id AND channelId AND deletedAt IS NULL`; repeat answers `204` with no second event; record `deletedBy`; message predicate includes `channelId`. |
| G-07 | FR-003, AS-27 | `:201-221` non-members read any channel's history; `before` is a message ID; deleted rows excluded (`models/chat-message.model.ts:53`); a bare array is returned; `ChatMessage` entities (ORM models) are serialized directly (V.1). | Membership predicate; `{items, nextCursor}` with an opaque cursor over `(seq DESC)`; tombstones included; response DTO `chatMessageSchema`; `limit` 1–100 with a `400` outside. |
| G-08 | FR-042, AS-55 | `:349-363` ticket via `Date.now()`; signed with `jwt_secret`; no rate limit; no session-revocation awareness. | Injected clock; `chat.ws-ticket.user`; keep claims `sub`, `typ: "ws"`, 60 s; key handling per S01/S54 configuration. |

### Send, sequence, idempotency (`application/chat-sync.service.ts`, `api/chat-sync.controller.ts`, migration)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-09 | FR-011, AS-10…AS-13 | `:56-71` unique key is `(channelId, clientMessageId)` (migration `20261001260000-chat-sequences.js:65-67`); replay returns the row without comparing content; foreign reuse is `403` (`:69`), disclosing the other message; controller answers `201` for replays (`chat-sync.controller.ts:28-31`, no `HttpCode`). | Key `(channelId, authorId, clientMessageId)` (expand/contract index swap, `lock_timeout`, `CREATE INDEX CONCURRENTLY`); compare body and `replyToId` → `422 idempotency_key_reuse`; `200`/`201` by outcome; shape `sendMessageResponseSchema`. |
| G-10 | FR-010, AS-15, AS-16 | `chat-sync.controller.ts:9` `@Length(1, 4000)` counts UTF-16 units, no trim, whitespace-only accepted; `replyToId` unchecked, so the self-referencing foreign key fails as an unhandled `500` (`:56-62`). | Pure `domain/message-body.ts` (trim, code-point length 1–4000); reply target validated in the insert (`WHERE EXISTS` in the same channel, tombstones allowed) → `422 reply_target_invalid`; global `forbidNonWhitelisted`. |
| G-11 | FR-013, AS-17 | `:201-209` `assertCanPost` collapses banned, muted and archived into one `403`; archived should be `409`; `new Date()` at `:208`; membership lookup is a separate query from the insert. | Distinct codes (`banned`, `muted` + `mutedUntil`, `channel_archived`); injected clock; one statement joining membership + channel state to the insert (no load-then-check, III.4). |
| G-12 | FR-031, AS-54 | `chat.service.ts:174,327,387` authority is the stored role (`OWNER`/`MODERATOR`), so a person removed from the shop keeps control. | Manager = R1 `assertMember(channel.shopId, userId, 'products.write')` on every manager action; no caching of the answer (see Contract questions). |
| G-13 | FR-014, AS-19 | `:73-76` the live-bus publish is awaited after the insert with no error handling: a bus outage turns a stored message into a `500`, and a client retry then returns `duplicate: true`. | Publish after commit, best effort, `chat_push_failed_total{kind="message"}`; never fail the send. Include `seq` in the envelope this API publishes. |
| G-14 | FR-013, AS-18, AS-41 | No rate limits on any chat route. | S50 policies `chat.send.user`, `chat.sync.user`, `chat.read.user`, `chat.heartbeat.user`, `chat.presence.user` (fail open + counter). |
| G-15 | FR-012, AS-14, AS-15 | Migration trigger `chat_message_assign_seq` (`:39-62`) assigns seq by `UPDATE "ChatChannel" ... RETURNING`; gap-free and transactional, good; but it also (a) inserts into `"Outbox"` (G-18), (b) does not advance the author's read position (G-17). `ChatMessage.seq` is nullable (`:24`) and the Sequelize models know none of `seq`, `lastSeq`, `lastMessageAt`, `clientMessageId`, `lastReadSeq` (model drift). | Keep sequence in the database; make `seq` `NOT NULL` after backfill (expand/contract); add the columns to the models; test the trigger through the gateway's statements (AS-14, AS-58). |
| G-16 | FR-024, AS-28, AS-29 | `ChatMessage` is not partitioned (SD-14 "Not done", `:52`); the pattern map marks P0318 "implemented" for chat, which is wrong for this table. | Monthly range partitioning on `createdAt` (PK `(id, createdAt)`); chat-owned dedupe store for `(channelId, authorId, clientMessageId)` and a guard for `(channelId, seq)` across months; default partition; job `chat.partition-maintenance` (S49) creating current + 3 months idempotently; backfill by expand/contract; correct the pattern-map status note once verified. |
| G-17 | FR-030, AS-31 | `unread` (`:129-137`) counts own messages (`chat-sync.e2e-spec.ts:102` asserts 5 for the author); the trigger never advances `lastReadSeq` for the author. | Trigger (or equivalent in the system of record) sets the author's `lastReadSeq = NEW.seq` monotonically; update the e2e expectation. |
| G-18 | FR-015, AS-20 | Trigger inserts a `chat.message_posted` envelope into the outbox table (`migration :48-55`): a chat function writing another owner's table (IX.4, IX.6); `eventId` is `uuidv7()` per insert; the key is `aggregateId = channelId` (good) and `version = seq` (good). | Emit from the message rows by CDC (default) with `eventId` derived from the message (`chat-msg:<messageId>`) and drop the trigger's outbox insert; if CDC is unavailable keep it as a recorded exception with a removal date in `plan.md` Complexity Tracking. |

### Sync, history, unread, receipts (`chat-sync.service.ts`, `chat-sync.controller.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-19 | FR-020, FR-021, AS-23…AS-25 | `:89` `slice(0, 50)` silently truncates; controller `:39` drops invalid keys/cursors; `Math.floor` of fractions at `:101`; no upper bound on cursor values; `SyncDto` only `@IsObject`. | `400 too_many_channels` > 50; `400 validation_failed` for any invalid entry; zod `chatSyncRequestSchema`; integer 0…2^53−1. |
| G-20 | FR-022, AS-26 | `:185-199` the recent-messages window is cached 30 s keyed by `(channel, lastSeq)`; a moderation delete inside it keeps serving the body; delete does not touch the cache (`chat.service.ts:241`). | A delete evicts the affected window keys (or the window excludes deleted bodies at read time); test: sync, delete, sync. |
| G-21 | FR-020, AS-21, AS-22 | `:108-116` builds a Postgres array literal by string concatenation `{${ids.join(',')}}` (safe only because the controller regex-validates UUIDs and cursors are numbers; fragile, III.5). | Parameterised arrays; validation moves to the schema so the service never receives unvalidated input. |
| G-22 | FR-030, AS-30 | `:129-137` `LIMIT 200` truncates silently, offset-free but not paged; excludes archived; banned excluded (good). | Keyset page `(lastMessageAt DESC, channelId DESC)` with an opaque cursor, `limit` 1–200 default 50; response `chatUnreadPageSchema`. |
| G-23 | FR-032…FR-034, AS-32…AS-36 | `:144-157` monotonic cap via `GREATEST/LEAST` is right; non-member `404` is right; a publish failure after commit surfaces as `500` (`:155`); receipts always published, even in huge channels; `ReadDto` has no upper bound (`chat-sync.controller.ts:17-19`). | Publish best-effort + counter; suppress above 50 active members (denormalized count); upper bound 9,007,199,254,740,991. |
| G-24 | FR-035, FR-037, AS-37, AS-38, AS-40 | `:164-173` Redis outage makes the heartbeat throw (`500`); the first-heartbeat broadcast reads `ChatChannel.lastMessageAt`; broadcast per channel awaited serially; no huge-channel guard; `Date.now()` at `:165`. | Fail open with counter; publish to ≤ 20 channels in parallel with a per-call timeout; skip huge channels; injected clock. |
| G-25 | FR-036, AS-39 | `:175-179` any user ID can be polled (privacy leak); one Redis `GET` per ID inside `Promise.all`; controller `:64-69` silently drops invalid IDs and `>100` is `BadRequest` without a problem code. | Co-membership filter (users ∩ caller's active channels, one query); one multi-get; `400` for invalid IDs; `503 presence_unavailable` on store failure. |
| G-26 | FR-003, AS-35 | `api/realtime-topics.ts:19-25` topic policy queries `ChatChannelMember` directly (own table, fine) but accepts any non-empty `channelId` format and an `ACTIVE` check only (banned/removed excluded: good). | Keep; add the UUID shape check; cover with AS-35. |

### Offline push (`infra/chat-offline.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-27 | FR-038, AS-42, AS-46 | `:45-55` recipients ≤ 50 enforced, but the queue message has no dedupe identity, so a repeated Kafka delivery enqueues duplicates; banned recipients excluded (good); no `version`/order handling. | `dedupeId = (eventId, recipientId)`; consumer inbox/DLQ per S53; invalid payload dead-lettered. |
| G-28 | FR-039, AS-43…AS-48 | `:86-91` joins `"User"` to build `split_part(email, '@', 1)` as the sender (D-12 SQL; leaks an e-mail fragment); `:92` no check for archived channel, banned recipient or deleted message; `:94` takes the 5-minute coalescing slot before dispatching, so a failed dispatch loses the push for 5 minutes; `:96-103` calls `NotificationRouter.dispatch` directly; presence/coalescing store outages are not handled. | Drop the `User` join; outcomes `read`/`online`/`deleted`/`ineligible`/`notified`/`coalesced` from a pure `domain/escalation-decision.ts`; append `chat.message_escalated` through `outbox.append` inside the check's transaction; release/never take the slot on failure; retries ≤ 5 then DLQ; fail toward notifying on store outages; counters. |
| G-29 | FR-039 | `chat-offline-worker.module.ts:12` imports `NotificationsCoreModule` and re-provides `ChatSyncService` (a second instance of the whole service for one method). | Remove the notifications import; a small `PresenceReader` port in `domain/` implemented in `infra/`. |

### Lifecycle, isolation, wiring

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-30 | FR-043, AS-56 | No consumer of `tenancy.shop_deleted`. | `ChatShopPurgeConsumer` (projector): zod-validated payload, bounded batches, idempotent, DLQ. |
| G-31 | FR-044, AS-57 | `libs/domains/tenancy/infra/tenancy-backfill.jobs.ts:56` runs raw `UPDATE "ChatChannel" SET "shopId"` (tenancy's gap A22). `ChatChannel` has no `shopId` field in the model (`models/chat-channel.model.ts`). | Chat-owned batched backfill (≤ 200) via `ensureShopsForLegacySellers` + `getProductsByIds`; contract step makes `shopId` `NOT NULL`; coordinate with S03 deleting its job. |
| G-32 | FR-045, AS-58 | `index.ts:7-9,13` exports the three models and `ChatOfflineScheduler`; `chat.module.ts` imports catalog's `ProductDtoModule`; apps import the scheduler class directly (`apps/projector/src/projector.module.ts:7,52`); `ChatOfflineWorkerModule` imports notifications. | Barrel exports modules + DTO types + event contracts only; new `ChatProjectorModule` (scheduler + purge consumer) replaces the direct class import; drop `ProductDtoModule`. |
| G-33 | FR-050 | No `packages/contracts` schemas for chat; `packages/web/lib/api/chat.ts` hand-writes its types; controllers return ORM models and ad hoc objects. | Add the nine schemas (see spec Provides); response DTOs only; e2e parses with them (VII.6). |
| G-34 | FR-052 | No metrics, no outcome counters. | Add `chat_*` counters named in FR-052. |
| G-35 | W05 (not this lib) | `packages/web/lib/api/chat.ts:48-49` makes a new `clientMessageId` for every `send` call, so a caller-level retry duplicates; `myChannels` expects a bare array (`:42`). | Out of scope here; recorded in `questions.md` (CONTRACT) for W05. |
| G-36 | FR-051 | Several `new Date()` / `Date.now()` calls in `application/` (`chat.service.ts:186,303,359`, `chat-sync.service.ts:165,208`). | Inject the clock port. |
| G-37 | I.2, D-6 | `application/chat.service.ts:9,14-19` imports `../infra/chat-dto.service` and `infra/models/*`; `chat-sync.service.ts` and `infra/chat-offline.ts` run raw SQL through `Sequelize` in `application/`; `api/chat.dto.ts:13` imports a model enum; `chat-sync.controller.ts` declares DTOs inline. | Repository ports in `domain/`, adapters in `infra/`; role/status enums in `domain/`; DTOs in `api/`. |

## 2. Open debt-register rows touching this capability

The register's rows never name `chat` literally; these open rows apply to the domain through their generic scope:

| Row | Applies how | Paid by |
|---|---|---|
| D-6 (I.2 layering) | G-37: `application/` imports `infra/` models and repositories and issues raw SQL | repository ports (`domain/`) and adapters (`infra/`) in this capability |
| D-7 (IX.4 model exports) | `ChatChannelModel`, `ChatChannelMemberModel`, `ChatMessageModel` are exported from the barrel (`index.ts:7-9`) and chat itself imports `ProductModel` and `UserModel` (section 3) | R1 for the reads (`getProductsByIds`, `assertMember`); plain ID columns for the rest; remove the barrel exports (G-32) |
| D-8 (X.4 barrels expose infra) | `index.ts:13` exports `ChatOfflineScheduler` | `ChatProjectorModule` (G-32) |
| D-12 (IX.4 raw SQL on foreign tables) | `infra/chat-offline.ts:88` selects from `"User"`; tenancy's job writes `"ChatChannel"` (S03 A22, paid there and in G-31) | R1 not needed (the label is dropped, G-28); the shop backfill moves into chat (G-31) |

D-1…D-5, D-9, D-10, D-13 are resolved and D-11, D-14…D-17 do not touch chat.

## 3. `check:table-ownership` lines for `chat` (read from the code; run the command to confirm)

| Where | Kind | What | IX.7 mechanism that replaces it |
|---|---|---|---|
| `infra/models/chat-channel.model.ts:14,73-78` | MODEL (association) | `ProductModel` import, `@ForeignKey(() => Product)`, `@BelongsTo(Product)` | none: `productId` is a plain ID with no association; product data read through **R1** `ProductQueryService.getProductsByIds` at creation (G-01) |
| `infra/models/chat-channel.model.ts:15,85-90` | MODEL (association) | `UserModel` import, `@ForeignKey(() => User)` on `sellerId`, `@BelongsTo(User)` | plain UUID column; no read of users (spec drops the display name) |
| `infra/models/chat-channel-member.model.ts:14,99-104` | MODEL (association) | `UserModel` on `userId` | plain UUID column |
| `infra/models/chat-message.model.ts:14,91-96` | MODEL (association) | `UserModel` on `authorId` | plain UUID column |
| `application/chat.service.ts:10,55`, `chat.module.ts:5,16` | MODEL/service (catalog's `ProductDtoService`, `ProductDtoModule`) | channel creation reads `Product` through catalog's DTO service of ORM models | **R1** `ProductQueryService.getProductsByIds` |
| `infra/chat-offline.ts:88` | SQL | `JOIN "User" u ON u.id = :authorId` for the sender label | dropped: the escalation event carries no author name; if a name returns later it is **R2** composition |
| `migrations/20261001260000-chat-sequences.js:48-55` | SQL (trigger writes the outbox table) | `INSERT INTO "Outbox"` from a chat trigger function | `outbox.append` is not callable by the gateway; use CDC on `ChatMessage` (IV.4), or a dated exception (IX.6 allows only the lib's service inside the domain's own transaction) |
| `libs/domains/tenancy/infra/tenancy-backfill.jobs.ts:56` (tenancy's line, listed for hand-off) | SQL | writes `"ChatChannel"` | chat-owned backfill with **R1** `ensureShopsForLegacySellers` (G-31) |
| FK `ChatChannel.shopId → Shop` (tenancy's expand migration `20261001140000-shops-tenancy-expand.js:73-74`) | FK | cross-owner foreign key | dropped by chat's expand/contract migration (S03 A16); `shopId` becomes a plain ID |

## 4. Implementation order

1. Run `pnpm --dir packages/backend check:table-ownership` and reconcile section 3. Add the zod schemas to `packages/contracts` (G-33).
2. Migrations (expand → backfill → contract, each with `lock_timeout`): `shopId` column and plain-ID drop of foreign keys (G-31), author-scoped idempotency key and `seq NOT NULL` (G-09, G-15), author read-position in the sequence function and `activeMemberCount` (G-17, G-23), `deletedBy`, monthly partitioning with dedupe guard (G-16), event emission change (G-18).
3. Domain layer: `message-body`, `read-position`, `moderation-rules`, `escalation-decision`, `history-cursor`, `partition-months`, clock port, repository ports (G-37, G-36).
4. Application and API: channels and membership (G-01…G-04), moderation (G-05, G-06, G-12), send/sync/history/unread/read/presence (G-07, G-09…G-14, G-19…G-25), ticket (G-08), rate limits.
5. Consumers and jobs: offline scheduler and check worker (G-27…G-29), shop purge (G-30), partition job (G-16), metrics (G-34).
6. Barrel and modules (G-32); tests per `test-plan.md`; update `chat.e2e-spec.ts` and `chat-sync.e2e-spec.ts`; notify S03 that its backfill job can be deleted (G-31), S28 of the new event, W05 of the client rules (G-35).
7. Gates: `tsc`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`, all chat e2e green, recorded (VII.9). Correct the P0318 status in `docs/architecture/pattern-map.md` once AS-28 and AS-29 pass.
