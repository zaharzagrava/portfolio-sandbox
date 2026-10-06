# Gaps: S26 — Follow graph and home feed (domain `community`)

The implementation agent's to-do list: what today's code gets wrong or lacks against [`spec.md`](spec.md), the open debt rows that name `community` or S26, and the table-ownership findings with the IX.7 mechanism that replaces each. Paths are under `packages/backend/libs/domains/community/` unless stated. Line numbers are those of the draft at the time of writing.

## 1. Code versus spec

### Follow graph

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | No check that the account exists: any well-formed `shop:`/`user:` UUID can be followed (ghost accounts, spam counters). Self-follow is `400`, not `422 cannot_follow_self`; other errors are plain `BadRequestException`, not problem+json codes. Validation lives in the controller (II.1). | `api/feed.controller.ts:6,23-24,32` | FR-004, AS-04 |
| A2 | Follow writes two Scylla rows in parallel, then a Redis `SADD`; the counter moves only if Redis says "new". A crash between steps, a cold or flushed cache, or two concurrent requests leave the two tables and the count disagreeing. The Redis set is the only "do I already follow" check. | `application/feed.service.ts:49-61` | FR-002, FR-003, AS-03, AS-06 |
| A3 | Unfollow decrements the counter only when Redis held the relation; a cold cache leaves the relation removed and the count too high; no floor at 0. | `application/feed.service.ts:63-72` | FR-006, AS-05 |
| A4 | No following limit; `following()` loads up to 5,000 rows and caches them without an expiry; the cached set is trusted as the truth, so a stale or partial set hides follows. | `application/feed.service.ts:74-81` | FR-005, FR-007, AS-07 |
| A5 | `GET /me/following` returns an unpaged `string[]` in arbitrary order. | `api/feed.controller.ts:36-40`, `application/feed.service.ts:74` | FR-007, AS-11 |
| A6 | No follow-status or follower-count endpoint. | — | FR-008, AS-12 |
| A7 | No reconciliation of counts or of the two relation directions; no scheduled job. | — | FR-009, AS-51 |
| A8 | No rate limits on any of the four routes. | `api/feed.controller.ts:13-40` | FR-010, AS-09 |
| A9 | Follow does not touch the reader's timeline, so a follower of a normal shop sees nothing from it until the shop posts again (or until the reader goes inactive for a week). | `application/feed.service.ts:49-61` | FR-043, AS-36 |

### Items and events

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | Items are created by in-process `FeedPublisher.publish(...)` calls; `FeedModule` is `@Global` and exports the publisher so any domain can call it. S25's call never ran (optional, not provided) and swallows errors. | `feed.module.ts:9-17`, `application/feed-publisher.service.ts:34-51`, `application/discussion.service.ts:86` | FR-020, FR-052 |
| B2 | Publishing writes two rows, then sends to Kafka as a separate step: a failed send leaves a stored item that is never fanned out; there is no relay. | `application/feed-publisher.service.ts:35-50` | FR-026, AS-48 |
| B3 | "Once per product" is a Redis `NX` key with a 30-day expiry (lost on flush, re-publishes after 30 days); the projector handles every `products.events` message, including updates, archive and delete, and reads product rows. No `price_drop`, `drop_announced`, `auction_started` or `post` producers exist (kinds are declared, nothing creates them). | `infra/product-feed.projector.ts:19-35`, `application/feed-publisher.service.ts:14` | FR-020–FR-022, AS-14, AS-15 |
| B4 | Event payloads are not validated by a schema in the projector; no dead-letter test; no inbox or version guard; no handling of out-of-order, archive, restore or delete events. | `infra/product-feed.projector.ts:25-35` | FR-023–FR-027, AS-16, AS-17 |
| B5 | Item price is `Number(p.price)` (float) in the payload. | `infra/product-feed.projector.ts:33` | FR-049, AS-43 |
| B6 | `FeedItemPublished` is `{itemId, authorId, ms}`; no `kind`, no `createdAt`. | `application/feed-publisher.service.ts:8-12` | Provides: event, AS-13 |
| B7 | No retention on `feed_items` or `items_by_author`; the schema has no TTL. | `packages/backend/cql/020_feed.cql` | FR-028, AS-23 |
| B8 | No store of product copies, post tombstones, event inbox, completed fan-outs or announcement state; the schema needs new tables (CQL migrations, expand-only). | `packages/backend/cql/020_feed.cql` | FR-023, FR-024, FR-026 |

### Fan-out

| # | Gap | Where | Spec |
|---|---|---|---|
| C1 | Celebrity status is a Redis set fed by a Redis counter; a Redis loss demotes every celebrity and resumes pushing to millions of followers. | `application/feed.service.ts:57-59,61`, `infra/fanout.consumer.ts:41` | FR-032, AS-28, AS-29 |
| C2 | Celebrity recents (ZSET) and every other Redis key have no expiry except `active:`; recents are lost with Redis and never rebuilt. | `application/feed.service.ts:15-20`, `infra/fanout.consumer.ts:41` | FR-039, AS-28, AS-49 |
| C3 | `LPUSH` appends in arrival order, so out-of-order or redelivered events leave the list unsorted; the merge assumes sorted input. A redelivered event pushes duplicates; there is no completed-event marker. | `infra/fanout.consumer.ts:57`, `domain/merge.ts` | FR-034, FR-038, AS-18, AS-22, AS-46 |
| C4 | No backpressure: the consumer never pauses on a saturated store (the comment promises a runner pause that does not exist for this consumer); a Redis error mid-way leaves a partial fan-out with no recovery rule. | `infra/fanout.consumer.ts:31-36,45-62` | FR-037, FR-038, AS-45, AS-46 |
| C5 | Fan-out is not tested through the bus (the e2e calls `fanOut` directly and mocks the producer); no duplicate or invalid-payload test (VII.4). | `feed.e2e-spec.ts:33,45-48` | AS-22, AS-47 |
| C6 | No structured `feed.fanout.completed` line or metrics; only a warning above 50,000 timelines. | `infra/fanout.consumer.ts:64` | FR-050, AS-50 |

### Reading, rebuild and hydration

| # | Gap | Where | Spec |
|---|---|---|---|
| D1 | Cursor is a bare millisecond (`before`), items with equal ms are skipped or repeated; no `limit` parameter (fixed 30); `Number(before)` is not validated (NaN); response `nextBefore`. | `api/feed.controller.ts:15-17`, `application/feed.service.ts:83-99` | FR-040, AS-19, AS-20 |
| D2 | Merge compares `ms` only; ties are arbitrary. | `domain/merge.ts` (heap comparisons) | FR-033, AS-18, AS-26, AS-31 |
| D3 | Non-celebrity history ends at the 800-entry list; no continuation by pull. | `application/feed.service.ts:91-97` | FR-041, AS-19 |
| D4 | Active marker is set before the rebuild and never undone; rebuild does `DEL` then `RPUSH`, dropping pushes that arrived in between; a rebuild failure leaves an "active" user with an empty list; a missing list for a marked-active user is never rebuilt; no time bound or concurrency measurement beyond a pool of 16; concurrent first reads rebuild in parallel. | `application/feed.service.ts:84-85,102-121` | FR-042, AS-33–AS-35, AS-37 |
| D5 | Hydration queries one row per item (concurrency 32), filters only "author still followed", ignores deleted posts, archived or sandbox products, suspended shops; no page fill; empty pages with a `nextBefore` possible. | `application/feed.service.ts:123-136` | FR-044–FR-047, AS-38–AS-41 |
| D6 | No degraded mode: Redis failure → 500; one celebrity read failure fails the page; no per-call timeouts; no fallback to pull. | `application/feed.service.ts:83-99` | FR-044, FR-048, AS-30, AS-42 |
| D7 | Item and page types are loose (`kind: string`, `payload: Record<string, unknown>`); no `author.name`; no contract schemas in `packages/contracts`. | `application/feed.service.ts:27-34` | FR-049, AS-43 |

### Tests, boundaries and wiring

| # | Gap | Where | Spec |
|---|---|---|---|
| E1 | The e2e spec calls services, not HTTP; seeds `CELEBRITIES` by writing Redis; no 401/IDOR/validation/limit/concurrency/idempotency cases; the only unit spec covers the merge happy path. Replace with the six e2e files and four unit specs of `test-plan.md`. | `feed.e2e-spec.ts:1-96`, `domain/merge.spec.ts` | VII.2–VII.5, VII.8 |
| E2 | `application/` imports `infra/` classes directly (`CassandraService`, `RedisService`) instead of domain ports (I.2); the key-building helpers and `FeedItemPublished` live in `application/` and are imported by `infra/` (reverse direction). | `application/feed.service.ts:2-4`, `infra/fanout.consumer.ts:7-8` | I.2 (debt D-6) |
| E3 | The barrel exports `FeedFanoutConsumer` and `ProductFeedProjector` so `apps/projector` wires them; the feed publisher module is imported by the projector app for a publisher that must go away. | `index.ts:11-12`, `apps/projector/src/projector.module.ts:15,52,63` | X.4 (debt D-8) |
| E4 | `FeedModule` is `@Global` and exports `FeedService`/`FeedPublisher` to every module. | `feed.module.ts:9-17` | IV.1, FR-052 |
| E5 | No scheduled jobs (reconciliation, announcement relay) and no worker module for them. | — | FR-009, FR-026 |

## 2. Open debt rows that name `community` or S26

Source: `docs/architecture/debt-register.md`. Rows D-6, D-7, D-8 and D-12 name this domain; D-15 and D-17 do not.

| Debt | What in this capability | Where | Replaced by |
|---|---|---|---|
| D-6 (I.2 layering) | `application/` imports `infra/` classes (E2). | `application/feed.service.ts`, `application/feed-publisher.service.ts` | Repository ports and tokens in `domain/` (follow graph, feed items, timelines, product copy, celebrity state, event inbox) with adapters in `infra/`; S26 pays its share together with S25. |
| D-7 (IX.4 model exports) | `ProductModel` (catalog) imported and injected by the product projector. | `infra/product-feed.projector.ts:4,19` | **R3**: consume S05's snapshot events and keep the few fields in a store owned by `community` (FR-023). |
| D-8 (X.4 barrel exports internals) | `FeedFanoutConsumer` and `ProductFeedProjector` exported for `apps/projector`. | `index.ts:11-12` | `apps/projector` imports a feed worker/projector module of the domain; the barrel exports no consumer or projector. |
| D-12 (IX.4 raw SQL on another domain's table) | `productModel.findAll` on catalog's `Product` inside the projector. | `infra/product-feed.projector.ts:25` | **R3** (same as D-7). Shop names and status → **R1** `ShopQueryService.getShopsByIds`; follow validation of users → **R1** `UserDirectoryService.getUsersByIds`; posts at hydration → **R1** `DiscussionQueryService.getPostsByIds`. |

## 3. `pnpm --dir packages/backend check:table-ownership` — community lines

The command asks for approval in this unattended run and was **not executed**. The findings below come from reading the domain's sources (`grep` for `InjectModel`, `sequelize`, `.query(`, `literal(` and `@app/domains/` imports over `libs/domains/community/`, feed files only). The implementation agent must re-run the command and confirm; the expected result after S25 and S26 are done is zero community lines.

| Kind | Finding | Where | Owner of the fix | Mechanism |
|---|---|---|---|---|
| MODEL | `ProductModel` (catalog) imported | `infra/product-feed.projector.ts:4` | S26 | R3 (D-7) |
| MODEL | `@InjectModel(Product)` | `infra/product-feed.projector.ts:19` | S26 | R3 (D-7) |
| SQL | `productModel.findAll` on `Product` | `infra/product-feed.projector.ts:25` | S26 | R3 (D-12) |

No raw SQL, no other `@InjectModel` and no other domain's model appears in `feed.service.ts`, `feed-publisher.service.ts`, `fanout.consumer.ts` or the controller. `community` owns no PostgreSQL table (domain-map D5), so its ownership-registry entries stay empty; the new CQL tables are not covered by IX.3.

## 4. Cross-capability dependencies this capability waits on

| Needs | From | Notes |
|---|---|---|
| Snapshot events `catalog.product_*` with `productVersion`, `changedFields` | S05 | Until S05 ships them, the product projector has no input (S05 `gaps.md` lists community's projector). |
| `discussion.post_created`, `discussion.post_deleted`, `DiscussionQueryService.getPostsByIds` | S25 | S25's `gaps.md` A4 removes the in-process publisher call. |
| `auction.created`, `auction.opened` | S21 | Items `drop_announced` and `auction_started` start only when S21 publishes them. |
| `ShopQueryService.getShopsByIds` | S03 | Replaces any read of `Shop`. |
| `UserDirectoryService.getUsersByIds` | S01 | Follow validation only. |
| Rate-limit profiles `follow.write`, `feed.read` | S50 | |
| Event envelope, consumer framework (pause/resume, dead-letter, retry), single-run jobs | S53, S49 | Must work without a SQL transaction (community has no PostgreSQL table). |
| A web owner for the home-feed page and follow button | W-capability to be assigned | Until then only J05 covers the UI. |
