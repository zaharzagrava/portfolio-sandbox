---
id: S41
title: Competitor price monitor (watches, polite SSRF-safe crawling, robots.txt, price extraction, change detection, price-drop alerts)
kind: capability
status: draft
depends_on: [S01, S03, S05, S18, S28, S49, S50, S53, S54]
concepts: [outbox-task-queue, projection-and-replay, rate-limit-policy, problem-json-errors, tenant-shop-rbac, transaction-runner]
models: []
scope:
  - packages/backend/libs/domains/seller-insights/domain/alert-rule.ts
  - packages/backend/libs/domains/seller-insights/domain/competitor-errors.ts
  - packages/backend/libs/domains/seller-insights/domain/crawler-ports.ts
  - packages/backend/libs/domains/seller-insights/domain/extract-price.ts
  - packages/backend/libs/domains/seller-insights/domain/robots.ts
  - packages/backend/libs/domains/seller-insights/domain/schedule.ts
  - packages/backend/libs/domains/seller-insights/domain/simhash.ts
  - packages/backend/libs/domains/seller-insights/domain/url.ts
  - packages/backend/libs/domains/seller-insights/application/competitor-*.ts
  - packages/backend/libs/domains/seller-insights/application/crawl*.ts
  - packages/backend/libs/domains/seller-insights/application/crawler.*.ts
  - packages/backend/libs/domains/seller-insights/api/competitors.controller.ts
  - packages/backend/libs/domains/seller-insights/api/duplicate-keys.ts
  - packages/backend/libs/domains/seller-insights/infra/clickhouse-observation-history.ts
  - packages/backend/libs/domains/seller-insights/infra/crawler.worker.ts
  - packages/backend/libs/domains/seller-insights/infra/pg-competitor-shop.repository.ts
  - packages/backend/libs/domains/seller-insights/infra/pg-target.repository.ts
  - packages/backend/libs/domains/seller-insights/infra/pg-watch.repository.ts
  - packages/backend/libs/domains/seller-insights/infra/redis-frontier.ts
  - packages/backend/libs/domains/seller-insights/infra/redis-robots-cache.ts
  - packages/backend/libs/domains/seller-insights/infra/redis-seen-set.ts
  - packages/backend/libs/domains/seller-insights/infra/s3-page-archive.ts
  - packages/backend/libs/domains/seller-insights/infra/safe-fetcher.ts
  - packages/backend/libs/domains/seller-insights/infra/projectors/competitor.projectors.ts
  - packages/backend/libs/domains/seller-insights/infra/models/competitor-*.ts
  - packages/backend/libs/domains/seller-insights/infra/models/crawl-target.model.ts
  - packages/backend/libs/domains/seller-insights/competitor*.module.ts
  - packages/backend/libs/domains/seller-insights/crawler-worker.module.ts
  - packages/contracts/src/seller-insights/competitors.ts
  - packages/contracts/src/seller-insights/competitor-events.ts
  - packages/backend/clickhouse/131_competitor_prices_v2.sql
---
# S41 - Competitor price monitor (watches, polite SSRF-safe crawling, robots.txt, price extraction, change detection, price-drop alerts)
## Purpose
A shop on a plan that allows it registers the public URL of a competitor's product page against one of its own products. The platform re-crawls every registered page on an adaptive schedule, politely (one request at a time per host across the whole fleet, `robots.txt` honoured, an identifiable client) and safely (a seller can never point it at the platform's own network), reads one price from structured data, keeps the history of changes and tells the shop's owners when the competitor undercuts them. A page watched by several shops is fetched once. The capability publishes an event for the alert; it delivers no notification.

## Entry points
- `POST /api/shops/:shopId/competitors` registers a watch (`201` new, `200` replay), `GET /api/shops/:shopId/competitors` lists them, `DELETE /api/shops/:shopId/competitors/:watchId` removes one and `GET /api/shops/:shopId/competitors/:watchId/prices` reads its price history. [code: packages/backend/libs/domains/seller-insights/api/competitors.controller.ts#CompetitorsController]
- Scheduler job `crawler.schedule-due` (every minute), fetch loops and purge job `crawler.purge-targets` (daily) in the worker app. [code: packages/backend/libs/domains/seller-insights/infra/crawler.worker.ts#CrawlerWorker]
- Consumers of `tenancy.shop_created|shop_plan_changed|shop_status_changed|shop_deleted` and `catalog.product_deleted`, listed by `CompetitorProjectorModule.projectors`. [code: packages/backend/libs/domains/seller-insights/competitor-projector.module.ts#CompetitorProjectorModule]
- Event produced: `sellerinsights.competitor_price_dropped` v1 on topic `seller_insights.events`. [code: packages/backend/libs/domains/seller-insights/application/events/seller-insights-events.ts#CompetitorPriceDropped]

## Rules
- **S41.R-01** A watch MUST be registered by a member with `products.write` for an `ACTIVE` product of the shop, with a URL that is normalised once (`https`, port 443, no credentials, at most 2048 characters, host lower-cased and punycode, tracking parameters and fragment removed, parameters sorted); an invalid shape is `400 validation_failed` naming the field and nothing is stored. [proof: S41 AS-01, S41 AS-04, S41 AS-40] [code: packages/backend/libs/domains/seller-insights/domain/url.ts#normalizeUrl]
- **S41.R-02** Registration MUST be idempotent: the same product and normalised URL answers `200` with the same watch, a second URL for a product is a new watch, and a URL watched by another shop shares the target without changing its schedule. [proof: S41 AS-02, S41 AS-03, S41 AS-09] [code: packages/backend/libs/domains/seller-insights/application/competitor-watch.service.ts#CompetitorWatchService]
- **S41.R-03** A URL MUST be refused with `422 url_not_allowed` (generic detail, no address) when its scheme, port or credentials are not allowed or any address it resolves to is not public, and with `422 url_unresolvable` when the host does not resolve; no request goes to the competitor at registration. [proof: S41 AS-05] [code: packages/backend/libs/domains/seller-insights/infra/safe-fetcher.ts#SafeRequestFetcher]
- **S41.R-04** A product of another shop and an unknown product MUST answer the same `404 product_not_found`; an archived product is `409 product_archived`. [proof: S41 AS-06] [code: packages/backend/libs/domains/seller-insights/application/competitor-watch.service.ts#CompetitorWatchService]
- **S41.R-05** At most 5 watches per product and `maxCompetitorWatches` per shop MUST hold under concurrency (a per-shop lock around count, check and insert); the limit is read from the entitlement service and an unavailable one refuses the write with `503 entitlements_unavailable`. [proof: S41 AS-08, S41 AS-09] [code: packages/backend/libs/domains/seller-insights/infra/pg-watch.repository.ts#PgWatchRepository]
- **S41.R-06** Registration MUST NOT make a target due that was checked within the last hour; an older or never-checked target is due at once. [proof: S41 AS-11] [code: packages/backend/libs/domains/seller-insights/infra/pg-target.repository.ts#PgTargetRepository]
- **S41.R-07** Every route MUST keep the answer order of tenancy (`401`, `404 shop_not_found` for a non-member, unknown or malformed shop, `403 permission_denied`, the status gate); a watch of another shop is `404 watch_not_found`; reads need `shop.read`, which every role has and a suspended or closing shop keeps. [proof: S41 AS-07] [code: packages/backend/libs/domains/seller-insights/api/competitors.controller.ts#CompetitorsController]
- **S41.R-08** Writes MUST be limited to 30 a minute per shop and refused when the limiter store is down. [proof: S41 AS-10] [code: packages/backend/libs/domains/seller-insights/api/rate-limit-policies.ts#sellerInsightsRatePolicies]
- **S41.R-09** The list MUST page newest first with a keyset cursor (default 50, at most 100) and show no target id, internal field or other shop's watch; an invalid parameter is `400 validation_failed`. [proof: S41 AS-12] [code: packages/contracts/src/seller-insights/competitors.ts#competitorWatchListSchema]
- **S41.R-10** Removing a watch MUST be `204` (a repeat `404`); the last watch of a target retires the target, which is no longer scheduled and is dropped without a request when taken from the queue. [proof: S41 AS-13] [code: packages/backend/libs/domains/seller-insights/application/competitor-watch.service.ts#CompetitorWatchService]
- **S41.R-11** The price history MUST cover 1 to 365 days (default 30), oldest first, at most 1000 newest points, with the lowest price (earliest instant) and the latest price within the latest currency; an unreachable history store is `503 history_unavailable` within 3 seconds and does not affect the list. [proof: S41 AS-14, S41 AS-15] [code: packages/backend/libs/domains/seller-insights/infra/clickhouse-observation-history.ts#ClickHouseObservationHistory]
- **S41.R-12** The scheduler MUST queue each due, watched, non-paused, non-retired target at most once per 15-minute queue mark, highest shop plan first then earliest due, up to a per-run cap; the frontier is rebuilt from the database after a loss and a host leased by a dead worker is free again after the lease. [proof: S41 AS-16, S41 AS-17] [code: packages/backend/libs/domains/seller-insights/application/crawl-scheduler.service.ts#CrawlSchedulerService]
- **S41.R-13** robots.txt MUST be read per RFC 9309 (the product token group before `*`, longest match, `*` and `$`, first 500 KiB, `Crawl-delay` capped at 300 s) and consulted before every page; a disallowed path is never requested; `5xx`, a network failure, a timeout or a cross-origin redirect blocks the page for an hour; `404`, `410` and other `4xx` allow everything; the cache is fleet-wide and keyed by origin with port. [proof: S41 AS-18, S41 AS-19, S41 AS-20, S41 AS-21] [code: packages/backend/libs/domains/seller-insights/domain/robots.ts#parseRobots]
- **S41.R-14** At most one request per host MUST be in flight across all workers, consecutive requests to a host (robots.txt included) MUST be at least `max(1 s, Crawl-delay)` apart, different hosts are fetched in parallel, and `429`/`503` extend the host's wait to `max(10 x delay, Retry-After)` with `Retry-After` capped at an hour. [proof: S41 AS-22, S41 AS-23, S41 AS-24] [code: packages/backend/libs/domains/seller-insights/infra/redis-frontier.ts#RedisFrontier]
- **S41.R-15** Every request MUST be a `GET` that names the crawler (`MarketplacePriceBot/1.0 (+https://marketplace.dev/bot)`), asks for HTML with identity encoding and carries no cookie, referrer, authorization or shop or user identifier. [proof: S41 AS-25] [code: packages/backend/libs/domains/seller-insights/infra/safe-fetcher.ts#USER_AGENT]
- **S41.R-16** Every request, robots.txt and each redirect hop included, MUST resolve the host once, require every address to be public and connect to the address that was checked; a refusal is the status `blocked_address` and nothing is requested. [proof: S41 AS-26] [code: packages/backend/libs/domains/seller-insights/infra/safe-fetcher.ts#SafeRequestFetcher]
- **S41.R-17** At most 3 same-host `https` redirects MUST be followed; a redirect to the metadata or any non-public address ends the crawl as `blocked_address`, to `http` as `redirect_refused`, to another host as `redirected_host`, a fourth hop as `too_many_redirects` and a redirect without a target as `http_3xx`; a redirect target never becomes a new target. [proof: S41 AS-27] [code: packages/backend/libs/infrastructure/net/pinned-request.ts#strictRedirects]
- **S41.R-18** A body MUST be cut at 2 MiB (its prefix is processed), only HTML is accepted, a request ends at 10 seconds and a crawl at 30, and the host is given back whatever happened. [proof: S41 AS-28] [code: packages/backend/libs/domains/seller-insights/application/crawl.service.ts#CrawlService]
- **S41.R-19** A failed crawl MUST record its status and a next check (`gone` 12 to 48 hours, `blocked_by_site` and policy refusals 24 hours, other `4xx` 12 hours, `5xx` and network failures 1 hour doubling to 24) and MUST NOT change the last price, the observation counter or send an event. [proof: S41 AS-29, S41 AS-24] [code: packages/backend/libs/domains/seller-insights/domain/schedule.ts#nextIntervalMs]
- **S41.R-20** A stopping worker MUST take no new target, finish or after 30 seconds abandon the fetches in flight and release their hosts. [proof: S41 AS-30] [code: packages/backend/libs/domains/seller-insights/infra/crawler.worker.ts#CrawlerWorker]
- **S41.R-21** The seen-set of normalised URLs MUST be a negative filter only: a false positive or a lost set changes no outcome, creates and crawls a new target and skips no fetch. [proof: S41 AS-31] [code: packages/backend/libs/domains/seller-insights/infra/redis-seen-set.ts#RedisSeenSet]
- **S41.R-22** A price MUST come from structured data (JSON-LD, then meta tags), never from free text, with exact decimal arithmetic by the currency's minor-unit exponent; a missing currency, an ambiguous format or mixed currencies give no price. [proof: S41 AS-33] [code: packages/backend/libs/domains/seller-insights/domain/extract-price.ts#extractPrice]
- **S41.R-23** A page is unchanged only when the price is equal and its SimHash is within 3 bits; extraction always runs, so a one-token price change is an observation; unchanged pages back off 12, 24, 48, 48 hours with at most 10 % jitter and never less than an hour. [proof: S41 AS-34, S41 AS-35, S41 AS-36, S41 AS-37] [code: packages/backend/libs/domains/seller-insights/domain/simhash.ts#simhash]
- **S41.R-24** A page without a price or with only out-of-stock offers MUST keep the last price, write no row or event, archive once per fingerprint change and slow to 24 hours after three; a new currency is a new observation. [proof: S41 AS-38, S41 AS-39] [code: packages/backend/libs/domains/seller-insights/application/crawl.service.ts#CrawlService]
- **S41.R-25** An observation MUST write its history row first (idempotent on target and counter), then advance the counter only if no other worker did, in one transaction with the first batch of watch evaluations; a failed store leaves price and counter untouched and retries in 15 minutes, a failed archive never blocks it. [proof: S41 AS-41, S41 AS-42, S41 AS-48] [code: packages/backend/libs/domains/seller-insights/application/crawl.service.ts#CrawlService]
- **S41.R-26** After an observation every active watch MUST be evaluated once (batches of 500): the owners of the shop are alerted when the competitor price is below the product's price read at that moment, in the same currency, the product and shop are active and the price is lower than at the watch's previous evaluation. [proof: S41 AS-43, S41 AS-44, S41 AS-45, S41 AS-46, S41 AS-47] [code: packages/backend/libs/domains/seller-insights/domain/alert-rule.ts#shouldAlert]
- **S41.R-27** An alert MUST be one outbox event per owner with an id derived from watch, `priceVersion` and owner, written in the transaction that claims the watch's evaluation, never repeated by a re-run; a watch registered on an observed target is evaluated in its registration; a shop with no owner records the observation and warns. [proof: S41 AS-43, S41 AS-48, S41 AS-49, S41 AS-50] [code: packages/backend/libs/domains/seller-insights/application/competitor-evaluation.service.ts#CompetitorEvaluationService]
- **S41.R-28** The shop read model MUST follow tenancy events under a version guard (a stale or repeated version changes nothing, a status event before the shop is known creates its row), pause the watches while the shop is not `ACTIVE`, and erase them with the shop; a deleted product's watches are deleted. [proof: S41 AS-50, S41 AS-51, S41 AS-52] [code: packages/backend/libs/domains/seller-insights/application/competitor-shop.service.ts#CompetitorShopService]
- **S41.R-29** An invalid or unsupported message MUST be dead-lettered with a reason and change nothing, an unrelated type is ignored, and a duplicate has the effect of one. [proof: S41 AS-53] [code: packages/backend/libs/domains/seller-insights/infra/projectors/competitor.projectors.ts#CompetitorShopProjector]
- **S41.R-30** Targets without a watch for 30 days MUST be purged by a daily job that never deletes a row twice; archived pages expire after 7 days and history rows after 2 years. [proof: S41 AS-54] [code: packages/backend/libs/domains/seller-insights/application/crawl-retention.service.ts#CrawlRetentionService]
- **S41.R-31** Crawls MUST be counted by outcome, the overdue and ready-host gauges exposed, and logs carry `crawlId`, `targetId` and `host` but never the URL, query, body or an address; an invalid crawler setting stops the application naming its key and the fixture allowlist is refused in production. [proof: S41 AS-55, S41 AS-56] [code: packages/backend/libs/domains/seller-insights/application/crawler.config.ts#parseCrawlerConfig]

## Behaviors
- **S41.B-01** Given shop A with an allowance of 5 and product `PA` priced 99900 EUR, when Stan registers a competitor URL and the first crawl finds 899.00 EUR, then the target holds the price with a counter of 1, one history row and one archived page, and Ann and Olga (owners) each get one price-drop event while Stan and the viewer get none. [proof: S41 AS-01, S41 AS-32, S41 AS-43]
- **S41.B-02** Given an alerted price, when the next crawls find the same price, 849.00, 950.00, 900.00, 1200.00 and 1250.00, then events are written only for 849.00 and 900.00 (lower than the previous price and below the seller's). [proof: S41 AS-45]
- **S41.B-03** Given a robots.txt that disallows the page's path, when the target is crawled, then only robots.txt is requested and the page is checked again in 24 hours. [proof: S41 AS-18]
- **S41.B-04** Given a suspended shop, when its status event is consumed, then its watches are paused and neither crawled nor evaluated until it is reinstated. [proof: S41 AS-50, S41 AS-51]

## Lifecycles
None modelled. A watch is `ACTIVE` or `PAUSED` (by the shop's status) and ends by deletion; a target is due, queued, crawled, due again, retired when unwatched and purged after 30 days.

## Owns
Tables `CrawlTarget`, `CompetitorWatch` and the shop read model `CompetitorShop`; Redis keys `crawl:*` (all derived: frontier, host gaps, queue marks, robots cache, seen-set); ClickHouse table `competitor_prices` (2-year retention, insert deduplication on `<targetId>:<observationNo>`); object-storage prefix `crawl/` (7-day lifecycle rule); rate-limit policy `seller-insights.competitor-write.shop`; jobs `crawler.schedule-due` and `crawler.purge-targets`; settings `crawler_fetch_loops`, `crawler_min_gap_ms`, `crawler_max_body_bytes`, `crawler_schedule_cap`, `crawler_lease_ms`, `crawler_fixture_hosts`.

## Decisions
- The alert is emitted as `sellerinsights.competitor_price_dropped` on topic `seller_insights.events` (the work order says `seller_insights.competitor_price_dropped` on `seller-insights.events`): the event envelope forbids an underscore in the first type segment and the notification capability consumes that name. [code: packages/contracts/src/seller-insights/competitor-events.ts#COMPETITOR_PRICE_DROPPED_TYPE]
- The read routes need `shop.read` rather than `products.read`: every role has both, and only `shop.read` stays available on a suspended or closing shop, which the work order requires of the list and the history.
- The 503 of a fail-closed limiter outage carries the platform's code `rate_limiter_unavailable`, not `service_unavailable`.
- robots.txt and the page are two requests to one host, so a freshly fetched robots.txt is followed by the politeness gap before the page.
- Redirects are judged by their target before their host (`strictRedirects` of the shared `safeGet`), so a redirect to the metadata address is `blocked_address`, not `redirected_host`.
- `maxCompetitorWatches` is a new plan entitlement key added to billing's closed list and its database check; the plan values are billing's to set.

## Known gaps
- First-fetch latency of a new URL within 2 minutes in a running fleet (wall-clock bound), the registration and history latency targets and the fleet throughput target are not proven by an automated test; see the ops artifacts of the work order's quickstart.
- The seller web screen for watches and the price chart is a later web capability.
- A page that lists several products with JSON-LD gives the first Product node that has a price; a seller whose competitor markup puts a related item first must pick a better URL.
