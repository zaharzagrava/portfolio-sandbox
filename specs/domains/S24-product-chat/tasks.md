# Tasks: S24 — Product Chat (domain `chat`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `data-model.md`, `research.md`, `contracts/{http,events,services}.md`, `quickstart.md`, constitution v3.1.0.

**Tests**: required (test-plan.md, 58 scenarios). Inside every story the test tasks come first and must be seen to **fail** before the code tasks; no "A or B" assertions (L-003); tests create their own data (L-005, L-006); frozen clock, no sleeps (L-007).

**Paths**: `D` = `packages/backend/libs/domains/chat`, `C` = `packages/contracts/src/chat`, `M` = `packages/backend/migrations`. Backend commands run from `packages/backend`. E2E through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; run the narrowest test, the whole suite once in T094. After 5 failed fixes of one test: write the blocker into `questions.md` and stop.

**Rules in force**: living spec first (T001); never touch `*.reviewed.json`; no git checkout/restore/reset/stash/clean; `TransactionRunner.run` only, no new `sequelize.transaction`; sibling specs not edited (follow-ups live in gaps.md); scenarios, not files, must not disappear (L-017).

## Phase 1: Setup

- [X] T001 Create living spec page `docs/spec/capabilities/S24-product-chat.md` (Purpose, Entry points, rules each with `[proof: S24 AS-nn]` and `[code: …]`, scope globs `packages/backend/libs/domains/chat/**` and `packages/contracts/src/chat/**`); run `python3 scripts/livespec/check.py`; add "## Spec changes" note to gaps.md only if a signed page changed (none expected) (WP-0)
- [X] T002 Run `pnpm --dir packages/backend check:table-ownership` and `--strict`; reconcile the `chat` lines with gaps.md §3 and record the real counts in gaps.md §3 (command was not run at spec time)
- [X] T003 [P] Verify `chat-offline-notify` and its DLQ exist in `packages/backend/elasticmq.conf` and that the test stack creates every new table/partition via the real migrations (L-002, L-011); note result in quickstart.md
- [X] T004 [P] Read `libs/infrastructure/realtime` publisher / `TopicRegistry` and decide in `research.md` (R-08 addendum) whether `RealtimePublisher` can address `chat:channel:*` or chat keeps a chat-owned `LiveBusPort` (plan risk 6); `redis-pubsub` is deleted either way

## Phase 2: Foundational (blocks all stories)

### Contracts, config, policies (WP-2: G-14, G-33, G-34)
- [X] T005 [P] Write the failing test `D/chat-contracts.spec.ts` (imports from `packages/contracts`): every sample body of contracts/http.md parses with the nine schemas; error-code enum complete (quickstart step 16)
- [X] T006 [P] Create zod schemas in `C/channel.ts` (`chatChannelSchema`, create/update requests: title 1–120), `C/message.ts` (`sendMessageRequestSchema` body trimmed 1–4000 code points, `clientMessageId` UUID; `sendMessageResponseSchema`; `chatMessagePageSchema`), `C/sync.ts` (`chatSyncRequestSchema` ≤ 50 cursors, each UUID key and integer `0…2^53−1`; `chatChannelSyncSchema`), `C/unread.ts` (`chatUnreadPageSchema`, `markReadRequestSchema`, `markReadResponseSchema`), `C/presence.ts` (`presenceResponseSchema`, ≤ 100 UUIDs), `C/ticket.ts` (`chatWsTicketSchema`), `C/events.ts`, `C/index.ts` (error codes: `validation_failed`, `too_many_channels`, `channel_not_found`, `member_not_found`, `message_not_found`, `product_not_found`, `forbidden`, `banned`, `muted`, `channel_archived`, `invalid_transition`, `channel_exists`, `idempotency_conflict`, `presence_unavailable`)
- [X] T007 Replace the loose chat unread schema in `packages/contracts/src/bff/upstream.ts` by a re-export of `chatUnreadPageSchema` under the **same exported name** (S48/S30 follow-up); shape `{items, nextCursor}`
- [X] T008 [P] Create `D/rate-limit-policies.ts` with `definePolicies` for `chat.send.user`, `chat.sync.user`, `chat.read.user`, `chat.heartbeat.user`, `chat.presence.user`, `chat.ws-ticket.user`, `chat.join.user` (fail open + counter) and export as `chatRatePolicies`
- [X] T009 [P] Create `D/chat-metrics.ts`: six `chat_*` counters of FR-052 (incl. `chat_push_failed_total{kind}`) and `chat_limiter_unavailable_total` derived from `rate_limit_store_unavailable_total` by policy prefix `chat.` (S50 follow-up)
- [X] T010 [P] Create `D/domain/config.ts` with validated defaults (coalescing 30 s, recent window, huge-channel threshold, presence TTL) and `D/domain/errors.ts` (domain errors mapped to the codes above)
- [X] T011 Move enums to `D/domain/chat.constants.ts` (roles `OWNER|MODERATOR|MEMBER`, status `ACTIVE|BANNED`) so `api/` no longer imports a model enum (G-37)

### Pure domain: unit tests first (WP-3: G-10, G-23, G-36, G-37)
- [X] T012 [P] Failing table-driven `D/domain/message-body.spec.ts` (`it.each`: trim, code-point length 1–4000, whitespace-only rejected) — AS-16
- [X] T013 [P] Failing `D/domain/read-position.spec.ts` (clamp table; `fast-check`: monotonic, capped by `lastSeq`, order-insensitive) — AS-32
- [X] T014 [P] Failing `D/domain/moderation-rules.spec.ts` (status transition table, strictly-higher rank matrix, role transitions; OWNER never changed) — AS-49, AS-50, AS-52
- [X] T015 [P] Failing `D/domain/escalation-decision.spec.ts` (full outcome table: archived, banned, deleted, read, online, coalesced, send) — AS-43
- [X] T016 [P] Failing `D/domain/history-cursor.spec.ts` (opaque base64url `{seq}` round trip; tamper/malformed table; sync window arithmetic) — AS-22, AS-27
- [X] T017 [P] Failing `D/domain/partition-months.spec.ts` (UTC month list from oldest month to current+3, edges) — AS-29
- [X] T018 [P] Implement `D/domain/message-body.ts`, `read-position.ts`, `moderation-rules.ts`, `escalation-decision.ts`, `history-cursor.ts`, `partition-months.ts` until T012–T017 pass
- [X] T019 Create `D/domain/ports.ts`: `ChannelRepository`, `MembershipRepository`, `MessageRepository`, `ReadStateRepository`, `PresenceStore`, `LiveBusPort`, `CoalescingSlot`, `EscalationFactsPort`, `ProductLookup`, `ShopAuthority`, `PresenceReader`, clock port (use `CLOCK`; no `new Date()`/`Date.now()` in `application/`, G-36)

### Migrations and models (WP-1: G-15…G-18, G-31, G-37, D-7)
- [X] T020 Failing check first: add to `D/chat-lifecycle.e2e-spec.ts` skeleton the migration assertions (up on empty DB; up on legacy-populated DB; partitions `ChatMessage_YYYY_MM` + `ChatMessage_default` exist; `ChatMessageIndex` exists; `seq NOT NULL`; no FK to `Shop`/`User`/`Product`/self) — AS-28, AS-58
- [X] T021 Create `M/<ts>-chat-s24-expand.js` (timestamp > `20261014130100`; `SET lock_timeout='3s'`): `ChatChannel.activeMemberCount INT NOT NULL DEFAULT 0`, `deleteEpoch BIGINT NOT NULL DEFAULT 0`, `ChatMessage.deletedBy UUID NULL`; `ChatMessageIndex` (PK `(channelId, seq)`, `messageId`, `createdAt`, `authorId`, `clientMessageId NULL`, `bodyHash bytea NOT NULL`, unique partial `(channelId, authorId, clientMessageId) WHERE clientMessageId IS NOT NULL`); `ChatMessage_new` partitioned by range on `createdAt` with PK `(id, createdAt)` + monthly partitions + default; per-partition unique `(channelId, seq)` and `(channelId, createdAt DESC)`; `ChatChannelMember_user_active_idx ("userId","channelId") WHERE status='ACTIVE'` built `CONCURRENTLY`; `lastReadSeq >= 0` check `NOT VALID` then validated; `chat_member_count` trigger
- [X] T022 Create batched backfill script (`packages/backend/scripts/…/chat-s24-backfill.ts`, repeatable, ≤ 500 rows per short transaction): copy messages into `ChatMessage_new`, build `ChatMessageIndex` rows, compute `activeMemberCount`
- [X] T023 Create `M/<ts>-chat-s24-contract.js`: guarded swap of `ChatMessage` (lock_timeout 3 s + retry, old kept as `ChatMessage_old`), replace `chat_message_assign_seq` function (same trigger name): (1) `UPDATE ChatChannel … RETURNING lastSeq INTO NEW.seq` raising if no row, (2) insert `ChatMessageIndex` (unique violation aborts and rolls (1) back), (3) author's `lastReadSeq = GREATEST(lastReadSeq, NEW.seq)` (G-17), (4) outbox `chat.message_posted` with deterministic `eventId` (R-03; documented exception until 2027-03-31); drop FKs to `Shop`, `User`, `Product`, self FK; `seq SET NOT NULL`; `shopId SET NOT NULL` (refuses while NULL remains); drop `editedAt`; `down` restores old function and renames back (throwaway DB only)
- [X] T024 [P] Rewrite models without cross-owner associations (plain UUID columns, new columns): `D/infra/models/chat-channel.model.ts` (remove `ProductModel`/`UserModel` imports, `@ForeignKey`, `@BelongsTo`; add `shopId`, `activeMemberCount`, `deleteEpoch`), `chat-channel-member.model.ts`, `chat-message.model.ts` (PK `(id, createdAt)`, `deletedBy`, no `editedAt`), new `chat-message-index.model.ts` (S01 follow-up: the three `User` associations gone)
- [X] T025 Register `ChatMessageIndex` with owner `chat` in `packages/backend/db/ownership.ts`; run `pnpm check:model-registry`
- [X] T026 [P] Create scheduled-later migration `M/<ts>-chat-s24-drop-old.js` (drops `ChatMessage_old`; not to run before 2026-12-15, mark `chat-s24-drop-old` in plan complexity row)

**Checkpoint**: migrations apply on an empty DB and a legacy-populated DB; T020 passes; `tsc` clean for the models.

## Phase 3: US1 — Open a chat for a product, buyers join (P1) — AS-01…AS-08

**Independent test**: `test-spec.sh libs/domains/chat/chat-channels.e2e-spec.ts` green.

- [X] T027 [US1] Failing `D/chat-channels.e2e-spec.ts` (describe "Product chat: channels, membership and access"; boots real modules; fixtures + `SessionIssuer`, no `UserModel`/`ProductModel`/`ShopModel` injection): AS-01 create (201, shop from product, `title` default), AS-02 (401, 403 non-member/no `products.write`, 404 unknown product), AS-04 (validation `title` 1–120, archived product), AS-06 join denials (banned 403 `banned`, archived 409 `channel_archived`, unknown 404), AS-07 (read by id: member 200, stranger 404, by-product discovery with `myRole: null`, bad UUID 400)
- [X] T028 [US1] In the same file add concurrency cases (`Promise.all`, ≥ 20 repeats, exactly one succeeds, invariant holds): AS-03 concurrent creates → one `201`, others `409 channel_exists` with a single row; AS-05 concurrent/idempotent join → one member row, role/status never overwritten, new member starts at current `lastSeq` (not whole history unread, G-03); AS-08 update title / archive / unarchive transitions with `409 invalid_transition` on repeat, publishes after conditional update
- [X] T029 [US1] Implement `D/infra/product-lookup.adapter.ts` (over `ProductQueryService.getProductsByIds([id])`) and `D/infra/shop-authority.adapter.ts` (over `ShopAccessService.assertMember(shopId,userId,'products.write')`/`getRole`; no caching) behind the ports (G-01, G-12)
- [X] T030 [P] [US1] Implement `D/infra/channel.repository.ts` (create-if-absent by unique `productId`, read by id with membership predicate, conditional archive `WHERE isArchived=:from`, title) and `D/infra/membership.repository.ts` (single conditional upsert join that never touches role/status of existing rows; banned/archived diagnosis is read-only and only picks the error code) — parameterised SQL, membership in every predicate (G-02, G-03)
- [X] T031 [US1] Implement `D/application/chat-channel.service.ts` (create via shop/membership rule instead of `product.sellerId` — W07 follow-up; join; read; update; archive; injected clock) and `D/application/chat-authority.ts`
- [X] T032 [US1] Implement `D/api/chat-channel.controller.ts` (zod pipes from `packages/contracts`, `Firewall()`, `ParseUUIDPipe` on every ID, `by-product` route declared before `:channelId`) and `D/api/chat.exception-filter.ts` (`ChatExceptionFilter` maps domain errors to problem+json; no try/catch in controllers)
- [X] T033 [US1] Replace `ChatDtoModule`/`ProductDtoModule` usage in `D/chat.module.ts` (drop import of catalog `ProductDtoModule`, import `ProductQueryService` and `ShopAccessService` modules) and wire services; delete `D/chat-dto.module.ts` and `D/infra/chat-dto.service.ts` once nothing imports them (S05 follow-up)
- [X] T034 [US1] Run `test-spec.sh libs/domains/chat/chat-channels.e2e-spec.ts` until green

## Phase 4: US2 — Send exactly once, in order (P1) — AS-09…AS-20

**Independent test**: `chat-messages.e2e-spec.ts` green.

- [X] T035 [US2] Failing `D/chat-messages.e2e-spec.ts` (describe "Product chat: idempotent send, per-channel sequence and events"): AS-09 next seq `201`; AS-10 identical replay `200` same message (20 sequential); AS-11 same key different content → `409`, no disclosure of the other message; AS-12 key scope per `(channel, author)` (other author / other channel get their own); AS-15 rejected reply target leaves no seq gap; AS-16 one case per validation class (empty, whitespace, > 4000 code points, bad `clientMessageId`, reply to missing/other-channel message); AS-17 matrix banned `403 banned`, muted `403 muted`+`mutedUntil`, archived `409 channel_archived`, non-member `404`
- [X] T036 [US2] Add concurrency + fault cases: AS-13 20× `Promise.all` identical sends → one row, one seq, replays `200`; AS-14 concurrent distinct sends plus gateway-style inserts using the Rust gateway's three literal SQL statements → seqs gap-free 1..N, 20 repeats; AS-18 rate limit `429` + `Retry-After` and limiter outage fails open with `chat_limiter_unavailable_total`; AS-19 live bus down → send still `201`, `chat_push_failed_total{kind="message"}`, retry returns the replay not `500`; AS-20 outbox `chat.message_posted` one per message, aggregate id = channel id, version = seq, deterministic `eventId`, order
- [X] T037 [P] [US2] Implement `D/infra/message.repository.ts`: one-statement `insertIfAllowed` (membership, banned, muted, archived, reply target validated in the statement), `findByKey`, replay compare through `bodyHash` of stored body + `replyToId`; read-only diagnosis on refusal only
- [X] T038 [US2] Implement `D/application/chat-message.service.ts` (send, replay `200` vs new `201`, `idempotency` conflict, publish after commit best-effort with counter) using `message-body`, clock port, `TransactionRunner.run` only where multi-statement
- [X] T039 [P] [US2] Implement live bus: `D/infra/live-bus.adapter.ts` (per T004: `RealtimePublisher.publish` or chat-owned raw publish) and `D/api/realtime-topics.ts` + `D/realtime-topics.module.ts` UUID-shape check on `channelId` (G-26, S51 follow-up; `read`/`presence` use `replay: false`)
- [X] T040 [US2] Implement `D/api/chat-message.controller.ts` (`POST /chat/channels/:channelId/messages`, `@RateLimit('chat.send.user')`, `201`/`200` via `HttpCode` switch) and `D/application/events/chat-events.ts` (`ChatMessagePosted` v1 via `defineEvent`, adopt S53 `dedupeId` contract)
- [X] T041 [US2] Run `test-spec.sh libs/domains/chat/chat-messages.e2e-spec.ts` until green

## Phase 5: US3 — Sync on reconnect (P1) — AS-21…AS-29

**Independent test**: `chat-sync.e2e-spec.ts` green (rewritten: HTTP only).

- [X] T042 [US3] Rewrite `D/chat-sync.e2e-spec.ts` as HTTP tests (describe "Product chat: sync on reconnect, history and partitions"; carries the old scenarios: concurrent seq, replay, unread other-than-own, etc. → mapped in T093): AS-21 missed messages returned; AS-22 paging over large gap; AS-23 sync across channels with exactly 3 SQL statements (spy at DB edge) and `400 too_many_channels` at 51; AS-24 non-member/banned/unknown omitted; AS-25 invalid entries `400 validation_failed`, fractions rejected, cursor beyond head; AS-26 tombstones and a delete visible at once (no 30 s stale body); AS-27 history pages `{items,nextCursor}` bounds 1–100, tamper `400`, non-member `404`; AS-28 across partitions + month-boundary replay; AS-29 `chat.partition-maintenance` through its handler with the frozen clock, missing partition falls back to default partition, invalid payload rejected with `InvalidScheduleError`
- [X] T043 [US3] Implement `D/application/chat-sync.service.ts` (≤ 50 cursors: membership filter, index range for all channels, body fetch — 3 statements; parameterised arrays, G-21) and `D/api/chat-sync.controller.ts` (`POST /chat/sync`, `@RateLimit('chat.sync.user')`, zod `chatSyncRequestSchema`; no silent truncation or key dropping, G-19)
- [X] T044 [P] [US3] Implement history in `chat-message.service.ts`/`message.repository.ts`: keyset by `seq DESC` with `history-cursor`, membership predicate every page, tombstones included, `GET /chat/channels/:channelId/messages` with `chat.read.user` (G-07)
- [X] T045 [P] [US3] Implement `D/infra/recent-window.cache.ts` over `CacheService.getOrLoad` keyed by `(channel, lastSeq, deleteEpoch)`; delete increments `deleteEpoch` in its transaction (G-20, R-10)
- [X] T046 [US3] Implement `D/application/chat-partition.service.ts` + `D/infra/chat.jobs.ts` (`chat.partition-maintenance` via `@JobHandler`, `declareJobType` with payload contract next to the `JobPayloads` augmentation, `fleetConcurrency: 1`, idempotent create of months up to current+3)
- [X] T047 [US3] Run `test-spec.sh libs/domains/chat/chat-sync.e2e-spec.ts` until green

## Phase 6: US4 — Unread and read receipts (P2) — AS-30…AS-36

**Independent test**: `chat-read-state.e2e-spec.ts` green.

- [X] T048 [US4] Failing `D/chat-read-state.e2e-spec.ts` (describe "Product chat: unread counts and read receipts"): AS-30 unread computation excluding own and archived/banned, keyset page `(lastMessageAt DESC, channelId DESC)` limit 1–200 default 50; AS-31 posting advances own position (old expectation of 5 own-unread replaced); AS-32 mark read monotonic and capped by `lastSeq`; AS-33 validation (negative, fraction, > 2^53−1) and 404; AS-34 20× concurrent mark-read → highest wins, never decreases; AS-35 receipt event on advance only, topic access (non-member refused), hub outage does not fail the call; AS-36 huge-channel suppression of receipts
- [X] T049 [P] [US4] Implement `D/infra/read-state.repository.ts` (`LEAST(GREATEST(lastReadSeq,:seq), lastSeq)` conditional update; unread page query with membership predicate) and `D/application/chat-read-state.service.ts` (best-effort publish `read` with `replay: false`, counter on failure, suppression above `activeMemberCount` threshold, G-22, G-23)
- [X] T050 [US4] Implement `GET /chat/unread` and `POST /chat/channels/:channelId/read` controller in `D/api/chat-sync.controller.ts` or new `chat-read-state.controller.ts` with `chat.read.user`
- [X] T051 [US4] Run `test-spec.sh libs/domains/chat/chat-read-state.e2e-spec.ts` until green; re-run BFF e2e (`libs/composition/bff/bff.e2e-spec.ts`): `UPSTREAM_INVALID` absent for chat

## Phase 7: US5 — Presence (P2) — AS-37…AS-41

**Independent test**: `chat-presence.e2e-spec.ts` green.

- [X] T052 [US5] Failing `D/chat-presence.e2e-spec.ts` (describe "Product chat: presence"): AS-37 heartbeat/query/expiry (clock advance, no sleeps); AS-38 first-heartbeat online broadcast exactly once under 20× concurrent heartbeats; AS-39 co-membership privacy filter, `400` invalid IDs, > 100 `400`; AS-40 store outage: heartbeat `204`, query `503 presence_unavailable`, counter; AS-41 heartbeat rate limit
- [X] T053 [P] [US5] Implement `D/infra/presence.store.ts` (one multi-get, fail open with counter) and `D/application/chat-presence.service.ts` (co-membership via one query, publish to ≤ 20 channels in parallel with timeout, huge-channel guard, clock port) (G-24, G-25)
- [X] T054 [US5] Implement `D/api/chat-presence.controller.ts` (`POST /chat/presence/heartbeat` `204`, `GET /chat/presence?userIds=` csv ≤ 100 UUIDs, policies `chat.heartbeat.user`/`chat.presence.user`)
- [X] T055 [US5] Run `test-spec.sh libs/domains/chat/chat-presence.e2e-spec.ts` until green

## Phase 8: US6 — Offline push, once (P2) — AS-42…AS-48

**Independent test**: `chat-offline-push.e2e-spec.ts` green.

- [X] T056 [US6] Failing `D/chat-offline-push.e2e-spec.ts` (describe "Product chat: offline push scheduling, checks and escalation"): AS-42 scheduling ≤ 50 recipients, banned excluded, `dedupeId = <eventId>:<recipientId>`; AS-43 one wired case per outcome; AS-44 coalescing window with frozen clock; AS-45 presence and coalescing stores both down → documented fail-open behavior; AS-46 duplicate delivery (one escalation), out-of-order, invalid payload dead-lettered (VII.4); AS-47 `OutboxService.append` refusing → retries, slot confirmed only after a successful append, crash window ≤ 30 s; AS-48 `chat.message_escalated` v1 payload with `dedupeKey = chat:<recipientId>:<channelId>:<messageId>`, no author name or e-mail fragment, no body in logs (S28 follow-up: spy on the notification consumer)
- [X] T057 [P] [US6] Implement `D/infra/chat-offline.scheduler.ts` (consumer of `chat.events`, zod-validated, inbox/DLQ per S53, `TaskQueue.enqueueBatch` with `dedupeId`); validate queue options where the message is created (L-001, no FIFO-only options on a standard queue)
- [X] T058 [P] [US6] Implement `D/infra/coalescing-slot.ts` (token slot, `pending` then confirmed) and `D/infra/escalation-facts.adapter.ts` (archived, banned, deleted, read position; no `"User"` join — S01 follow-up)
- [X] T059 [US6] Implement `D/application/chat-offline-check.service.ts` + `D/infra/chat-offline.worker.ts`: pure `escalation-decision`, `ChatMessageEscalated` v1 appended with `OutboxService.append` inside `TransactionRunner.run`, retries + DLQ; delete `D/infra/chat-offline.ts`
- [X] T060 [US6] Trim `D/chat-offline-worker.module.ts`: remove `NotificationsCoreModule` import and the second `ChatSyncService` provider; use `PresenceReader` port; keep `EventsModule.forAggregates` registration of `chat` (S28 follow-up)
- [X] T061 [US6] Run `test-spec.sh libs/domains/chat/chat-offline-push.e2e-spec.ts`; then `test-spec.sh libs/domains/notifications/` (consumer unchanged)

## Phase 9: US7 — Moderation, deletion, tickets (P3) — AS-49…AS-55

**Independent test**: `chat-moderation.e2e-spec.ts` green.

- [X] T062 [US7] Failing `D/chat-moderation.e2e-spec.ts` (describe "Product chat: moderation, message deletion and gateway tickets"): AS-49 ban/unban transitions `204`, repeat `409 invalid_transition`; AS-50 strictly-higher rank, self-target, non-member target `404 member_not_found` (no row created); AS-51 mute/unmute with frozen clock, unmute of unmuted `409`; AS-52 promote/demote; AS-53 delete message: 20× concurrent, one change, repeat `204` emitting nothing, owner's message not deletable by a moderator; AS-54 manager authority follows shop membership live (remove from shop → next action `403`, no cache); AS-55 gateway ticket (claims `sub`, `typ:"ws"`, 60 s from injected clock, `201`, rate limited)
- [X] T063 [US7] Implement `D/application/chat-moderation.service.ts` (uses `moderation-rules`, `ChatAuthority`, conditional updates asserting one row, `deleteEpoch` bump, `deletedBy`) and `D/api/chat-moderation.controller.ts` (ban, unban, promote, demote, mute, unmute — the last two new — all `204`, `ParseUUIDPipe`) (G-05, G-06, G-12)
- [X] T064 [P] [US7] Implement `D/application/chat-ticket.service.ts` + route `POST /chat/ws-ticket` with `chat.ws-ticket.user` and injected clock (G-08); delete the old `D/application/chat.service.ts` and `chat-sync.service.ts` remnants
- [X] T065 [US7] Run `test-spec.sh libs/domains/chat/chat-moderation.e2e-spec.ts` until green

## Phase 10: US8 — Neighbours and life cycle (P3) — AS-56…AS-58

**Independent test**: `chat-lifecycle.e2e-spec.ts` green.

- [X] T066 [US8] Complete `D/chat-lifecycle.e2e-spec.ts` (describe "Product chat: shop lifecycle, backfill and domain isolation"; builds on T020): AS-56 `tenancy.shop_deleted` purge — bounded batches ≤ 500, idempotent, 20× concurrent/duplicate delivery, invalid payload to DLQ (VII.4); AS-57 shop-id backfill by migration plus `chat.backfill-shops` handler (≤ 200, via `ensureShopsForLegacySellers` + `getProductsByIds`, malformed payload rejected); AS-58 gateway's three literal statements still valid; no foreign table access
- [X] T067 [P] [US8] Implement `D/infra/chat-shop-purge.consumer.ts` (zod payload, batches, idempotent, DLQ, purge deletes `ChatMessageIndex` by `channelId`) (G-30)
- [X] T068 [P] [US8] Implement `D/application/chat-shop-backfill.service.ts` + handler `chat.backfill-shops` in `D/infra/chat.jobs.ts` with `declareJobType` (S49 follow-up); no tenancy file touches `ChatChannel` (G-31)
- [X] T069 [US8] Create `D/chat-projector.module.ts` (`ChatProjectorModule`: scheduler, purge consumer) and switch `packages/backend/apps/projector/src/projector.module.ts` from the `ChatOfflineScheduler` class import to the module (G-32, D-8)
- [X] T070 [US8] Run `test-spec.sh libs/domains/chat/chat-lifecycle.e2e-spec.ts` until green

## Phase 11: Polish, wiring, gates

- [X] T071 Trim `D/index.ts` to export only `ChatModule`, `ChatSyncModule`, `ChatTopicsModule`, `ChatOfflineWorkerModule`, `ChatProjectorModule`, `chatRatePolicies`, `ChatMessagePosted`, `ChatMessageEscalated` (no models/classes, D-7); fix every importer (apps, composition)
- [X] T072 Delete `packages/backend/libs/infrastructure/redis-pubsub/` and its last importers; `grep -rn redis-pubsub packages/backend` must be empty (S51 follow-ups)
- [X] T073 Remove the W07 mirror: `"sellerId" = createdBy` at `packages/backend/libs/domains/catalog/infra/product.repository.ts:110` and the `sellerId` backfill line in `packages/backend/scripts/seed/dev-seed.ts` (chat no longer reads `sellerId` from products); re-run `test-spec.sh libs/domains/catalog/` in batches (L-008)
- [X] T074 Delete old `D/chat.e2e-spec.ts` and the old `chat-sync` content only after the L-017 checklist (T093) is ticked
- [X] T075 Replace remaining `issueTokensFor` use and any `UserModel`/`ProductModel` injection in chat specs by `SessionIssuer`/fixtures (S01 follow-up); confirm none remain with grep
- [X] T076 Grep `sequelize.transaction` in `D/` is empty; `.tx.baseline` and `.ownership.baseline` not risen; no `// S54 T037 audit` comments (rule 4)
- [X] T077 Correct the P0318 status note in `docs/work/architecture/pattern-map.md` after AS-28/AS-29 pass
- [X] T078 Sibling-spec follow-ups: re-check gaps.md "## Sibling-spec follow-ups" (S01, S03, S05, S28, S48, S49, S50, S51, S53, W05) still true after the code lands; add any new bullet (e.g. S01 ratchet `KNOWN_FOREIGN_ROWS` chat rows now 0; S28/S14/S03 rows remain theirs) — do not edit their specs
- [X] T079 Record gaps G-35 (W05 client: one `clientMessageId` per user action, pages, `204`s) as a W05 follow-up bullet in gaps.md (out of scope here)

## Phase 12: Unverified criteria (rule 2)

- [X] T080 Confirm `quickstart.md` "Ops artifacts" lists SC-001 (1,000 runs), SC-003 (1,000 replays), SC-004 (k6 50k rps p99 < 100 ms), SC-009 (25k msg/s), SC-005/SC-006 wall-clock, app start, fresh-stack drill, large-table migration, drop of `ChatMessage_old`, each status `not run`; confirm the 6 rows exist in `specs/UNVERIFIED.md` (spec, criterion, how to run, `not run`); fix if not
- [X] T081 Create `packages/backend/scripts/load-tests/chat-sync.test.js` (k6, jittered reconnects, scenarios `send-storm`, `ingest`) and the `loadtest:chat-sync` script entry if absent; mark as ops artifact, never as verified

## Phase 13: Whole-capability proof (final checkpoint, L-019)

- [X] T082 L-017 checklist: tick each old scenario → new location: old `chat.e2e-spec.ts` ticket → AS-55, create → AS-01, non-seller 403 → AS-02, mute → AS-51, join/ban → AS-05/AS-49; old `chat-sync.e2e-spec.ts` → AS-09, AS-14, AS-21, AS-30/AS-31 (own messages not unread), AS-37; record in gaps.md
- [X] T083 `pnpm tsc --noEmit -p .` and ESLint for `packages/backend` and `packages/contracts` clean
- [X] T084 `pnpm check:boundaries`, `pnpm check:module-graph`, `pnpm check:model-registry`, `pnpm --dir packages/backend check:table-ownership --strict` (chat findings 0)
- [X] T085 `python3 scripts/livespec/check.py` passes with the S24 page
- [X] T086 Run the whole chat suite in batches of fresh processes (L-008): the eight e2e files + `chat-contracts.spec.ts` + six unit specs; a batch without summary line is a crash, rerun
- [X] T087 Regression: `test-spec.sh libs/composition/bff/bff.e2e-spec.ts`, `libs/domains/notifications/`, `libs/domains/catalog/` (batches), tenancy suite
- [X] T088 Start `apps/core`, `apps/worker`, `apps/projector`, `apps/sse-gateway` each alone (L-004, L-015, L-018): core maps chat routes and answers `404 channel_not_found` problem+json; worker registers the offline queue consumer; projector registers scheduler + purge; sse-gateway `ChatTopicsModule`. If the sandbox denies a start, leave the UNVERIFIED row `not run` (never "passed")
- [X] T089 Fresh-stack check with `scripts/qa/fresh-run.sh` (L-012) if the sandbox allows; else leave the row `not run` — NOT RUN: it builds a throwaway Docker stack and runs the whole browser suite (about 8 minutes); the row stays `not run` in `specs/UNVERIFIED.md`
- [X] T090 Update `specs/domains/S24-product-chat/gaps.md` with final status of every G-01…G-37 and D-6/D-7/D-8/D-12 row, then write `.implemented` only when T083–T088 are green

## Gap → task coverage

G-01 T029–T033 · G-02 T030, T032 · G-03 T028, T030 · G-04 T028, T030 · G-05 T062, T063 · G-06 T062, T063 · G-07 T044 · G-08 T064 · G-09 T035, T037 · G-10 T012, T018, T038 · G-11 T035, T037 · G-12 T029, T063 · G-13 T036, T038 · G-14 T008, T036 · G-15 T023 · G-16 T021–T023, T046 · G-17 T023, T048 · G-18 T023, T036 · G-19 T043 · G-20 T045 · G-21 T043 · G-22 T049 · G-23 T049 · G-24 T053 · G-25 T053 · G-26 T039 · G-27 T057 · G-28 T056–T059 · G-29 T060 · G-30 T067 · G-31 T068 · G-32 T069, T071 · G-33 T005–T007 · G-34 T009 · G-35 T079 · G-36 T019 + every service · G-37 T011, T019, T024, T030 · D-6 T019, T030 · D-7 T024, T071 · D-8 T069 · D-12 T058, T068.

## Dependencies and order

Phase 1 → Phase 2 (T005–T026; contracts/policies/domain/migrations can run in parallel within) → US1 (needs T019, T024, T029) → US2 (needs US1 channels) → US3 (needs US2) → US4, US5 (need US2; parallel with US3) → US6 (needs US2 events) → US7 (needs US1, US2) → US8 (needs migrations, US6 module) → Phases 11–13.

**Parallel**: T003/T004; T005/T006/T008/T009/T010; T012–T017; T024/T026; within stories the `[P]` repository/adapter tasks.

**MVP**: Phases 1–2 plus US1, US2, US3 (channels, exactly-once send, sync), then US4–US8.

## Phase 14: Convergence

- [X] T091 Add the missing row to `specs/UNVERIFIED.md` for the drop of `ChatMessage_old` (spec S24, criterion "drop of `ChatMessage_old` after one release without error", how to run: the `chat-s24-drop-old` scheduled migration on or after 2026-12-15, status `not run`); `quickstart.md` "Ops artifacts" lists it, but `UNVERIFIED.md` holds 5 S24 rows and T080 requires the drop to be covered per T080 (partial)
