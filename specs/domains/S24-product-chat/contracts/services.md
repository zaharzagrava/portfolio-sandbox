# Contract: S24 internal services, ports and what chat consumes

## Barrel `@app/domains/chat` (after the change)

Exports: `ChatModule`, `ChatSyncModule`, `ChatTopicsModule`, `ChatOfflineWorkerModule`, `ChatProjectorModule`, `chatRatePolicies`, `ChatMessagePosted`, `ChatMessageEscalated`. Nothing else: no model, repository, service class or key helper (FR-045; `check:boundaries`, AS-58). Callers that switch: `apps/projector` (`ChatOfflineScheduler` → `ChatProjectorModule`), `apps/core`, `apps/sse-gateway`, `apps/worker` unchanged; `test/utils/global-modules.ts` side-effect import unchanged.

## Consumed (R1 services, in-process, outside transactions)

| Service | Call | Used for |
|---|---|---|
| S05 `ProductQueryService` | `getProductsByIds([productId])` → `{id, shopId, title, status}` | channel creation; backfill of `shopId` |
| S03 `ShopAccessService` | `assertMember(shopId, userId, 'products.write')`; `getRole(shopId, userId)` | manager authority (every action, uncached); target rank |
| S03 `ShopProvisioningService` | `ensureShopsForLegacySellers(sellerIds ≤ 200)` | `chat.backfill-shops` |
| S50 | `definePolicies`, `@RateLimit` | seven policies |
| S51 | `TopicRegistry.define`, `RealtimePublisher.publish(topic, event, payload, {replay:false})` | `chat:<id>` |
| S52 | `CacheService.getOrLoad` | recent-messages window |
| S53 | `OutboxService.append`, `TaskQueue.enqueueBatch/consume`, `Projector`, consumer inbox/DLQ | escalation, scheduler, purge |
| S49 | `declareJobType`, `@JobHandler`, schedule registration | two jobs |
| S54 | `TransactionRunner.run`, `CLOCK`, metrics registry, problem+json filter | everywhere |
| S01 | `Firewall()`, `@User()`; test kit `SessionIssuer` (replaces `issueTokensFor`) | auth, specs |

Not consumed: `UserDirectoryService` (no user display, `questions.md` CONTRACT), `ProductDtoService`, `NotificationRouter`, `NotificationsCoreModule`.

## Domain ports (`domain/ports.ts`, adapters in `infra/`)

`ChannelRepository` (create-if-absent by product, read by id with member predicate, conditional archive, title), `MembershipRepository` (conditional upsert join, status/role/mute conditional updates, active-member lookup, co-membership, unread page), `MessageRepository` (`insertIfAllowed`, `findByKey`, `listSince`, `listPage`, `softDelete`), `ReadStateRepository` (monotonic capped advance), `PresenceStore` (`heartbeat` → `{wasOnline}`, `multiGet`), `LiveBus` (gateway buses), `EscalationFacts` (message/membership/channel facts), `CoalescingSlot` (take/confirm/release with token), `ShopAuthority`, `ProductLookup`. Pure modules: `message-body`, `read-position`, `moderation-rules`, `escalation-decision`, `history-cursor`, `partition-months`.

## Application services (one per controller, thin controllers)

`ChatChannelService` (create/join/read/update/archive), `ChatModerationService` (ban…demote, delete), `ChatMessageService` (send, history, delete read side), `ChatSyncService` (sync), `ChatReadStateService` (unread, mark read), `ChatPresenceService`, `ChatTicketService`, `ChatOfflineCheckService`, `ChatPartitionService`, `ChatShopBackfillService`. `ChatExceptionFilter` maps domain errors to problem+json codes (no branching in controllers).
