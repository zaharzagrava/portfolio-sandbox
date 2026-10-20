# Research: J05 — Engagement loop

`gaps.md` was written by static reading before S25–S55 were built. This audit (code at HEAD `35b05728`) sorts its 23 rows into **closed**, **open** and **journey-only**. Paths under `packages/backend/libs/`. A row marked *verify* is believed closed by the evidence given; the first journey run confirms it, and the owner fixes it if not.

## 1. Audit of gaps.md

| Gap | State at HEAD | Evidence | Plan WP |
|---|---|---|---|
| G-01 checkout `ref` → frozen attribution | **OPEN**. Body has `refCode` (stored on the order row, never resolved); no `ref`, no `resolveAttributions` call, no `attribution` on `GET /orders/:id` | `orders/api/checkout.dto.ts:23`, `application/checkout.service.ts:321,423`, `infra/order.repository.ts:91` | WP2 |
| G-02 `order.paid` payload | **PARTIAL**. `paidAt` is present (`order-lifecycle.service.ts:293`); `attribution` is not; marketing has no `order.refunded` consumer | same file | WP2 |
| G-03 typed catalog events | **CLOSED** (`catalog/application/events/product-events.ts`, e2e in `catalog/product-events.e2e-spec.ts`) | | — |
| G-04/05/06 feed products, announce, fan-out | *verify*. S26 built: own product copy (`community/infra/scylla-product-copy.store.ts`), announcement store, `feed-projectors.ts` | `community/feed-items.e2e-spec.ts` | WP4 (journey proves) |
| G-07/08 discussion events, board validation | **CLOSED** (`discussion.post_created` recorded; `catalog-board-gate.adapter.ts`) | `community/discussions-*.e2e-spec.ts` | — |
| G-09 canonical group names | **OPEN**. `infrastructure/projections/consumer-groups.ts` has no J05 entry. Decision (as J03/J04): **aliases over the real groups, no rename** — a rename drops offsets. The `[BREAKING]` rename in questions.md is satisfied by name, not by group id | `consumer-groups.ts:1-8` | WP1 |
| G-10 trending consumer | *verify*. Group `discovery-trending-topk` exists (`discovery/application/trending-ingest.service.ts:29`), stream e2e + DLQ (`trending-stream.e2e-spec.ts`) | | WP4 |
| G-11 experiments `unit`, start/stop | **CLOSED** (`experiments-admin.controller.ts:105`, domain specs on `unit`) | | — |
| G-12 click stats dedupe by `clickId` | *verify* in `marketing/infra/clickhouse-click-stats.reader.ts` / `link-clicks.projector.ts`; AS-13 exact counts exposes it | | WP3 |
| G-13 cross-domain product reads | *verify*: no `ProductModel` left in `orders/api/orders.controller.ts` or `discovery/application` (grep empty); `check:boundaries` is the gate | | WP6 |
| G-14 conversion record | **OPEN**. Nothing in `marketing/` for conversions: no consumer, store, route, stats fields or `link.converted` events | grep over `marketing/` | WP3 |
| G-15 comment notice | **CLOSED** (`discussion.comment` in `notifications/domain/catalog*.ts`, `event-mapping.spec.ts`) | | — |
| G-16 follow API shapes | *verify* (S26 built) | | WP4 |
| G-17 rec trigger and thresholds | PARTIAL. Job `recommendations.build-bought-together` exists (`discovery/infra/co-occurrence.jobs.ts:15`); presence on the **control-surface allow-list** and the 3-buyer rule to verify | | WP1, WP4 |
| G-18 purchase vs analytics stream | Documented decision, nothing to do | | — |
| G-19 storefront emitters | Out of scope; the test plays the storefront (`storefrontDouble`) | | WP5 |
| G-20 barrels export projectors | *verify* by `check:boundaries`/`check:module-graph` | `community/index.ts`, `discovery/index.ts`, `experimentation/index.ts`, `marketing/index.ts` | WP6 |
| G-21 Idempotency-Key on creates | **CLOSED** for links (`IdempotencyHeaderGuard`, `share-links.controller.ts:80`); posts/comments covered by S25 e2e | | — |
| G-22 injected `Clock` | *verify*; trending, links, experiments tested with the stack clock in their own e2e. New conversion code uses `Clock` | `common/config/clock-config.ts`, `identity/clock-admin.e2e-spec.ts` | WP3 |
| G-23 consumer lag over HTTP | **CLOSED** (`projections/consumer-admin.service.ts`, `identity/api/topics-admin.controller.ts` tap) | | — |

Remaining real work: **G-01, G-02 (attribution), G-14 (conversion), G-09 (aliases), allow-list/tap check (G-17), and the journey + kit**. Everything else is proven by the journey.

## 2. Decisions

- **D1 — `ref` replaces `refCode` in the checkout body.** Decision: the accepted body field is `ref` (shape `^[A-Za-z0-9_-]{3,64}$`, questions.md LOCAL); `refCode` is removed from DTO and fingerprint (no external client). The existing order column `refCode` keeps the code of the **frozen** attribution only (null when not credited); a new nullable `attributionOwnerId` column is added (migration, orders-owned). Rationale: one column already exists; avoids a second source. Alternative: keep `refCode` as the field name — rejected: spec, test-plan and FR-005 fix `ref`.
- **D2 — Resolve once, via R1.** `CheckoutService` calls `LinkAttributionService.resolveAttributions([ref])` (exported by marketing, `link-attribution.service.ts:42`). Unknown / `DISABLED` / self-owned ⇒ `attribution: null`, no error. `EXPIRED` attributes. Failure of the lookup (marketing store down) also degrades to null — a reference must never cost a sale. Needs marketing to expose the status; verify what `resolveAttributions` returns and extend its return (marketing-owned) if it hides `DISABLED`/`EXPIRED`.
- **D3 — `order.paid` gains `attribution: {code, ownerId} | null`** read from the order row inside the paid transaction (no lookup). `orderVersion` stays. Event schema in `orders/application/events/order-events.ts`; contract test updated.
- **D4 — Conversion store.** Marketing owns a Postgres table `AffiliateConversion` (id = UUIDv5 of `orderId`, `linkCode`, `ownerId`, `orderId` (never exposed), `amountMinor`, `currency`, `status CONFIRMED|REVERSED`, `refundedMinor`, `orderVersion`, `paidAt`, `createdAt`, `updatedAt`) plus events via the outbox. Rationale: marketing's share-links data is DynamoDB-style (`dynamo-link.repository.ts`) but conversions need unique-key idempotency and a version guard; Postgres via outbox gives IV.4 for `link.converted`. Alternative: Dynamo conditional put — rejected: no transactional outbox. Table registered in the model registry and `check:table-ownership`.
- **D5 — Out-of-order refund.** A refund seen before its `order.paid` is stored as a pending row (`status PENDING_REFUND`, `refundedMinor` set, `orderVersion` of the refund) and merged when the paid event arrives; if the merged `refundedMinor >= amountMinor` the row goes straight to `REVERSED` without ever emitting `link.converted` as live credit (emits both events in order). Simpler alternative (drop early refund) rejected: loses AS-19 replay case.
- **D6 — Group aliases (WP1).** Add to `CANONICAL_CONSUMER_GROUPS`: `community-feed-products`, `community-feed-discussions`, `community-feed-fanout`, `marketing-link-clicks`, `marketing-affiliate-conversions` (a real group, new), `discovery-order-baskets`, `discovery-trending-topk`, `experimentation-purchases`. Real group ids are read from the projector declarations, not guessed.
- **D7 — Job allow-list and tap.** The J01–J04 control surface already has jobs and `topics/:topic/messages`; confirm `recommendations.build-bought-together` and topics `links.events`, `feed.events`, `discussion.events` are allowed, add if not (each refused in production). New topic `links.events` events `link.converted|link.conversion_reversed` → add to `scripts/init-kafka-topics.sh` if missing (L-002).
- **D8 — Journey owns the clock and pauses** (L-013, L-029): runs serially, `afterAll` restores clock and resumes groups.
- **D9 — Transactions.** `TransactionRunner.run` / `@Transactional` only; the checkout and conversion writes migrate any touched `// S54 T037 audit` site (none found by grep in the five domains).
- **D10 — AS-34 (UI)** stays pending (no web owner): specified only; listed in UNVERIFIED.md.

## 3. Best practices applied

- Idempotent consumer = unique key on `conversionId` plus version guard (IV.5); poison messages to `<group>.dlq` by the projector runner.
- Events relayed from the outbox, keyed by aggregate id (`orderId` for orders, link `code` for `links.events`).
- Privacy: events carry `conversionId`, never `orderId`/buyer; logs carry no idempotency keys (FR-034/035).
