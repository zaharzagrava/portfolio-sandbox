---
id: S37
title: Share and affiliate short links (codes, aliases, redirects, click attribution)
kind: capability
status: draft
depends_on: [S01, S49, S50, S52, S53, S54]
concepts: [problem-json-errors, rate-limit-policy, idempotency-key, cache-layers, projection-and-replay, job-scheduler-lease]
models: []
scope:
  - packages/backend/libs/domains/marketing/api/share-links.controller.ts
  - packages/backend/libs/domains/marketing/api/idempotency-header.guard.ts
  - packages/backend/libs/domains/marketing/application/share-link-*.ts
  - packages/backend/libs/domains/marketing/application/redirect.service.ts
  - packages/backend/libs/domains/marketing/application/link-attribution.service.ts
  - packages/backend/libs/domains/marketing/application/filter-rebuild.service.ts
  - packages/backend/libs/domains/marketing/domain/alias-rules.ts
  - packages/backend/libs/domains/marketing/domain/click-meta.ts
  - packages/backend/libs/domains/marketing/domain/codes.ts
  - packages/backend/libs/domains/marketing/domain/destination-policy.ts
  - packages/backend/libs/domains/marketing/domain/link-*.ts
  - packages/backend/libs/domains/marketing/domain/list-cursor.ts
  - packages/backend/libs/domains/marketing/domain/ports.ts
  - packages/backend/libs/domains/marketing/infra/dynamo-link.repository.ts
  - packages/backend/libs/domains/marketing/infra/redis-*.ts
  - packages/backend/libs/domains/marketing/infra/kafka-click.publisher.ts
  - packages/backend/libs/domains/marketing/infra/clickhouse-click-stats.reader.ts
  - packages/backend/libs/domains/marketing/infra/link-clicks.projector.ts
  - packages/backend/libs/domains/marketing/infra/share-links.jobs.ts
  - packages/backend/libs/domains/marketing/share-links*.module.ts
  - packages/backend/libs/domains/marketing/rate-limit-policies.ts
  - packages/contracts/src/marketing/share-links.ts
  - packages/edge-be/src/index.ts
---
# S37 - Share and affiliate short links (codes, aliases, redirects, click attribution)
## Purpose
A signed-in user turns a marketplace page into a short link, either a generated 7-character code or a custom alias, and shares it. The redirect is public, fast and honest: it answers `302` only for a link that is active and still points at the marketplace, and `404`, `410` or `503` otherwise. Each served redirect yields one click event, counted once; the owner reads statistics, changes the destination, or disables the link for good. The `ref` parameter carries attribution to checkout; `LinkAttributionService.resolveAttributions` tells a consumer who owns the link behind a `ref`. Links live in DynamoDB, the existence filter and cache in Redis, clicks in Kafka and ClickHouse; an edge worker serves hot redirects.

## Entry points
- `POST /api/links`, `GET /api/links`, `PATCH /api/links/:code`, `POST /api/links/:code/disable`, `GET /api/links/:code/stats`, and the public `GET|HEAD /api/l/:code`. [code: packages/backend/libs/domains/marketing/api/share-links.controller.ts#ShareLinksController]
- `LinkAttributionService.resolveAttributions(codes)`: the R1 lookup of owner and status behind `ref` codes. [code: packages/backend/libs/domains/marketing/application/link-attribution.service.ts#LinkAttributionService]
- Topic `links.events`: `link.clicked` v1. [code: packages/backend/libs/domains/marketing/domain/link-events.ts#LinkClicked]
- Consumer `link-clicks` and job `share-links.rebuild-filter`. [code: packages/backend/libs/domains/marketing/infra/link-clicks.projector.ts#LinkClicksProjector] [code: packages/backend/libs/domains/marketing/infra/share-links.jobs.ts#ShareLinksJobs]
- The edge worker route `/l/:code`. [code: packages/edge-be/src/index.ts#shortLinkRedirect]

## Rules
- **S37.R-01** Creating a link MUST answer `201` with `Location` and a body that parses with `shortLinkSchema` (no owner and no store key), store one row for the caller and count `link_created_total{kind}`. [proof: S37 AS-01] [code: packages/backend/libs/domains/marketing/application/share-link-command.service.ts#ShareLinkCommandService]
- **S37.R-02** A request MUST be refused with `400` `validation_failed` naming the field, storing nothing, for a missing or empty destination, one over 2,048 characters or with whitespace, an unknown field, an alias that is not 4 to 32 lower-case letters, digits and single dashes, a `ttlDays` outside 1 to 3,650, and an `Idempotency-Key` that is missing or not 8 to 128 characters. [proof: S37 AS-02] [code: packages/backend/libs/domains/marketing/api/idempotency-header.guard.ts#IdempotencyHeaderGuard]
- **S37.R-03** A destination MUST be an absolute `https` URL whose host, after case-folding and IDNA normalisation, equals the storefront host or its `www.` form, with no user-info, backslash, trailing dot or other port; anything else MUST answer `422` `destination_not_allowed` and store nothing. [proof: S37 AS-03] [code: packages/backend/libs/domains/marketing/domain/destination-policy.ts#checkDestination]
- **S37.R-04** The `ref` parameter MUST be removed from the stored destination, keeping the other parameters, their order, their encoding and the fragment, and the redirect MUST put `ref=<code>` after the query and before the fragment. [proof: S37 AS-04, S37 AS-25] [code: packages/backend/libs/domains/marketing/domain/destination-policy.ts#assembleRedirectUrl]
- **S37.R-05** A generated code MUST be 7 characters of `0-9A-Za-z`, a keyed bijection of a leased number (unique, reversible, non-adjacent, different under another key), and 1,000 concurrent creates through three instances MUST give 1,000 different codes. [proof: S37 AS-05] [code: packages/backend/libs/domains/marketing/domain/codes.ts#scramble]
- **S37.R-06** An instance MUST lease numbers in blocks of 1,000 with one counter call per block, never reissue the unused rest of a stopped instance's block, and make one counter call for concurrent demands on an exhausted block. [proof: S37 AS-06] [code: packages/backend/libs/domains/marketing/infra/redis-code-sequence.ts#RedisCodeSequence]
- **S37.R-07** A generated code that collides with a stored link MUST be retried with a new number (at most 5 attempts, `link_code_collision_total` each time), never overwrite, and after 5 collisions answer `503` `code_generation_failed` with nothing written. [proof: S37 AS-07] [code: packages/backend/libs/domains/marketing/application/share-link-command.service.ts#ShareLinkCommandService]
- **S37.R-08** A failing counter, existence filter or link store MUST answer a generic `503` `service_unavailable`, store no link, and let a retry with the same `Idempotency-Key` succeed. [proof: S37 AS-08] [code: packages/backend/libs/domains/marketing/domain/link-errors.ts#serviceUnavailable]
- **S37.R-09** Create MUST be idempotent per user for 24 hours: a replay returns the stored answer with `Idempotency-Replayed`, another user's key makes another link, two simultaneous requests give one `201` and one `409`, another body under the key is `422`. [proof: S37 AS-09, S37 AS-10] [code: packages/backend/libs/domains/marketing/api/share-links.controller.ts#ShareLinksController]
- **S37.R-10** `ttlDays` MUST set `expiresAt` to creation plus that many days (1 to 3,650), and a link without it never expires. [proof: S37 AS-11] [code: packages/backend/libs/domains/marketing/application/share-link-command.service.ts#ShareLinkCommandService]
- **S37.R-11** An owner MUST hold at most `share_link_max_per_owner` active, unexpired links: the place is reserved by a conditional counter update in the same step as the link, a disable or an expiry frees it, and the refusal is `422` `link_limit_reached`. [proof: S37 AS-12] [code: packages/backend/libs/domains/marketing/infra/dynamo-link.repository.ts#DynamoLinkRepository]
- **S37.R-12** Create MUST be limited to 20 a minute per user by its own policy `share-link.create` (`429` with `Retry-After`), failing closed with `503` `rate_limiter_unavailable` when the limiter store is down while the redirect keeps working. [proof: S37 AS-13] [code: packages/backend/libs/domains/marketing/rate-limit-policies.ts#marketingRatePolicies]
- **S37.R-13** A destination reputation check with a 2-second timeout MUST run before create and change: `block` is `422` `destination_blocked`, a timeout or failure is `503` `destination_check_unavailable`. [proof: S37 AS-14] [code: packages/backend/libs/domains/marketing/application/share-link-command.service.ts#ShareLinkCommandService]
- **S37.R-14** The five authenticated routes MUST answer `401` without credentials while the redirect stays public, and every error MUST be problem+json with a request id and no store text or stack. [proof: S37 AS-15, S37 AS-16] [code: packages/backend/libs/domains/marketing/domain/link-errors.ts#ShareLinkError]
- **S37.R-15** An alias MUST be claimed by one conditional write (`409` `alias_taken` for a taken one, also for its owner), after its format and the reserved words (`422` `alias_reserved`, configurable) are checked and before any number is consumed; ten simultaneous claims MUST give one winner. [proof: S37 AS-17, S37 AS-18, S37 AS-19, S37 AS-20, S37 AS-21] [code: packages/backend/libs/domains/marketing/domain/alias-rules.ts#isValidAlias]
- **S37.R-16** A code MUST stay taken while its record exists, an expired or disabled one included; a record carries a purge time 13 months after the expiry or disable, and only after the purge may the code be claimed again; a miss remembered for an alias MUST NOT hide its claim. [proof: S37 AS-22, S37 AS-23] [code: packages/backend/libs/domains/marketing/domain/link-state.ts#purgeAtEpoch]
- **S37.R-17** A followed active link MUST answer `302` with `Location` carrying `ref`, `Cache-Control: public, max-age=0, s-maxage=10`, an empty body, no cookie, and exactly one click event after the response. [proof: S37 AS-24] [code: packages/backend/libs/domains/marketing/application/redirect.service.ts#RedirectService]
- **S37.R-18** An unknown code MUST answer `404` `link_not_found` with `no-store` and no event; once the existence filter is trusted it MUST do so without reading the store, and a malformed code MUST answer the same `404` without any read. [proof: S37 AS-26, S37 AS-27] [code: packages/backend/libs/domains/marketing/application/code-format.ts#isValidCode]
- **S37.R-19** A link MUST be expired when `now >= expiresAt`; an expired or disabled link MUST answer `410` `link_gone` with identical bodies, `s-maxage=60` and no click, and a transition MUST be allowed only from the active state. [proof: S37 AS-28, S37 AS-29, S37 AS-65] [code: packages/backend/libs/domains/marketing/domain/link-state.ts#linkStateOf]
- **S37.R-20** `HEAD` MUST answer like `GET` without recording a click, and `POST`, `PUT`, `PATCH` and `DELETE` on a code MUST answer `405`. [proof: S37 AS-30] [code: packages/backend/libs/domains/marketing/api/share-links.controller.ts#ShareLinksController]
- **S37.R-21** Lookups MUST be cache-aside: a miss is remembered for 60 seconds, concurrent loads of one code share one store read, a stale copy is served up to 24 hours when the store fails, and an error is never stored. [proof: S37 AS-31, S37 AS-32, S37 AS-34] [code: packages/backend/libs/domains/marketing/infra/redis-link.cache.ts#RedisLinkCache]
- **S37.R-22** The existence filter MUST be trusted to say "absent" only while its ready marker exists (otherwise it is bypassed and counted); the rebuild job MUST re-add every stored code, set the marker last, and run once at a time. [proof: S37 AS-33] [code: packages/backend/libs/domains/marketing/application/filter-rebuild.service.ts#FilterRebuildService]
- **S37.R-23** A store that does not answer in 500 ms MUST answer `503` with `Retry-After` and never `404`, and MUST NOT be remembered as a miss. [proof: S37 AS-34] [code: packages/backend/libs/domains/marketing/infra/dynamo-link.repository.ts#DynamoLinkRepository]
- **S37.R-24** The destination of a resolved link MUST be re-checked at redirect time: one that is no longer allowed answers `410`, records nothing and increments `link_destination_rejected_total`. [proof: S37 AS-35] [code: packages/backend/libs/domains/marketing/application/redirect.service.ts#RedirectService]
- **S37.R-25** A refused or hanging event publish MUST NOT change or delay the `302`; it counts `link_click_publish_failed_total` once and logs one structured warning without visitor data, and shutdown MUST wait up to 5 seconds for in-flight publishes. [proof: S37 AS-36, S37 AS-37] [code: packages/backend/libs/domains/marketing/infra/kafka-click.publisher.ts#KafkaClickPublisher]
- **S37.R-26** A click event MUST be `link.clicked` v1 with `eventId` equal to `clickId` (a time-ordered UUID), the aggregate `links/<code>`, the code as key and the payload `{clickId, code, ts, country, referer, viaEdge}`, with no address, agent, cookie, user, destination, path or query. [proof: S37 AS-38] [code: packages/backend/libs/domains/marketing/domain/link-events.ts#LinkClicked]
- **S37.R-27** The country MUST be two upper-case letters (never `XX` or `T1`) or empty, and the referrer only its origin of at most 300 characters or empty. [proof: S37 AS-39] [code: packages/backend/libs/domains/marketing/domain/click-meta.ts#refererOrigin]
- **S37.R-28** The "already counted at the edge" flag MUST be honoured only with the shared edge credential (constant-time compare); the edge worker MUST record a click only for a `302` it serves, cache nothing else, and serve a cached `302` for less than 10 seconds. [proof: S37 AS-40, S37 AS-41, S37 AS-42] [code: packages/backend/libs/domains/marketing/application/redirect.service.ts#RedirectService]
- **S37.R-29** The click consumer MUST validate every event and dead-letter an invalid one with its reason and no effect, count a click once whatever the delivery count (statistics count distinct click ids at read time), and bucket by the click's own time. [proof: S37 AS-43, S37 AS-44, S37 AS-45] [code: packages/backend/libs/domains/marketing/infra/link-clicks.projector.ts#LinkClicksProjector]
- **S37.R-30** `resolveAttributions` MUST return `{code, ownerId, status}` for known codes (an expired link stays resolvable), omit unknown and malformed ones, refuse more than 100 codes, read the store once, and throw `AttributionUnavailableError` rather than return an empty result when the store is down. [proof: S37 AS-46, S37 AS-47] [code: packages/backend/libs/domains/marketing/application/link-attribution.service.ts#LinkAttributionService]
- **S37.R-31** The list MUST be keyset-paged newest first (`limit` 1 to 100, default 20) by a signed cursor bound to the owner; a tampered or foreign cursor is `400` `invalid_cursor`. [proof: S37 AS-48, S37 AS-49] [code: packages/backend/libs/domains/marketing/domain/list-cursor.ts#decodeCursor]
- **S37.R-32** `PATCH` MUST change only the destination (and `updatedAt`) of an active link after the destination checks, refuse an empty body and unknown or immutable fields with `400`, and drop the cached copy so the next redirect shows the change. [proof: S37 AS-50, S37 AS-51, S37 AS-55] [code: packages/backend/libs/domains/marketing/application/share-link-command.service.ts#ShareLinkCommandService]
- **S37.R-33** Disable MUST be final, keep the link listed and its statistics readable, free a place, and answer `409` `link_not_active` for a disabled or expired link (change included); racing changes and disables MUST end with the link disabled. [proof: S37 AS-52, S37 AS-53, S37 AS-54] [code: packages/backend/libs/domains/marketing/infra/dynamo-link.repository.ts#DynamoLinkRepository]
- **S37.R-34** Another user's change, disable or statistics, an unknown code and a malformed code MUST answer the same `404` and change nothing. [proof: S37 AS-56] [code: packages/backend/libs/domains/marketing/application/share-link-command.service.ts#ShareLinkCommandService]
- **S37.R-35** Statistics MUST be `linkStatsSchema` with numeric counts for `24h` (minute buckets), `7d` (hour, the default) and `30d` (day), only non-empty buckets, at most 10 countries, the window `[T - range, T]`, available for expired and disabled links, visible as soon as the consumer processed the click, and `503` alone when the analytics store is down. [proof: S37 AS-57, S37 AS-58, S37 AS-59, S37 AS-60, S37 AS-61] [code: packages/backend/libs/domains/marketing/infra/clickhouse-click-stats.reader.ts#ClickhouseClickStatsReader]
- **S37.R-36** Startup MUST fail naming the key for a missing or short code key or edge secret, a code key equal to another secret, a base URL that is not `https`, a limit that is not a positive integer, or a storefront origin that is not an `https` origin without path, and never fall back to another secret. [proof: S37 AS-62] [code: packages/backend/libs/common/config/share-links-config.ts#shareLinksConfigKeys]
- **S37.R-37** The metrics `link_created_total`, `link_redirect_total`, `link_resolve_total`, `link_filter_bypassed_total`, `link_code_collision_total`, `link_destination_rejected_total`, `link_click_publish_failed_total`, `link_click_projected_total`, `link_click_dead_lettered_total` and the consumer lag gauge MUST match what was done, and no log line, label or event field may carry a destination, referrer, query, secret or visitor identifier. [proof: S37 AS-63] [code: packages/backend/libs/domains/marketing/domain/link-metrics.ts#linkCreatedCounter]
- **S37.R-38** The domain barrel MUST export only the modules, the attribution lookup with its errors and the event contract, no other capability may touch the stores, keys, topic or analytics tables, and the domain layer reads no clock. [proof: S37 AS-64] [code: packages/backend/libs/domains/marketing/index.ts#LinkAttributionService]

## Behaviors
- **S37.B-01** Given a buyer on a product page, when they create a link and a visitor follows it, then the visitor lands on that page with `?ref=<code>` and one click is recorded. [proof: S37 AS-24]
- **S37.B-02** Given ten users claiming the alias `drop-sale` at once, then one gets `201`, nine get `409`, and the link goes to the winner's page. [proof: S37 AS-21]
- **S37.B-03** Given a link whose Redis filter was lost, when it is followed, then it still redirects, and once the rebuild job has run unknown codes are rejected without a store read. [proof: S37 AS-33]
- **S37.B-04** Given the link store down, when a cached link is followed, then it still redirects, and an uncached one answers `503` with `Retry-After`. [proof: S37 AS-34]
- **S37.B-05** Given the same click event delivered twice, then the owner's statistics show one click. [proof: S37 AS-43]
- **S37.B-06** Given a link disabled by its owner, when it is followed, then it answers `410` and the owner's statistics stay readable. [proof: S37 AS-52]

## Lifecycles
A link is active, then disabled (one way, final) or expired (derived when `now >= expiresAt`, never stored). Records are kept 13 months after expiry or disable, then purged, and only then may the code be claimed again.

## Owns
- DynamoDB table `Links` (links and per-owner counters `#owner#<id>`), index `byOwnerV2`.
- Redis keys `share-links:id-seq`, `share-links:bloom*` and `link:v1:*`.
- ClickHouse tables `link_clicks*`, topic `links.events`, rate-limit policy `share-link.create`, job `share-links.rebuild-filter`.
- Configuration keys `share_link_code_key`, `share_link_base_url`, `share_link_edge_secret`, `share_link_max_per_owner`, `share_link_reserved_aliases`.

## Decisions
- No PostgreSQL table: the click event is best effort and published off the request path, so there is no dual write to protect.
- The filter entry is written before the link, so a crash can leave a stray entry but never a hidden link.
- Statistics count distinct click ids at read time, so a redelivered event never inflates them before a merge.
- The owner's place is reserved by a conditional counter update in the same step as the link, not by counting afterwards.

## Known gaps
- The capacity criteria (SC-001, SC-002, SC-004 at the 99th percentile, SC-006) have no automated proof (listed in `specs/UNVERIFIED.md`).
- The consumer framework skips an event type it does not handle instead of dead-lettering it.
- The platform's problem catalog gives `service_unavailable` the wording of whoever registered it first; the share-link code raises it with its own detail but a 5xx body shows the catalog's.
- The UI journey (AS-66) belongs to W02.
