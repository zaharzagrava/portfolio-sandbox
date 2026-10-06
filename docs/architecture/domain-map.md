# Target Domain Map

Maps every folder in `packages/backend/libs/common/src/` to its target location under constitution
v3.0.0, Principle X (monorepo structure) and Principle IX (logical database isolation). Use this
document to drive the monorepo refactor. It is architecture, not a feature spec.

- **Domain**: `libs/domains/<domain>`. Owns business logic, DTOs, models, and tables (X.2).
- **Infrastructure**: `libs/infrastructure/<lib>`. A domain-agnostic adapter to an external
  system (X.3, X.7).
- **Common**: `libs/common/<lib>`. Pure helpers and cross-cutting plumbing that talk to no
  external system (X.3, X.7).

Table ownership below is the seed for the ownership registry (`packages/backend/db/ownership.ts`,
IX.3). All tables stay in `public` with their current names (IX.2). Partition children (`*_default`,
`LedgerEntry_new*`) belong to their parent table's owner.

---

## 1. Folder → target destination

Every one of the 91 folders and 3 root files is listed once.

### 1.1 Domains

| Target domain | Source folders merged into it |
|---|---|
| `identity` | `auth`, `users`, `users-dto`, `admin`, `utils/user-utils` |
| `tenancy` | `tenancy` |
| `seller-onboarding` | `onboarding` |
| `catalog` | `product`, `product-dto`, `collab` |
| `catalog-sync` | `catalog-import` (import half), `integrations`, `offline-sync` |
| `media` | `media`, `video` |
| `orders` | `orders`, `bis-order`, `catalog-import/order-export*` (export half) |
| `fulfilment` | `pickup`, `delivery` |
| `payments` | `payment`, `payment-dto`, `ledger`, `finance`, `utils/bis-utils` (ledger account IDs; corrected in Phase 2 batch 3) |
| `statements` | `statements` |
| `billing` | `billing` |
| `launch-events` | `launch-events`, `live` |
| `auctions` | `auctions` |
| `chat` | `chat`, `chat-dto`, `chat-sync` |
| `community` | `discussions`, `feed` |
| `content` | `stories` |
| `notifications` | `notifications` |
| `discovery` | `search-admin`, `autocomplete`, `recommendations`, `trending` |
| `marketing` | `ads`, `share-links` |
| `experimentation` | `flags`, `analytics` |
| `seller-insights` | `leaderboards`, `seller-stats`, `crawler` |
| `developer-platform` | `public-api`, `webhooks`, `widget` |
| `shop-functions` | `shop-functions` |
| `asset-library` | `assets` |
| `assistant` | `assistant`, `knowledge` |
| `bff` *(composition, owns no tables; see §4 D1)* | `bff` (without `batch-read.controller`, which splits into the owning domains' `api/`) |

### 1.2 Infrastructure

| Target lib | Source |
|---|---|
| `database` | `database`, `utils/db-utils`, `models/migration.model.ts` |
| `context` | `context` (CLS request context + transaction runner over Sequelize) |
| `redis` | `redis` |
| `redis-pubsub` | `redis-pubsub` |
| `kafka` | `kafka` |
| `sqs` | `sqs` |
| `dynamo` | `dynamo` |
| `cassandra` | `cassandra` |
| `clickhouse` | `clickhouse` |
| `elasticsearch` | `elasticsearch` |
| `storage` | `storage` (S3 / in-memory object storage port) |
| `aws` | `aws-api` |
| `firebase` | `firebase` |
| `stripe` | `stripe` (thin SDK client only; payment logic stays in `payments/infra`) |
| `http-client` | `http-client`, `request` |
| `net` | `net` (SSRF guard, pinned fetch) |
| `outbox` | `outbox`, `outbox-dto`, `models/outbox.model.ts` |
| `events` | `events` (envelope, `defineEvent`, publisher) |
| `projections` | `projections` (runner, sinks, read-your-writes) |
| `jobs` | `jobs`, `cron` |
| `realtime` | `realtime` (the domain topic union moves out; see §4 D3) |
| `cache` | `cache` |
| `rate-limit` | `rate-limit` |
| `idempotency` | `idempotency` |
| `health` | `health` |
| `platform` | `platform` (HTTP bootstrap shared by apps; moved from common in Phase 3: it wires health and context) |
| `lifecycle` | `lifecycle` (graceful shutdown; moved from common in Phase 3: it drives readiness) |

### 1.3 Common

| Target lib | Source |
|---|---|
| `config` | `api-config`, `utils/config-utils` |
| `logging` | `logging` |
| `telemetry` | `telemetry` |
| `errors` | `error.types.ts`, `utils/error-utils` |
| `exceptions-filter` | `exceptions-filter` |
| `load-shedding` | `load-shedding` |
| `core` | `utils/core` (assertNever, brand, clock, backoff, promise-pool), `flags/murmur3.ts` (D-13, moved in batch 5) |
| `money` | `utils/money` |
| `scripts` | `utils/ts-node-utils` |
| `types` | `types.ts`: generic types only (Phase 3); `RequestWithUser` moved to identity |
| `request-context` | the request-context contract `AppClsStore` / `REQUEST_ID_HEADER` (Phase 3; the CLS machinery stays in infrastructure/context) |
| `testing` | `TestCleanupPort` + `TEST_CLEANUP` token (Phase 3, D-1): infrastructure registers test cleaners; the harness in `test/` implements it |

### 1.4 Removed or relocated outside `libs/`

| Source | Destination |
|---|---|
| `models/` | Split: each model moves to its owning domain's `infra/` (or to the infrastructure lib for technical tables), per §2. `all-models.ts` is deleted; each app registers the models of the domains it hosts. |
| `seeds/` | `packages/backend/test/seeds` (test-only, IX.6) |
| `utils/test-utils` | `packages/backend/test/utils` |
| `index.ts` | Deleted. It is replaced by one entry file per domain (X.4) and per lib. |

---

## 2. Domains

**Hosted by** lists the deployment units (`apps/*`) that load the domain (X.1). **Emits** lists
the outbox/Kafka events the domain owns. **Depends on** names the R1/R2/R3 path (IX.7) the domain
uses to get other domains' data.

### identity
- **Responsibility**: buyer, seller, and staff accounts: registration, password and OIDC login,
  MFA, sessions and refresh-token families, signing keys (JWKS), and platform-admin user
  operations.
- **Owns (Postgres)**: `User`, `FederatedIdentity`, `SigningKey`.
- **Other stores**: sessions and refresh families (DynamoDB / Redis).
- **Hosted by**: core, worker, sse-gateway.
- **Depends on**: none. Every other domain consumes identity's principal through the request
  context, not its tables.

### tenancy
- **Responsibility**: shops as tenants, memberships, roles and permissions, invitations, per-shop
  SSO, and the tenant directory (cell routing).
- **Owns**: `Shop`, `ShopMembership`, `ShopInvite`, `ShopDirectory`, `ShopSsoConfig`.
- **Hosted by**: core, worker, public-api, collab, sse-gateway.
- **Exports (R1)**: `assertMember(shopId, userId, permission)` and `getShopsByIds`. Every domain
  that currently reads `ShopMembership` or `Shop` directly switches to these (§3).
- **Depends on**: identity (R1, user existence).

### seller-onboarding
- **Responsibility**: the staged onboarding questionnaire, KYC document intake, LLM field
  extraction, and the human review queue. It emits shop verification.
- **Owns**: `ShopOnboarding`, `ShopDocument`, `DocumentExtraction`, `ReviewTask`.
- **Emits**: `shop.onboarding_submitted`, `shop.verified`.
- **Hosted by**: core, worker, lambdas.
- **Depends on**: tenancy (R1 for the shop name in the review queue, replacing the current
  `JOIN "Shop"`). Tenancy consumes `shop.verified` to flip the shop's status.

### catalog
- **Responsibility**: products, prices shown on listings, product revisions, and the
  collaborative listing-draft editor that publishes revisions.
- **Owns**: `Product`, `ListingDraft`, `ListingDraftVersion`, `ProductMedia` (links products to
  media IDs).
- **Other stores**: draft update log (DynamoDB) and snapshots (S3).
- **Emits**: product change events (`products` aggregate).
- **Hosted by**: core, worker, projector, collab.
- **Exports (R1)**: `getProductsByIds`, `applyStockDelta`, `upsertFromExternal`. These are the
  only write paths for catalog-sync and orders.
- **Depends on**: tenancy (R1), media (`media.ready`).

### catalog-sync
- **Responsibility**: bringing seller data in: bulk CSV/JSONL catalog import, Shopify and
  WooCommerce integrations, and offline-first inventory sync for pop-up and warehouse devices.
- **Owns**: `ImportJob`, `Integration`, `ExternalLink`, `SyncCursor`, `SyncQuarantine`,
  `ShopSyncState`, `SyncOperation`, `ShopChangeLog`, `ProductFieldClock`.
- **Hosted by**: core, worker, projector.
- **Depends on**: catalog (R1 write commands; it never writes `Product` directly), tenancy (R1).

### media
- **Responsibility**: image upload and processing (EXIF strip, variants), video upload,
  transcoding DAG, and HLS packaging. It is used by catalog, community, and reviews.
- **Owns**: `Media`, `Video`, `VideoTask`.
- **Emits**: `media.ready`.
- **Hosted by**: core, worker, lambdas.
- **Depends on**: none. Consumers reference media by ID.

### orders
- **Responsibility**: cart, checkout, stock reservation, flash-sale stock, the order state
  machine, multi-seller split into shop orders, and order export.
- **Owns**: `BisOrder`, `BisOrderItem`, `ShopOrder`, `OrderEvent`, `StockReservation`,
  `FlashSale`, `ExportJob` (moved from catalog-import).
- **Other stores**: carts (DynamoDB) and flash stock buckets (Redis).
- **Emits**: `order.reserved`, `order.paid`, `order.cancelled`.
- **Hosted by**: core, worker.
- **Exports (R1)**: `getOrdersForShop`, `getOrderLines`. These are used by developer-platform,
  auctions, and asset-library instead of their current joins.
- **Depends on**: catalog (R1 prices and stock), payments (SQS command for payment intent;
  consumes payment results), shop-functions (R1 discount evaluation), tenancy (R1).

### fulfilment
- **Responsibility**: pickup points and local stock, "available near me", same-day courier
  dispatch, and delivery tracking.
- **Owns**: `PickupPoint`, `PickupStock`, `Courier`, `Delivery`, `DeliveryEvent`.
- **Other stores**: courier positions (Redis GEO) and GPS track (DynamoDB).
- **Emits**: `pickup.stock_changed`, `courier.locations_reported`.
- **Hosted by**: core, worker, projector.
- **Depends on**: orders (consumes `order.paid` for dispatch), catalog (R1).

### payments
- **Responsibility**: payment intents, the PSP integration including unknown outcomes, the
  double-entry ledger, reconciliation, settlement, and seller payouts. Payment and ledger
  postings must share one transaction, so they are one domain (IX.7 row 7).
- **Owns**: `Payment`, `LedgerEntry` (+ partitions), `Payout`, `ReconciliationRun`,
  `ReconciliationIssue`.
- **Other stores**: balance read model (Redis / DynamoDB).
- **Emits**: `ledger.journal_posted`, payment responses.
- **Hosted by**: core, worker, projector, payment-processor.
- **Depends on**: orders (consumes reservation and paid events, never reads orders), tenancy (R1
  for payout destination; replaces the current `Shop` reads).

### statements
- **Responsibility**: bitemporal commission rates, monthly statements, period close, adjustments,
  and as-of reporting.
- **Owns**: `CommissionRate`, `StatementSnapshot`, `StatementAdjustment`, `AccountingPeriod`.
- **Hosted by**: core, worker.
- **Depends on**: payments and orders through **R3**: ledger and order facts are read from
  ClickHouse (CDC), never by joining `BisOrder` or `LedgerEntry`.

### billing
- **Responsibility**: plans, versioned prices, subscriptions (Marketplace Plus, shop plans),
  invoices, proration, dunning, usage metering, and entitlements.
- **Owns**: `Plan`, `Price`, `Subscription`, `Invoice`, `InvoiceLine`.
- **Other stores**: usage (ClickHouse) and entitlements cache (Redis).
- **Emits**: `billing.subscription_status_changed`, `billing.invoice_payment_failed`.
- **Hosted by**: core, worker, projector.
- **Exports (R1)**: `hasEntitlement(subjectId, feature)`.
- **Depends on**: developer-platform (consumes `usage.recorded`), payments (charge command).

### launch-events
- **Responsibility**: brand launch events: waiting room, admission tokens, seat holds, bookings,
  seat map, and the live launch stream (comments and reactions).
- **Owns**: `LaunchEvent`, `Booking`, `LiveStream`.
- **Other stores**: holds (DynamoDB), queue and seat bitmap (Redis), comments (DynamoDB).
- **Emits**: `live.comment_posted`, `live.comment_removed`.
- **Hosted by**: core, worker, projector, sse-gateway.
- **Depends on**: orders (booking voucher via command), tenancy (R1 for staff moderation; replaces
  `ShopMembership` reads).

### auctions
- **Responsibility**: limited-drop English auctions, proxy bidding, anti-sniping, exactly-once
  close, and second-chance offers.
- **Owns**: `Auction`, `Bid` (+ partitions).
- **Emits**: `auction.bid_placed`, `auction.leader_changed`, `auction.closed`.
- **Hosted by**: core, worker.
- **Depends on**: orders (the winner's checkout as a command; it doesn't read `BisOrder` or
  `ShopOrder`), billing (R1 entitlement), tenancy (R1 shill-bid guard).

### chat
- **Responsibility**: product chats: channels, members, messages, the per-channel sequence, sync
  on reconnect, unread counts, receipts, presence, and offline escalation.
- **Owns**: `ChatChannel`, `ChatChannelMember`, `ChatMessage`.
- **Emits**: `chat.message_posted`.
- **Hosted by**: core, worker, projector. The Rust gateway writes the same tables (out of scope,
  D1).
- **Depends on**: identity (R1 user display; replaces `User` reads), notifications (offline
  escalation via event). Tenancy must stop reading `ChatChannel` (§3).

### community
- **Responsibility**: product discussion boards (posts, nested comments, votes, ranking) and the
  follow graph with home feeds.
- **Owns (Postgres)**: none.
- **Other stores**: posts, comments, votes, follows, and timelines (ScyllaDB); rankings and
  timelines (Redis).
- **Emits**: `feed.item_published`.
- **Hosted by**: core, worker, projector.
- **Depends on**: catalog (R3 product-feed projector), media (`media.ready`).

### content
- **Responsibility**: brand stories CMS: versioned multi-locale stories, scheduled publish,
  preview, and edge cache invalidation.
- **Owns**: `Story`, `StoryDraft`, `StoryVersion`.
- **Emits**: `story.published`.
- **Hosted by**: core, worker, projector.
- **Depends on**: tenancy (R1; replaces `Shop` reads).

### notifications
- **Responsibility**: routing domain events to email, SMS, push, and in-app; preferences, quiet
  hours, frequency caps, suppression, and the inbox.
- **Owns**: `NotificationPreference`, `NotificationSettings`, `NotificationSuppression`,
  `PushDevice`.
- **Other stores**: inbox (ScyllaDB), unread and dedupe (Redis).
- **Hosted by**: core, worker, projector.
- **Depends on**: consumes events from every domain (R3 style). Recipient contact data comes from
  identity (R1; replaces `User` reads) and tenancy (R1; replaces `ShopMembership` reads).

### discovery
- **Responsibility**: everything a buyer uses to *find* products: search index sync and reindex,
  relevance, autocomplete, "bought together" recommendations, and trending.
- **Owns (Postgres)**: none. It is a pure **read-model domain** (IX.7 R3).
- **Other stores**: product index (Elasticsearch), top-K trie snapshot (S3), recommendations and
  trending (Redis), query logs (ClickHouse).
- **Emits**: `search.performed`, `search.result_clicked`.
- **Hosted by**: core, worker, projector.
- **Depends on**: catalog, orders, fulfilment, and marketing events through projectors in
  `apps/projector`. It never reads their tables.

### marketing
- **Responsibility**: sponsored listings (campaigns, signed click tokens, click billing) and
  share/affiliate short links with click attribution.
- **Owns**: `AdCampaign`, `AdBillingRun`.
- **Other stores**: links (DynamoDB), click aggregates (ClickHouse).
- **Emits**: `link.clicked`, ad click events.
- **Hosted by**: core, worker, projector.
- **Depends on**: payments (billing charges as a command), catalog (R1 product validation).

### experimentation
- **Responsibility**: feature flags and remote config (local-eval SDK, kill switches, audit),
  analytics event ingestion, and A/B experiments (assignment, exposure, SRM).
- **Owns**: `FeatureFlag`, `FlagAudit`, `Experiment`.
- **Other stores**: events (ClickHouse).
- **Hosted by**: core, worker, projector.
- **Depends on**: orders (consumes purchase events for conversion).

### seller-insights
- **Responsibility**: seller leaderboards, the live sales dashboard, seller stats, and competitor
  price monitoring (crawler).
- **Owns**: `LeaderboardSnapshot`, `CompetitorWatch`, `CrawlTarget`.
- **Other stores**: boards and counters (Redis), price history (ClickHouse).
- **Hosted by**: core, worker, projector.
- **Depends on**: orders events (R3 projector), tenancy (R1; replaces `Shop` and
  `ShopMembership` reads), catalog (R1 for "your price" comparison).

### developer-platform
- **Responsibility**: the seller public API (API keys, versions, sandbox, request logs), webhook
  delivery to shops' systems, and the embeddable storefront widget.
- **Owns**: `ApiKey`, `ShopApiSettings`, `WebhookEndpoint`, `WidgetSite`.
- **Other stores**: webhook attempts (DynamoDB), request logs (ClickHouse).
- **Emits**: `api.request_logged`, `usage.recorded`.
- **Hosted by**: core, worker, projector, public-api, lambdas.
- **Depends on**: orders (R1 `getOrdersForShop`, replacing the `ShopOrder ⋈ BisOrder` join),
  catalog (R1), tenancy (R1), and all domain events for webhook fan-out.

### shop-functions
- **Responsibility**: seller-written discount functions: submission, sandboxed test runs
  (judge), versioning, and fail-safe evaluation in checkout.
- **Owns**: `ShopFunction`, `ShopFunctionVersion`, `ShopFunctionTestCase`.
- **Hosted by**: core, worker.
- **Exports (R1)**: `evaluateDiscounts(cart)`, consumed by orders.
- **Depends on**: billing (R1 entitlement).

### asset-library
- **Responsibility**: the shop asset library (chunked dedupe, delta sync, share links) and
  digital product delivery after purchase.
- **Owns**: `Asset`, `AssetVersion`, `AssetChunk`, `AssetChange`, `AssetShareLink`,
  `AssetSyncState`, `DigitalProduct`.
- **Hosted by**: core, worker.
- **Depends on**: orders (consumes `order.paid` to grant download entitlement; replaces the
  `BisOrder` reads), catalog (R1).

### assistant
- **Responsibility**: the streamed LLM shopping assistant with read-only tools, and RAG ("ask this
  product" plus the shop help center).
- **Owns**: `KnowledgeDocument`, `KnowledgeChunk`.
- **Other stores**: conversations (ScyllaDB), stream buffer (Redis).
- **Emits**: `llm.call_completed`.
- **Hosted by**: core, worker, projector, sse-gateway, lambdas.
- **Depends on**: discovery, fulfilment, and catalog through R1 tool calls (read-only); billing
  (R1 quota).

### bff
- **Responsibility**: composition only. Product-page aggregation and mobile GraphQL with
  DataLoaders, built from parallel calls to the owning domains' HTTP APIs with per-section
  budgets and partial errors (R2). No business rules (VI.9).
- **Owns**: no tables and no DB credentials.
- **Hosted by**: bff.
- **Depends on**: catalog, tenancy, community, fulfilment, discovery, chat, and experimentation
  over HTTP.

---

## 3. Technical tables (infrastructure owners, IX.3 allowlist)

| Table | Owner |
|---|---|
| `Outbox` | `infrastructure:outbox` |
| `ProcessedWebhookEvent` | `infrastructure:inbox`. Either add an `inbox` lib or fold it into `idempotency`; the IX.3 allowlist names the "inbox / processed-events" role. |
| `Job` (+ partitions), `JobKey`, `JobSchedule` | `infrastructure:jobs` |
| `SequelizeMeta` / `Migration` | `infrastructure:database` |

## 4. Current cross-domain table access to remove

These folders reference tables owned by another target domain. Each row is an IX.4 violation the
refactor must remove. Detection was heuristic (string and model-import scan), so confirm each one
during the move.

| Table (owner) | Referenced by | Replacement |
|---|---|---|
| `Product` (catalog) | ads, assets, auctions, catalog-import, crawler, feed, integrations, knowledge, leaderboards, media, offline-sync, orders, payment, pickup, public-api, recommendations, search-admin, statements, tenancy, trending, webhooks, widget | Writes go through R1 catalog commands. Reads use R1 `getProductsByIds`, or an R3 read model for lists and search. |
| `BisOrder`, `BisOrderItem`, `ShopOrder` (orders) | assets, auctions, catalog-import, ledger, public-api, statements, webhooks | R1 `orders` exports. statements uses R3 via ClickHouse. asset-library and payments consume order events. |
| `Shop` (tenancy) | finance, leaderboards, onboarding, product, public-api, stories, widget | R1 `getShopsByIds` |
| `ShopMembership` (tenancy) | collab, crawler, live, notifications, webhooks | R1 `assertMember` |
| `User` (identity) | admin*, chat-sync, ledger, notifications, tenancy | R1 identity exports. *`admin` merges into identity, so it stops being a violation. |
| `Payment` (payments) | orders | Payment result event or R1 `getPaymentStatus` |
| `ChatChannel` (chat) | tenancy | Chat consumes tenancy membership events. Tenancy never touches chat. |
| `Outbox` (infra) | catalog-import, media | Only `outbox.append()` (IX.6) |

## 5. Decisions to confirm

- **D1 (bff placement).** BFF composition code can't live in `apps/bff` (X.1 bans logic in
  apps), and it owns no data. This map puts it in `libs/domains/bff` with zero registry
  entries. The cleaner alternative is a constitution amendment that adds a fifth area,
  `libs/composition/<client>`, for BFF-only code.
- **D2 (order export ownership).** Order export (`ExportJob`) moves from catalog-import to
  **orders**, because exporting orders means reading orders tables.
- **D3 (realtime topics).** `realtime/topics.ts` hard-codes domain topic names, which breaks X.3.
  The infrastructure lib keeps a generic `Topic` type and a policy registry, and each domain
  registers its own topic prefix and authorization policy at module init.
- **D4 (payments vs statements split).** Payment and ledger must commit in one transaction, so
  they form one domain. Statements is separate, because it only needs reporting-grade
  (CDC-delayed) ledger facts.
- **D5 (community has no Postgres tables).** Discussions and feed live entirely in
  ScyllaDB/Redis, so `community` has no registry entries. That's allowed, and IX applies only to
  Postgres.
