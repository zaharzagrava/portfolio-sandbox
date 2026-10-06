# Test Plan: S41 — Competitor Price Monitor (domain `seller-insights`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (57 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/seller-insights/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `CompetitorsModule` (core), `CrawlerWorkerModule` and the competitor projector module with the production prefix, `ValidationPipe`, problem+json filter and interceptors, through `supertest`, against real Postgres, Redis, the Kafka stand-in, MinIO and ClickHouse with real migrations (`docker-compose.test.yaml`). Time is frozen at `T0 = 2026-10-06T12:00:00Z`.
  - `competitor-watches.e2e-spec.ts` — describe "Competitor monitor: watches API (registration, limits, isolation, history)"
  - `competitor-crawl.e2e-spec.ts` — describe "Competitor monitor: polite and SSRF-safe crawling (frontier, robots, limits)"
  - `competitor-pricing.e2e-spec.ts` — describe "Competitor monitor: price observation, change detection and failure handling"
  - `competitor-alerts.e2e-spec.ts` — describe "Competitor monitor: price-drop alerts (events, atomicity, replay)"
  - `competitor-reactions.e2e-spec.ts` — describe "Competitor monitor: shop and product events, retention, operability"
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): `robots.spec.ts` (AS-19), `extract-price.spec.ts` (AS-33), `simhash.spec.ts` (AS-36, with `fast-check`), `url.spec.ts` (AS-40, with `fast-check` for idempotence). The address-class table of the guard itself is S54's `libs/infrastructure/net/ssrf-guard.spec.ts` (existing, not a row here); AS-05 and AS-26 prove it through the capability's real entry points. Controllers, repositories, the frontier, jobs and projectors get no unit tests.
- Fixtures: shops, products and memberships are created only through the shared fixture helpers and the exported services of tenancy and catalog (no spec injects `ProductModel`, `ShopModel` or `ShopMembershipModel`, D-7); shop and product events are built with the event factories of `packages/contracts` and handed to the real consumers. The competitor site is a local fixture server per spec (configurable robots file, delays, statuses, redirects, slow bodies, a concurrency counter) reached through the fixture-host allowlist and a resolver double; `rival.test`, `other.test`, `a.test`, `b.test`, `c.test` resolve to loopback fixture servers. Every test asserts the response body **and** the persisted state (target and watch rows, history rows, archive objects, outbox rows, frontier and cache keys with their TTLs, dead letters, metrics).
- Only system edges are faked: identity token verification, the clock, the resolver, and fault injection on a store (VII.9). Postgres, Redis, ClickHouse and object storage are real. Notification delivery is not part of this capability: alerts are asserted as outbox rows.
- Consumers have the duplicate-delivery and invalid-payload tests of VII.4: the shop and product consumers run AS-51 and AS-52 (duplicates, out of order) and AS-53 (invalid payloads).
- UI journey (Playwright): owned by the web capability that builds the competitor screen (none exists yet), `packages/web/e2e/competitor-monitor.spec.ts` — one happy path: a seller opens a product, adds a competitor URL, sees the watch in the list, and after a crawl sees the price chart with the competitor's price. It never repeats an edge case from this plan.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-57).
- Gate 9 (VII.9): AS-10 (limiter store down), AS-15 (history store down), AS-17 (fast store emptied, worker death), AS-20 (robots unavailable), AS-41 (history and archive faults), AS-48 (outbox fault), AS-30 (shutdown) each force their fault.
- Concurrency tests use `Promise.all` and assert the invariant (VII.3): AS-09, AS-13 (delete racing a crawl), AS-23, AS-42, AS-47.
- Load (not a CI gate): SC-007 is checked by a script under `packages/backend/scripts/load-tests/` against the fixture fleet.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create | `competitor-watches.e2e-spec.ts`: Stan registers with the noisy URL; `201` body parsed by the contracts schema; one target and one watch; no request to the fixture | web journey step "add a competitor URL" | — |
| AS-02 idempotent replay and equivalent spellings | `competitor-watches.e2e-spec.ts`: same body and `fbclid` variant `200` same id, counts unchanged; second URL `201` | — | — |
| AS-03 one target for many shops | `competitor-watches.e2e-spec.ts`: Bo watches `U1`; one target row, two watches, `nextCheckAt` unchanged | — | — |
| AS-04 validation | `competitor-watches.e2e-spec.ts`: each invalid class `400 validation_failed` with field errors, nothing stored | — | — |
| AS-05 SSRF and policy refusal at registration | `competitor-watches.e2e-spec.ts`: one case per address class and port through the resolver double, `422 url_not_allowed` with generic detail, `422 url_unresolvable`, public accepted | — | — |
| AS-06 product ownership | `competitor-watches.e2e-spec.ts`: `PB` and random UUID byte-identical `404 product_not_found`, `PX` `409 product_archived` | — | — |
| AS-07 tenant isolation and permissions | `competitor-watches.e2e-spec.ts`: Bo, malformed and unknown shop ids identical `404 shop_not_found` on the four routes; Vic `403`/`200`; `D` `403 shop_suspended`; foreign watch id `404 watch_not_found`; `401` | — | — |
| AS-08 limits | `competitor-watches.e2e-spec.ts`: 5th ok, 6th `422 watch_limit_reached` (shop and product scope), shop `C` limit 0, replay at limit `200`, entitlement fault `503` | — | — |
| AS-09 concurrency | `competitor-watches.e2e-spec.ts`: 10 identical posts one `201`; 3 distinct posts at limit 4 → one `201` | — | — |
| AS-10 rate limit | `competitor-watches.e2e-spec.ts`: 31st write `429` with `Retry-After`, shop B unaffected, limiter store down writes `503` reads `200` | — | — |
| AS-11 a re-registration never forces a fetch | `competitor-watches.e2e-spec.ts`: three `lastCheckedAt` cases, 100 re-registrations make the target due once per hour | — | — |
| AS-12 list | `competitor-watches.e2e-spec.ts`: 7 watches paged by 3 with an insert in between, filter, limits, invalid params, no foreign items | web journey step "the watch is listed" | — |
| AS-13 remove | `competitor-watches.e2e-spec.ts`: delete, replay `404`, last watcher retires the target (not scheduled, queued entry dropped without a request), delete racing a crawl | — | — |
| AS-14 price history | `competitor-watches.e2e-spec.ts`: three observations, `days=30/7`, empty, invalid `days`, 1000-point cap | web journey step "the price chart shows the competitor's price" | — |
| AS-15 analytics store down | `competitor-watches.e2e-spec.ts`: history `503 history_unavailable` within 3 s, list `200` with `lastPriceMinor` | — | — |
| AS-16 scheduling | `competitor-crawl.e2e-spec.ts`: four due targets queued once, second run none, stale mark requeued, cap 2 by plan order, retired and paused targets skipped | — | — |
| AS-17 the frontier is rebuildable | `competitor-crawl.e2e-spec.ts`: empty the fast store, next cycle requeues; a worker that dies holding a lease, target crawled again within 15 min of due | — | — |
| AS-18 robots disallow | `competitor-crawl.e2e-spec.ts`: only `/robots.txt` requested, `disallowed_by_robots`, `nextCheckAt +24 h`, no observation | — | — |
| AS-19 robots rules | — | — | `robots.spec.ts`: `it.each` over group choice, token matching, longest match, ties, `*`/`$`, empty values, case, comments, BOM, CRLF, `Crawl-delay`, 500 KiB limit |
| AS-20 robots fetch outcomes | `competitor-crawl.e2e-spec.ts`: `200/404/410/403/500/503`, reset, slow body, cross-origin redirect: page fetched or not, cache TTLs 24 h/1 h/15 min, `robots_unavailable` and `+1 h` | — | — |
| AS-21 robots cache is fleet-wide | `competitor-crawl.e2e-spec.ts`: two instances one robots request, refetch after 24 h, rule change effective, key includes port | — | — |
| AS-22 Crawl-delay | `competitor-crawl.e2e-spec.ts`: gap ≥ 2 s with `Crawl-delay: 2`, ≥ 1 s without, 86400 capped at 300 s, invalid value default | — | — |
| AS-23 one in-flight request per host, fleet-wide | `competitor-crawl.e2e-spec.ts`: two instances × 16 loops, ten targets on one host and three on three others; concurrency counter max 1 per host, ≥ 3 overall, all 19 crawled | — | — |
| AS-24 back-off | `competitor-crawl.e2e-spec.ts`: `429`, `503`, `429` with `Retry-After` 120 and 99999: host wait, statuses, `nextCheckAt +6 h`, price untouched | — | — |
| AS-25 an identifiable, minimal client | `competitor-crawl.e2e-spec.ts`: fixture records headers of page and robots requests | — | — |
| AS-26 SSRF at crawl time | `competitor-crawl.e2e-spec.ts`: host re-resolved to loopback → `blocked_address`, no request; resolver flipping after the check → request goes to the checked address; IPv6 and mapped refused | — | — |
| AS-27 redirects | `competitor-crawl.e2e-spec.ts`: six redirect shapes with statuses and no request to the forbidden target | — | — |
| AS-28 fetch limits | `competitor-crawl.e2e-spec.ts`: 5 MiB cut at 2 MiB with `truncated`, PDF/PNG refused after headers, 1 byte/s and no-answer end at 10 s, whole crawl ≤ 30 s, lease released, 9 s page ok | — | — |
| AS-29 status mapping | `competitor-crawl.e2e-spec.ts`: `it.each` over 404/410/401/403/other 4xx/500/502/504/reset/timeout/DNS failure: `lastStatus`, interval, price and counter untouched | — | — |
| AS-30 graceful shutdown | `competitor-crawl.e2e-spec.ts`: stop with in-flight fetches, no new take, lease released, abandoned target crawled again | — | — |
| AS-31 seen-set | `competitor-crawl.e2e-spec.ts`: new, repeat, forced false positive (new URL still created and crawled), emptied set unchanged, counters | — | — |
| AS-32 first observation | `competitor-pricing.e2e-spec.ts`: target state, jittered `nextCheckAt`, one history row, one archive object with date/host/id key, counter 1 | — | — |
| AS-33 extraction rules | — | — | `extract-price.spec.ts`: `it.each` over JSON-LD shapes, decimal and exponent cases (`1.005`, `19.99`, JPY, KWD), rejected formats, currency rules, availability, mixed currency, node order, malformed/CDATA/comment, meta fallback in any attribute order, free text never |
| AS-34 a one-token price change is not missed | `competitor-pricing.e2e-spec.ts`: `899` → `1099`: second row, counter 2, status `ok` | — | — |
| AS-35 unchanged page backs off | `competitor-pricing.e2e-spec.ts`: ladder 12/24/48/48 h with jitter bounds, no row, no archive, reset after a change | — | — |
| AS-36 SimHash | — | — | `simhash.spec.ts`: determinism, widget within bits, unrelated page far, degenerate texts, `fast-check` symmetry, identity and triangle |
| AS-37 page changed, price not | `competitor-pricing.e2e-spec.ts`: archived, streak reset, no row, counter unchanged, 6 h | — | — |
| AS-38 no price | `competitor-pricing.e2e-spec.ts`: `no_price` and `out_of_stock` keep the last price, no event, archive once per fingerprint, 24 h after three | — | — |
| AS-39 currency change | `competitor-pricing.e2e-spec.ts`: `EUR` → `USD` observation, counter +1, history `lowestMinor` in the latest currency | — | — |
| AS-40 URL normalisation | — | — | `url.spec.ts`: `it.each` over each rule and refusal, `fast-check` idempotence |
| AS-41 a failing store never loses or invents a price | `competitor-pricing.e2e-spec.ts`: history store down → state untouched, `history_unavailable`, retry +15 min, one row on recovery with the dedup token; object storage down → observation kept, `archive_failed` | — | — |
| AS-42 two workers on one target | `competitor-pricing.e2e-spec.ts`: expired lease, two crawls at once: one observation, one history row, one event per owner, second update a no-op | — | — |
| AS-43 undercut, one event per owner | `competitor-alerts.e2e-spec.ts`: two owner rows with exact envelope and payload parsed by the contracts schema, deterministic `eventId`, no path or query, staff and viewer not alerted | — | — |
| AS-44 no alert when not undercut | `competitor-alerts.e2e-spec.ts`: higher and equal price, observation recorded, no outbox row | — | — |
| AS-45 an alert per new drop | `competitor-alerts.e2e-spec.ts`: sequence `89900, 84900, 95000, 90000, 120000, 125000`: events only for `84900` and `90000`, `priceVersion` 2 and 4 | — | — |
| AS-46 comparison basis | `competitor-alerts.e2e-spec.ts`: USD vs EUR `currency_mismatch`, archived/deleted `product_unavailable`, price read at evaluation, no re-evaluation on a product price change | — | — |
| AS-47 several watchers of one target | `competitor-alerts.e2e-spec.ts`: A and B at 89900 and 80000, 1200 watches in batches of 500, no event twice | — | — |
| AS-48 atomic and replay-safe | `competitor-alerts.e2e-spec.ts`: outbox trigger fault rolls everything back, retry writes once; re-run of the same observation writes no second row | — | — |
| AS-49 a new watch is evaluated at once | `competitor-alerts.e2e-spec.ts`: registration against an observed target writes events in the same transaction, none when not undercut, replay none | — | — |
| AS-50 no recipient, paused shops | `competitor-alerts.e2e-spec.ts`: shop without owners `no_recipient` with a warning; suspended shop never crawled or evaluated | — | — |
| AS-51 shop events | `competitor-reactions.e2e-spec.ts`: suspend/reinstate, orders 4-3-4-3, stale ignored, plan change reorders, `shop_deleted` erases twice, event before `shop_created` | — | — |
| AS-52 product deleted | `competitor-reactions.e2e-spec.ts`: watches of `PA` removed once, `PA2` kept, unwatched product acknowledged | — | — |
| AS-53 invalid payloads | `competitor-reactions.e2e-spec.ts`: each bad message dead-lettered with a reason and no change, next valid applied, foreign type ignored | — | — |
| AS-54 retention | `competitor-reactions.e2e-spec.ts`: purge twice and concurrently, bucket lifecycle and table retention asserted | — | — |
| AS-55 observability | `competitor-reactions.e2e-spec.ts`: counters and gauges after each crawl outcome, log lines carry `targetId` and `host` and never the URL, query or body | — | — |
| AS-56 configuration | `competitor-reactions.e2e-spec.ts`: boot with each invalid setting (including the fixture allowlist in production) fails naming the key; valid values start | — | — |
| AS-57 table ownership and boundaries | static gate: `check:table-ownership --strict`, `check:boundaries`, registry entries (`db/ownership.ts`), no FK in the migrations | — | — |
