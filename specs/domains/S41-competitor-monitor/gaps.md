# Gaps: S41 — current `seller-insights` crawler code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/libs/domains/seller-insights/` unless stated; line numbers are those read on 2026-10-06. Leaderboard, dashboard and stats files belong to **S40** and are not listed. Questions behind each row are in [`questions.md`](questions.md); scenario IDs refer to [`spec.md`](spec.md).

Note on section C: `pnpm --dir packages/backend check:table-ownership` could not be executed in the unattended session that wrote this file (the command was not approved). The rows are derived by reading every import, `@InjectModel`, `forFeature` and SQL string of the crawler files; re-run the command first and reconcile.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Only `POST` exists; no list, no removal, no price-history route; the body is an inline `WatchDto` declared inside the module file; the response is an untyped `{targetId, url}`; always `201`; no contracts schema | `crawler.module.ts:20-37` | FR-001, FR-005–FR-007, FR-034, AS-01, AS-12–AS-14 |
| A2 | No idempotent replay: a repeated `POST` re-inserts silently (`ON CONFLICT DO NOTHING`) and returns the same shape, with no watch id | `application/crawler.service.ts:56-79` | FR-001, AS-02, AS-09 |
| A3 | No entitlement or per-product limit; nothing serialises count, check and insert | `application/crawler.service.ts:56-79` | FR-003, AS-08, AS-09 |
| A4 | Every registration pulls `nextCheckAt` forward (`LEAST(…, now())`): a seller can force a recrawl each minute | `application/crawler.service.ts:67` | FR-004, AS-11 |
| A5 | Guard failures answer `400` with the guard's message; no `422 url_not_allowed` / `url_unresolvable`; the DTO accepts `http://` and any port (`IsUrl` only) and no length cap | `application/crawler.service.ts:57-63`, `crawler.module.ts:22-24` | FR-001, FR-012, AS-04, AS-05 |
| A6 | Product ownership by `SELECT 1 FROM "Product"` and a `400 'Product not found in this shop'` (not `404`, not indistinguishable, no archived check) | `application/crawler.service.ts:70-71` | FR-002, AS-06 |
| A7 | Permission is `ShopScoped('products.write')` only on `POST`; no read permission route; no rate limit | `crawler.module.ts:31` | FR-008, FR-009, AS-07, AS-10 |
| A8 | The SSRF allowlist reuses `webhooks_allow_private_hosts`, allows `http`, and is silently ignored in production instead of failing startup | `application/crawler.service.ts:50-54` | FR-012, AS-56 |
| A9 | `getPinned` has only an idle-socket timeout (no overall deadline), reads any content type, follows redirects to any host (up to 3), does not enforce port 443, reports truncation silently, and exposes no injectable resolver | `libs/infrastructure/net/pinned-get.ts:18-56` | FR-012–FR-014, AS-26–AS-28, S54 `safeGet` |
| A10 | Scheduler queues any due target with a 3600 s mark (not 15 min), ignores watchers (queues targets with no watch, paused shops), has no priority by plan, no fast-store-loss story beyond the mark | `application/crawler.service.ts:81-93` | FR-011, AS-16, AS-17 |
| A11 | A crawl that throws (SSRF, timeout, DNS, parse) updates nothing: `nextCheckAt` stays due and the target is queued again next minute at the host's 1 s delay | `application/crawler.service.ts:96-108` | FR-019, AS-29 |
| A12 | The frontier has no per-crawl budget (lease 60 s but fetch has no deadline, so a lease can lapse mid-fetch and two workers fetch one host); `release` ignores the delay cap and the `Retry-After` header; `push` and `take` use un-tagged keys (single shard only) | `infra/frontier.ts:34-50`, `application/crawler.service.ts:124` | FR-015, AS-17, AS-23, AS-24 |
| A13 | `429`/`503` back-off multiplies the delay by 10 but ignores `Retry-After`; `4xx` ladder, `gone`, `blocked_by_site`, `redirected_host` and network error statuses are not distinguished | `application/crawler.service.ts:124-125` | FR-015, FR-019, AS-24, AS-29 |
| A14 | robots: a network failure means "allowed" with a 10 s delay; a `4xx` is cached for 1 h like a missing file but a `403` and others are not told apart; `5xx` blocks but is cached 1 h (spec 15 min); redirect to another origin not handled; group match is a substring test; cap on robots size is 512 KiB of the body but the parser is not limited to 500 KiB | `application/crawler.service.ts:179-196`, `domain/robots.ts:33` | FR-016, AS-19–AS-21 |
| A15 | `Crawl-delay` uncapped (a value of 86400 starves the host's queue), negative values accepted | `application/crawler.service.ts:117`, `domain/robots.ts:26` | FR-015, AS-22 |
| A16 | `robots.txt` field parsing: `Allow:`/`Disallow:` with empty values are dropped for both (an empty `Disallow:` should allow all, which is the same; `Allow:` empty is ignored: ok), no BOM handling, no first-500-KiB rule | `domain/robots.ts:14-40` | AS-19 |
| A17 | Extraction: `Math.round(n * 100)`, strips every non-digit but `.`, so `"1.299,00"` is `1.299`; currency defaults to `USD`; first offer taken even if out of stock; price `0` rejected but huge values accepted; meta regex requires `property` before `content` | `domain/extract-price.ts:6-39` | FR-021, AS-33 |
| A18 | `normalizeUrl` strips `tag`, `ref`, `spm`, `mc_*` generically, does not punycode or upper-case percent-escapes, accepts any scheme and port, no length cap, no idempotence test | `domain/url.ts:1-18` | FR-017, AS-40 |
| A19 | SimHash is unit-tested only for the happy case; no property tests; degenerate text (under 3 words) loops `Math.max(words.length, 3)` over undefined shingles | `domain/simhash.ts:11`, `domain/crawler.spec.ts:24-29` | FR-022, AS-36 |
| A20 | No jitter; the intervals are integers of hours; no floor of 1 h; `unchangedStreak` is not reset when a changed page keeps the same price | `application/crawler.service.ts:131-148,168-176` | FR-019, AS-35, AS-37 |
| A21 | History row on every changed extraction (including same price); no observation counter; the row is written before the state update with no deduplication token, so a retry duplicates it; a ClickHouse failure aborts the crawl after the page was already archived | `application/crawler.service.ts:137-146` | FR-023, FR-024, AS-41, AS-42 |
| A22 | The update of `CrawlTarget` is unconditional: two workers can both record and both alert | `application/crawler.service.ts:145,168-176` | FR-023, AS-42 |
| A23 | Alert goes to `NotificationRouter.dispatch` with `formatMoney`; the seller's price is the `Product.price` column formatted as `'usd'`; one comparison at the target level; one owner per row of a SQL join; dedupe key `competitor:<watch>:<price>` (so a price that returns never re-alerts) | `application/crawler.service.ts:9,150-167` | FR-025–FR-028, AS-43–AS-50 |
| A24 | A watch registered on an already observed target is never evaluated until the price changes | `application/crawler.service.ts:56-79,147` | FR-027, AS-49 |
| A25 | No consumer of `tenancy.shop_*` or `catalog.product_deleted`: suspended or deleted shops keep being crawled and alerted; product deletion relies on the FK cascade | whole domain; migration `20261002140000-competitor-watch.js` | FR-029–FR-031, AS-51–AS-53 |
| A26 | No retention job for orphaned targets; no lifecycle assertion for archive and history | whole domain | FR-032, AS-54 |
| A27 | No metrics, no lag gauge; the only log is `crawl <url> failed: <message>` which prints the full URL | `application/crawler.service.ts:103` | FR-033, AS-55 |
| A28 | No startup validation of crawler configuration (loop count hard-coded to 16, delays and caps constants) | `crawler.module.ts:60`, `application/crawler.service.ts:20-23` | AS-56 |
| A29 | The seen-set (Bloom filter) of the pattern map does not exist in the crawler (the SD-35 notes say it was dropped); `urlKey()` (sha256) is unused | `application/crawler.service.ts:198-200` | FR-010, AS-31 |
| A30 | Worker module: fetch loops start on `onApplicationBootstrap` with a bare `catch(() => false)` (errors swallowed, no metrics), shutdown awaits loops that may hold a 60 s lease, no 30 s abandon | `crawler.module.ts:55-72` | FR-020, AS-30 |
| A31 | The module declares the controller, a DTO, the worker class, two Nest modules and the job payload typing in one file; the service holds SQL, Redis, ClickHouse, storage and notification calls together | `crawler.module.ts:1-82`, `application/crawler.service.ts:1-202` | D-6; ports `WatchRepository`, `TargetRepository`, `ObservationHistory`, `PageArchive`, `RobotsCache`, `FrontierPort`, `SeenSet`, `SafeFetcher` in `domain/`, adapters in `infra/` |
| A32 | The e2e spec injects `ShopModel` and `ShopMembershipModel`, spies `NotificationRouter`, calls the service directly (never through HTTP or the job), uses `redis.keys('crawl:*')`, binds a single fixture server and asserts only the ladder partially; it has no spec for list, delete, history, limits, isolation, robots outcomes, redirects, limits, concurrency, events | `crawler.e2e-spec.ts:15,18,21,59,76,87-139` | VII.2–VII.4, all |
| A33 | `contracts` has no schemas for the routes or the event | `packages/contracts` (none found) | FR-034, AS-43 |
| A34 | ClickHouse DDL has no deduplication and no counter column; the 2-year TTL is expressed but not tested | `clickhouse/090_competitor_prices.sql` | FR-023, AS-41, AS-54 |

## B. Debt register rows (`docs/architecture/debt-register.md`) that name `seller-insights` or apply to it

| Row | What | In this capability | Replaced by |
|---|---|---|---|
| D-6 (I.2) | `api/` and `application/` import `infra/` directly; `seller-insights/crawler.module.ts` declares `CompetitorController` inline | `crawler.module.ts:26-37` (controller + DTO inline); `application/crawler.service.ts:3-14` imports `infra/frontier` and runs SQL, Redis, ClickHouse and storage directly | move the controller and DTOs to `api/`, repository and adapter ports in `domain/` with adapters in `infra/` (A31); controllers use contracts schemas |
| D-7 (IX.4) | Other domains' `*Model` exports | `crawler.e2e-spec.ts:18` imports `ShopModel`, `ShopMembershipModel` from `@app/domains/tenancy` and registers them with `forFeature` (`:23`) | shared fixtures `createShop`, `createMember`, `createProduct` and the exported services of tenancy and catalog (tests may touch every table, IX.6, but must not inject foreign models) |
| D-8 (X.4) | Barrels export infrastructure internals | `index.ts:9` exports `CrawlerModule`, `CrawlerWorkerModule` only (ok); `NotificationRouter`/`formatMoney` are imported from notifications' barrel by `crawler.service.ts:9` (S28 removes that export) | export `CompetitorsModule` (core), `CrawlerWorkerModule`, `CompetitorProjectorModule`; apps wire those |
| D-12 (IX.4) | Raw SQL on tables owned by another domain | `application/crawler.service.ts:70` (`SELECT 1 FROM "Product"`), `:155` (`JOIN "Product"`, `JOIN "ShopMembership"`); migration FKs to `"Shop"` and `"Product"` with `ON DELETE CASCADE` | see section C |
| D-15, D-17 | Not applicable to this capability | — | — |

## C. `check:table-ownership` lines for this domain (derived by reading; re-run to confirm)

| File:line | Kind | What | Mechanism that replaces it |
|---|---|---|---|
| `application/crawler.service.ts:70` | SQL | `SELECT 1 FROM "Product" WHERE id = :productId AND "shopId" = :shopId` (ownership) | **R1** `ProductQueryService.getProductsByIds([productId], {shopId})` (S05); not found and foreign are the same `404` |
| `application/crawler.service.ts:155` | SQL | `JOIN "Product" p ON p.id = w."productId"` (your price, title) | **R1** `getProductsByIds(ids ≤ 500)` per evaluation batch; price and currency from the DTO |
| `application/crawler.service.ts:155` | SQL | `JOIN "ShopMembership" m … m.role = 'OWNER'` (recipients) | **R1** `MembershipQueryService.getMembersByShopIds(shopIds, ['OWNER'])` (S03) |
| `migrations/20261002140000-competitor-watch.js` | FK | `CompetitorWatch.shopId REFERENCES "Shop"`, `productId REFERENCES "Product" ON DELETE CASCADE` | new migration drops both (IX.4); **R3** shop read model fed by `tenancy.shop_*`, product cleanup from `catalog.product_deleted` |
| `crawler.module.ts:9,12` | import | `NotificationsCoreModule` (notifications) | removed: the alert is an outbox event (IV.3, S28 consumes it) |
| `application/crawler.service.ts:9` | import | `NotificationRouter`, `formatMoney` from `@app/domains/notifications` | removed with the event |
| `crawler.module.ts:8,13` | import | `AuthModule` (identity), `ShopScoped` (tenancy) | allowed (exported guards, IV.1); no change |
| `crawler.e2e-spec.ts:18,23,81-85` | MODEL | test imports and registers `ShopModel`, `ShopMembershipModel` and calls `.create` | shared fixtures and exported services (see D-7) |
| `db/ownership.ts:146-147` | registry | `CompetitorWatch`, `CrawlTarget` registered as `domain:seller-insights` (ok) | add the shop read-model table in the same PR that creates it (IX.3) |

## D. Missing pieces (new work)

1. **Contracts** (`packages/contracts`): `createCompetitorWatchSchema`, `competitorWatchSchema`, `competitorWatchListSchema`, `competitorPricesSchema`, the problem codes of FR-034, the event `sellerInsightsCompetitorPriceDropped` v1 and the consumed events (`tenancy.shop_created|plan_changed|status_changed|deleted`, `catalog.product_deleted`).
2. **Schema**: migration (with `lock_timeout`, III.11) that drops the two foreign keys and the cascade, adds `CompetitorWatch.status`, `CompetitorWatch.lastEvaluatedPriceMinor`, `CrawlTarget.observationNo`, `lastObservedAt`, `queuedAt`, `retiredAt`, `lastStatus` vocabulary, indexes for the scheduler (`status`, `nextCheckAt`, `retiredAt`); a shop read-model table `{shopId, plan, status, version}` with its registry entry; a data step that re-normalises `CrawlTarget.url` with the new rules and merges duplicates (re-pointing watches); a ClickHouse migration that adds the counter column and deduplication (insert token) to `competitor_prices`.
3. **S54 `safeGet`** consumed in place of `pinned-get.ts` (A9); until it lands, extend `libs/infrastructure/net/pinned-get.ts` to the shape in the spec (the guard's own unit spec `ssrf-guard.spec.ts` stays).
4. **Seen-set**: a Bloom filter port with a Redis adapter (A29); the existing Bloom implementation shared with the penetration guard (pattern map P1103) is the one to reuse.
5. **Read paths**: `CompetitorsModule` (core), the shop and product consumers (projector app), worker loads the catalog and tenancy exported modules (R1).
6. **Tests**: the five e2e files and four unit specs of [`test-plan.md`](test-plan.md); replace `crawler.e2e-spec.ts` and `domain/crawler.spec.ts`; web journey `packages/web/e2e/competitor-monitor.spec.ts` once the screen exists.
7. **Removal of dead code and config**: `urlKey` (A29), the `webhooks_allow_private_hosts` use in the crawler, `NotificationRouter` imports; new config keys with startup validation (fixture allowlist, loop count, minimum gap, request cap).
8. **Load script** for SC-007 under `packages/backend/scripts/load-tests/`.
