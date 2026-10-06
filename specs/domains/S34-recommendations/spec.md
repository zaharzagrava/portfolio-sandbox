# Feature Specification: S34 — "Bought Together" Recommendations (Co-occurrence Graph, Popularity Normalisation, 2-Hop Cold Start) (domain `discovery`)

**Feature Branch**: `S34-recommendations` (spec directory `specs/domains/S34-recommendations`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S34 of `scripts/sdd/capabilities.tsv`. Source: `docs/showcase/sections/X-01-graph-recommendations.md` (Interview-Prep upstream copy; the notes win over the code). Pattern map row **P1111** (BFS with decay, 2-hop). Contracts honoured from `specs/domains/S10-cart-checkout/spec.md` (`order.paid`), `specs/domains/S05-products/spec.md` (`getProductsByIds`), `specs/domains/S03-shops-rbac/spec.md` (`getShopsByIds`), and the scope notes of S32 and S33.

## Scope

Everything a **buyer** sees in the "Frequently bought together" rail of a product page, and the machinery that keeps it relevant, fast and safe:

- **Basket capture**: every paid order becomes one basket of distinct products, recorded once however often the paid event is delivered.
- **Co-occurrence graph**: products that were bought in the same order are linked; a link is trusted only when enough orders **and** enough different buyers support it.
- **Popularity normalisation**: link strength is cosine similarity, so a product that sits in almost every basket (the hub) does not appear next to everything.
- **Nightly build**: a bounded, restartable, single-run job turns the baskets of the last 180 days into the top 20 neighbours of every product and publishes each list atomically.
- **Read endpoint**: `GET /api/products/:productId/recommendations`, anonymous, CDN-cacheable, answering from the precomputed lists with a visibility check (only products a buyer can actually buy).
- **2-hop cold start**: a product with few direct neighbours is filled from the neighbours of its best neighbours, with a decayed score, in one bounded round trip.
- **Platform**: validation, rate limit, cache headers, problem+json errors, timeouts and graceful failure, metrics, configuration validation, module boundary.

Out of scope (owners named):

- "Customers who viewed this also viewed": needs `product.viewed` events; postponed (DOUBTS Q42). The `type` parameter exists so it can be added later; today only `bought-together` is accepted.
- Personalised recommendations (by buyer history), re-ranking by margin or sponsorship (sponsored slots → **S36**), cart-page and email recommendations.
- The product page, the rail's rendering and the GraphQL / aggregated product-page endpoints → **W02** (UI) and **S48** (BFF composition, IX.7 R2). This spec states what they must do to use the endpoint correctly (Provides) and has one happy-path UI scenario (AS-48) and one composition-boundary scenario (AS-49).
- The order lifecycle and the `order.paid` event → **S10**. Product facts and stock → **S05**. Shop status → **S03**. Search, autocomplete, trending → **S32**, **S33**, **S35** (same domain, separate capabilities).
- Rate-limit registry → **S50**. Scheduled-job engine → **S49**. Problem+json filter, metrics registry, config validation, request context → **S54**. CDN rules honouring the cache headers below → operations artifact.
- Postgres tables: `discovery` owns none (domain-map). The basket store, the neighbour lists and the build bookkeeping are this capability's own non-Postgres stores.

## User Scenarios & Testing *(mandatory)*

Notation: `P`, `M`, `C`, `K`, `S` are products (`P` = "iPhone 17", the hub; `M` = "MagSafe Charger"; `C` = "iPhone 17 Case"; `K` = "USB-C Cable"; `S` = "Charging Stand"), all `ACTIVE`, non-sandbox, in stock, in `ACTIVE` shops, unless a scenario says otherwise. `ANON` is an unauthenticated caller. "The lists" are the precomputed neighbour lists. "Distinct buyers" are distinct `userId` values of paid orders.

**Dataset D** (used by AS-01, AS-13, AS-14, AS-22, AS-23). Every basket is a separate paid order inside the window; the buyers of the orders of one group are all different.

| Group | Baskets |
|---|---|
| g1 | 6 orders of `{P, M}` |
| g2 | 40 orders of `{P, K}` |
| g3 | 40 orders of `{P, C}` |
| g4 | 5 orders of `{M, C}` |
| g5 | 2 orders of `{M, S}` |
| g6 | 3 orders of `{K, S}` |

Order counts: `n(P)=86`, `n(M)=13`, `n(C)=45`, `n(K)=43`, `n(S)=5`. Pairs with ≥ 3 co-orders: `P–M` (6), `P–K` (40), `P–C` (40), `M–C` (5), `K–S` (3); `M–S` (2) is dropped. Cosine `co / sqrt(n_a · n_b)`: `P–K` 0.6578, `P–C` 0.6430, `M–C` 0.2067, `K–S` 0.2046, `P–M` 0.1794. Lists after the build: `P → [K 0.6578, C 0.6430, M 0.1794]`; `M → [C 0.2067, P 0.1794]`; `C → [P 0.6430, M 0.2067]`; `K → [P 0.6578, S 0.2046]`; `S → [K 0.2046]`.

### User Story 1 - See what other buyers bought with this product (Priority: P1)

A buyer opens the product page of the MagSafe Charger. Under the product they see "Frequently bought together": first the iPhone 17 Case (bought with the charger by a tight group of buyers), then the iPhone 17. The iPhone, although far more often in baskets, does not crowd out the closer match. Everything shown can be bought right now.

**Why this priority**: this is the capability; without it the rail is empty.

**Independent Test**: seed the paid orders of dataset D, run the build, call the endpoint for `M`.

**Acceptance Scenarios**:

1. **AS-01** (happy path) — **Given** dataset D has been built and all five products are visible, **When** `ANON` calls `GET /api/products/{M}/recommendations`, **Then** `200` with `{type: "bought-together", items: [{productId: C, title: "iPhone 17 Case", priceMinor, currency, score: 0.2067, hops: 1}, {productId: P, title: "iPhone 17", priceMinor, currency, score: 0.1794, hops: 1}]}`, header `Cache-Control: public, max-age=60, s-maxage=300`, no `Set-Cookie`, the body parses with `recommendationsResponseSchema`, and the stored lists are unchanged by the call (a `GET` changes no state).
2. **AS-02** (order and replay) — **Given** product `X` whose list holds `Y`, `Z`, `W` all with score 0.5 and `V` with 0.7, **When** `limit` is omitted and the call is made twice, **Then** both bodies are byte-identical, ordered by score descending and equal scores by `productId` ascending: `V` first, then `W`, `Y`, `Z` in ascending order of their IDs.
3. **AS-03** (limit) — **When** `limit` is omitted, **Then** at most 8 items; `limit=3` returns at most 3 (the best three); `limit=20` is accepted; `limit=0`, `limit=21`, `limit=-1`, `limit=abc`, `limit=2.5`, `limit=` each answer `400` (AS-05 shape).
4. **AS-04** (type) — **When** `type` is omitted or `type=bought-together`, **Then** the answers are identical; **When** `type=also-viewed` or `type=anything`, **Then** `400` `validation_failed` with `errors: [{field: "type", message}]` and no store is consulted.
5. **AS-05** (validation) — **When** `productId` is not a UUID, `limit` is invalid (AS-03), or an unknown query parameter `foo=1` is sent, **Then** `400` `application/problem+json` with `type`, `title`, `status: 400`, `detail`, `instance`, `requestId`, `code: "validation_failed"` and `errors: [{field, message}]` naming the offending parameter; nothing is clamped silently and no store is consulted.
6. **AS-06** (unknown or hidden product → 404) — **When** the product does not exist, or is archived, a sandbox product, or belongs to a `SUSPENDED`, `DELETING` or `DELETED` shop, **Then** each answers the identical `404` problem+json `code: "product_not_found"` with `Cache-Control: no-store`; the body does not say which of the cases applies.
7. **AS-07** (same answer for every caller) — **When** `ANON`, a signed-in buyer, a signed-in seller of another shop, and a caller with an invalid or expired bearer token request the same product, **Then** the four `200` bodies are identical (an invalid token is ignored, not a `401`), no `Set-Cookie` and no `Vary: Cookie` or `Vary: Authorization` is sent, and neither the request log lines nor the metrics labels contain a buyer identifier (the endpoint has none).
8. **AS-08** (rate limit) — **Given** policy `discovery.recommendations` allows 600 requests per minute per address, **When** one address sends 601 requests within one minute, **Then** the 601st answers `429` problem+json `code: "rate_limited"` with `Retry-After` (whole seconds ≥ 1) and `Cache-Control: no-store`; **When** the rate-limit store is unavailable, **Then** every request answers `200` (fail open).
9. **AS-09** (errors are never cached) — **When** any `400`, `404`, `429` or `503` is produced, **Then** it carries `Cache-Control: no-store` and the problem+json body of AS-05.

---

### User Story 2 - Only products I can buy right now (Priority: P1)

The nightly lists are a day old. Between the build and my page view a product may sell out, be archived, or its shop may be suspended. I must never be shown such a product, and the rail should still be as full as it can be.

**Why this priority**: showing unbuyable products erodes trust and wastes the most valuable slot on the page.

**Independent Test**: build the lists, change product and shop state, call the endpoint.

**Acceptance Scenarios**:

1. **AS-10** (hidden neighbours are dropped and replaced) — **Given** the list of `X` holds ten neighbours `N1…N10` by score, of which `N1` is out of stock, `N2` archived, `N3` a sandbox product, `N4` of a suspended shop and `N5` unknown to the catalog (deleted), **When** `limit=4`, **Then** `200` with `N6, N7, N8, N9` (the next visible candidates), in score order; none of `N1…N5` appears; the product facts come from one batched lookup of the whole candidate pool and the shop facts from one batched lookup (no per-row calls).
2. **AS-11** (fewer than asked, or none) — **Given** `X` has two visible neighbours and `limit=8`, **Then** `200` with exactly those two (the list is not padded); **Given** `Y` has a list whose neighbours are all hidden, **Then** `200 {type: "bought-together", items: []}` with the same `Cache-Control` as AS-01.
3. **AS-12** (a stock change is seen within the cache window) — **Given** `C` is a neighbour of `M` and goes out of stock after the build, **When** `M` is requested at origin, **Then** `C` is absent immediately (the visibility check runs on every origin request); a CDN copy may keep it for at most `s-maxage` (300 s), which is the accepted staleness.

---

### User Story 3 - A new or niche product still gets a rail (Priority: P1)

A product with a single known partner (the Charging Stand, bought with the cable by three buyers) would show a one-item rail. Instead the rail also shows products bought with *its partner*, ranked lower and marked as indirect.

**Why this priority**: cold-start products are exactly where a rail helps sellers most. This is pattern P1111 (BFS with decay, depth 2).

**Independent Test**: dataset D, product `S`.

**Acceptance Scenarios**:

1. **AS-13** (2-hop expansion) — **Given** dataset D built, **When** `GET /products/{S}/recommendations` (default `limit` 8; `S` has 1 direct neighbour, fewer than the limit), **Then** `200` with items `[{K, score: 0.2046, hops: 1}, {P, score: 0.0673, hops: 2}]` (`P` = 0.2046 × 0.6578 × 0.5); `S` itself is never listed.
2. **AS-14** (hub filled by expansion) — **Given** dataset D, **When** `GET /products/{P}/recommendations`, **Then** items `[{K, 0.6578, 1}, {C, 0.6430, 1}, {M, 0.1794, 1}, {S, 0.0673, 2}]` (`P` has 3 direct neighbours < 8, so expansion ran over `K`, `C`, `M`; `S` comes only from `K`; `M` and `C` reached through each other stay `hops: 1`).
3. **AS-15** (expansion is bounded) — **Given** `X` with 7 direct neighbours `N1…N7` (scores descending) and `limit=20`, **When** requested, **Then** the neighbour lists of exactly `N1…N5` (the top 5) are read, in one round trip together with each other (spy: at most 1 + 5 list reads, issued as one batch), the lists of `N6`, `N7` are not read, and no third hop is taken.
4. **AS-16** (no expansion when the direct list is enough) — **Given** `X` with 8 direct neighbours and `limit=8`, **When** requested, **Then** all items have `hops: 1` and only the one list of `X` was read (spy: 1 list read).
5. **AS-17** (best path wins, direct wins over indirect) — **Given** `X → [Y 0.9, Z 0.8]` (direct), `Y → [W 0.6, Z 0.5, X 0.9]`, `Z → [W 0.8, X 0.8]`, `limit=8`, **When** requested, **Then** `W` appears once with score `max(0.9×0.6×0.5, 0.8×0.8×0.5) = 0.32` and `hops: 2`; `Z` stays direct with `0.8` and `hops: 1` (its 2-hop path score 0.9×0.5×0.5 = 0.225 is ignored); `X` is never listed.
6. **AS-18** (direct neighbours always precede indirect ones) — **Given** `X → [Y 0.9, Z 0.2]`, `Y → [W 0.8, X 0.9]`, `limit=8`, **When** requested, **Then** the order is `Y (1, 0.9)`, `Z (1, 0.2)`, `W (2, 0.36)`; the indirect `W` ranks below the weaker direct `Z` although its score is higher.
7. **AS-19** (a hidden neighbour still bridges) — **Given** `X → [Y 0.9]`, `Y → [W 0.8, X 0.9]`, `Y` out of stock, **When** requested, **Then** items `[{W, 0.36, 2}]`; `Y` itself is not shown.
8. **AS-20** (product with no edges) — **Given** a visible product with no list (new product, or no qualifying pair), **When** requested, **Then** `200 {type: "bought-together", items: []}`; no second-hop reads happen (spy: 1 list read).
9. **AS-21** (damaged list entries) — **Given** the list of `X` contains a member that is not a UUID, a member equal to `X`, and scores that are not numbers, negative, or greater than 1, next to two valid entries, **When** requested, **Then** `200` with only the two valid entries; the bad entries are skipped and counted in a metric; no `500`.

---

### User Story 4 - A hub product does not appear next to everything (Priority: P1)

Normalisation. The iPhone is in 86 of the baskets; if raw co-occurrence were used it would be the top suggestion for every accessory. Cosine similarity divides popularity out so the genuinely tight pair ranks first.

**Why this priority**: raw counts make the rail useless (the same product everywhere).

**Independent Test**: build dataset D, read the stored lists.

**Acceptance Scenarios**:

1. **AS-22** (cosine beats raw popularity) — **Given** dataset D, **When** the build runs, **Then** the list of `M` is `[C 0.2067, P 0.1794]` although `P–M` has 6 co-orders and `M–C` only 5; scores equal `co / sqrt(n_a · n_b)` where `n` is the number of eligible baskets of the product in the window (all the baskets of the product, not only those that formed a qualifying pair).
2. **AS-23** (noise threshold) — **Given** dataset D, **Then** `M–S` (2 co-orders) appears in neither list (`M` has no `S`, `S` has no `M`), while `K–S` (exactly 3) appears in both.
3. **AS-24** (a pair needs different buyers) — **Given** pair `A–B` with 5 co-orders all paid by the same buyer, and pair `A–D` with 3 co-orders paid by 3 different buyers, **When** the build runs, **Then** `A`'s list holds `D` but not `B`; **When** a 4th order of `A–B` by a second buyer is added (still only 2 buyers), **Then** `B` is still absent; **When** a third buyer is added, **Then** `B` appears. (Prevents one account from manufacturing a recommendation and exposing one buyer's habits.)
4. **AS-25** (symmetry) — **Given** any qualifying pair `(a, b)`, **Then** `a`'s list holds `b` and `b`'s list holds `a` with the identical score, unless one of them lost the pair to its top-20 cap (AS-27).
5. **AS-26** (the window) — **Given** `window = 180` days and orders of `A–B` paid 179 days and 181 days ago, **When** the build runs, **Then** only the 179-day orders count, both for the co-order counts and for `n(A)`, `n(B)`; orders on the boundary day follow the rule "paid at or after `now − 180 days`".
6. **AS-27** (top-20 cap and ties) — **Given** `A` with 25 qualifying neighbours (several with equal scores), **When** the build runs, **Then** its list holds exactly the 20 best by score descending, equal scores broken by `productId` ascending, so the cut is deterministic.
7. **AS-28** (the result does not depend on the bucket count) — **When** the build runs with `buckets = 1`, `4` and `16` over the same baskets, **Then** the lists and the result counters (`products`, `edges`) are identical.

---

### User Story 5 - Every paid order feeds the graph exactly once (Priority: P1)

When an order is paid, the basket of its distinct products is recorded for the next build. A redelivered or reordered message never double-counts, a malformed message never poisons the stream.

**Why this priority**: double counting inflates edges and defeats the thresholds; a poison message would stall every later basket.

**Independent Test**: publish `order.paid` messages to the orders topic and inspect the baskets.

**Acceptance Scenarios**:

1. **AS-29** (a paid order becomes a basket) — **Given** `order.paid` `{orderId, userId, paidAt, lines: [{productId: M}, {productId: C}, {productId: M}], orderVersion: 3}` (the line for `M` repeated, e.g. two variants), **When** it is consumed, **Then** exactly one basket exists for `orderId` with `products = [C, M]` (distinct, sorted), `buyerId = userId`, `paidAt`, `orderVersion: 3`.
2. **AS-30** (duplicate delivery) — **When** the same message is delivered twice (also concurrently, `Promise.all`), **Then** one basket exists and the co-order counts of the next build are unchanged by the second delivery.
3. **AS-31** (invalid payload) — **When** a message has a missing `orderId`, a non-UUID `productId`, empty `lines`, a missing `userId`, an unknown envelope `version`, or is not JSON, **Then** it is rejected to the dead-letter path with the reason, no basket is written, and the next valid message is processed normally.
4. **AS-32** (other event types are ignored) — **When** `order.reserved`, `order.cancelled`, `order.refunded` or `order.fulfilment_changed` arrive on the topic, **Then** no basket is written, none is changed, and none is dead-lettered (they are valid, just not this projector's).
5. **AS-33** (basket size rule) — **When** orders with 1 distinct product (also 3 lines of the same product), 2 distinct products, 30 distinct products and 31 distinct products are consumed, **Then** baskets exist for the 2- and 30-product orders only; the others are skipped and counted in a metric by reason (`too_small`, `too_large`); a skipped order is not dead-lettered.
6. **AS-34** (late and out-of-order delivery) — **Given** orders `O1` (paid yesterday) and `O2` (paid today) delivered in reverse order, after the nightly build already ran, **Then** both baskets are stored, the lists are unchanged until the next build, and the next build counts both exactly once regardless of the arrival order; **Given** an `order.paid` whose `paidAt` is older than the window, **Then** it is stored but never counted; **Given** a redelivery of the same `orderId` with a higher `orderVersion`, **Then** the basket takes the newer lines; **with a lower or equal `orderVersion`**, **Then** the stored basket is unchanged.
7. **AS-35** (replay) — **Given** the topic is replayed from the beginning into an empty basket store, **Then** the baskets and the next build's lists equal those produced by the original run (the projection is rebuildable, IX.8).

---

### User Story 6 - The nightly build is safe to run, rerun and interrupt (Priority: P1)

Operators rely on one build a night that never publishes a half-written list, never wipes the rail because the source was empty, and never runs twice at once.

**Why this priority**: a bad build silently degrades every product page.

**Independent Test**: drive the real job handler against seeded baskets and the real list store.

**Acceptance Scenarios**:

1. **AS-36** (idempotent rerun) — **Given** unchanged baskets, **When** the build runs twice, **Then** the lists and the result `{products, edges, removed}` are identical both times.
2. **AS-37** (a list is replaced atomically) — **Given** a product whose list changes in the build, **When** the endpoint is called continuously (50 concurrent readers) while the build writes it, **Then** every answer shows either the complete old list or the complete new list, never an empty or partial list.
3. **AS-38** (a product that lost all edges) — **Given** `A` had a list yesterday and today has no qualifying pair, **When** a complete successful build finishes, **Then** `A` has no list (requests answer `items: []`) and the result reports it in `removed`; **Given** the build fails midway, **Then** no list is removed.
4. **AS-39** (an empty source never wipes the rail) — **Given** zero eligible baskets in the window (e.g. the basket store was lost or returned nothing), **When** the build runs, **Then** it ends with `{outcome: "skipped_empty"}`, writes and removes nothing, and raises the `recommendations_build_skipped_total{reason="empty"}` metric.
5. **AS-40** (failure leaves valid data) — **Given** the source query fails while processing bucket 3 of 4, **Then** the job fails (the scheduler retries it, S49), every list already written is a complete list of the new build, lists not yet reached keep their previous content, nothing is deleted, and `recommendations_build_last_success_timestamp` is not advanced.
6. **AS-41** (one build at a time) — **When** two invocations of the build run at the same moment (`Promise.all`), **Then** exactly one does the work and the other returns `{outcome: "skipped_locked"}` without writing; the final lists equal those of a single run. **When** the lock holder crashes, **Then** the lock expires by itself after the lease (1 hour) and the next run proceeds.
7. **AS-42** (parameters are validated) — **When** the job payload has `days = 0`, `days = 391`, `days = 1.5`, `buckets = 0`, `buckets = 257`, or an unknown key, **Then** it fails validation without reading baskets or writing lists; **When** the payload is empty, **Then** defaults `days = 180`, `buckets = 16` apply.
8. **AS-43** (lists expire) — **Given** time frozen, a list written by a build, **When** 3 days have passed (less 1 second), **Then** it is served; **When** 3 days and 1 second have passed with no new build, **Then** the endpoint answers `items: []` (a stale rail is withdrawn rather than shown indefinitely).
9. **AS-44** (scheduled once) — **When** two worker instances start, **Then** exactly one schedule `recommendations.build-bought-together` with cron `17 3 * * *` exists; **When** a worker restarts, **Then** it is not duplicated.

---

### User Story 7 - The rail degrades gracefully and is observable (Priority: P2)

If the lists or the product lookups are down, the product page still loads (the rail is an optional section); operators can see build freshness and request outcomes.

**Why this priority**: the rail must never take the product page down, and an unnoticed stale graph is invisible harm.

**Acceptance Scenarios**:

1. **AS-45** (list store unavailable or slow) — **When** the list store is down, or does not answer within 100 ms, **Then** `503` problem+json `code: "recommendations_unavailable"`, generic `detail`, `Cache-Control: no-store`, `Retry-After: 5`; no stack trace, host name or key name in the body; the outcome counter `recommendations_requests_total{result="unavailable"}` rises by one; no retry happens inside the request.
2. **AS-46** (product or shop lookup fails or is slow) — **When** the batched product lookup (R1) does not answer within 100 ms or throws, or the shop lookup does not answer within 50 ms or throws, **Then** the same `503` as AS-45; the request never returns unfiltered candidates ("show unverified products" is worse than "show nothing").
3. **AS-47** (metrics and logs) — **When** requests, a build and a consumed message happen, **Then** the following exist and are asserted: `recommendations_requests_total{result="ok|empty|not_found|unavailable|invalid"}`, `recommendations_hops_total{hops="1|2"}`, `recommendations_bad_entries_total`, `recommendations_basket_skipped_total{reason}`, `recommendations_baskets_total{outcome="stored|duplicate|stale"}`, `recommendations_build_duration_seconds`, `recommendations_build_products`, `recommendations_build_edges`, `recommendations_build_last_success_timestamp`, `recommendations_build_skipped_total{reason="empty|locked"}`; log lines are structured, carry `requestId` / `traceId`, and contain no buyer identifiers or order contents; a request has a bounded set of label values (no product IDs as labels).

---

### User Story 8 - The product page shows the rail (Priority: P2, owned by W02 and S48)

**Acceptance Scenarios**:

1. **AS-48** (UI happy path) — **Given** dataset D built and visible products, **When** a buyer opens the product page of `M`, **Then** the section "Frequently bought together" shows the cards `iPhone 17 Case` then `iPhone 17`, each with its title and price formatted from `priceMinor` / `currency`, each linking to its product page; **When** the product has no recommendations, **Then** the section is not rendered (no empty heading).
2. **AS-49** (composition: IX.7 R2, listed for traceability, owned by S48) — **Given** the aggregated product-page composition calls `GET /products/:id/recommendations?limit=8` with a 300 ms budget as an optional section, **When** the recommendations API is stubbed to answer after 500 ms, or with `503`, or with `404`, **Then** the composed page still answers with the other sections intact, `recommendations: null` and an entry for `recommendations` in its partial-error list, in less than the sum of the per-call delays; **When** the stub answers a body that does not match `recommendationsResponseSchema`, **Then** the same partial result (responses are validated, X.8.2).

---

### Unit-tested pure rules (listed for traceability, VII.5)

Each is proven by the scenario named, at the unit layer (see `test-plan.md`): ranking order and tie-break (AS-02), best-path blending with decay and the direct-over-indirect precedence (AS-17, AS-18), sanitising of stored entries (AS-21), cosine scoring with the rounding rule (AS-22), the basket size rule (AS-33), and job parameter validation (AS-42). Everything that depends on counting inside the analytics store (thresholds, window, cap, bucket independence: AS-23–AS-28) is proven at the API/job layer against the real store.

### Edge Cases

- Same product listed twice in one basket (variants), a basket of one product, a basket of 31 or more distinct products: AS-29, AS-33.
- A neighbour equal to the requested product (self-link, from damaged data or a 2-hop path back): never returned (AS-13, AS-17, AS-21).
- Everything in a list hidden: `200` with empty `items` (AS-11); the requested product hidden or unknown: `404` (AS-06).
- Redelivery, concurrent redelivery, reordering, late arrival, replay of the topic: AS-30, AS-34, AS-35.
- Two builds at once, a build that crashes, a build whose source is empty, a build that fails midway: AS-39, AS-40, AS-41.
- Dependency failures and timeouts on the read path: AS-45, AS-46. Rate-limit store down: AS-08.
- Cross-tenant: recommendations are public data and carry no tenant-scoped records; the access question is "may a buyer see this product at all", answered by AS-06 and AS-10. Another shop's sandbox or suspended-shop products never leak (AS-06, AS-10).
- Manufactured edges (one buyer, many orders): AS-24.
- A product removed from sale between the build and the request: AS-10, AS-12.

## Requirements *(mandatory)*

### Functional Requirements

**Read path**

- **FR-001**: The system MUST expose `GET /api/products/{productId}/recommendations` to anonymous callers, with optional query parameters `limit` and `type` (AS-01, AS-07).
- **FR-002**: `productId` MUST be a UUID, `limit` an integer from 1 to 20 (default 8), `type` only `bought-together` (default). Any other value, and any unknown parameter, MUST answer `400` problem+json `validation_failed` naming the field; nothing is clamped or ignored silently (AS-03, AS-04, AS-05).
- **FR-003**: A `200` body MUST be `{type: "bought-together", items: [...]}` where each item is `{productId, title, priceMinor, currency, score, hops}`: `priceMinor` an integer in minor units, `score` rounded to 4 decimals in (0, 1], `hops` 1 or 2. No floating-point money (AS-01).
- **FR-004**: A requested product that does not exist or is not visible (FR-009) MUST answer an identical `404` `product_not_found`, so the answer does not reveal why (AS-06).
- **FR-005**: Candidates MUST come from the precomputed neighbour lists (top 20 per product) read by the requested product's ID; a product without a list has no direct neighbours (AS-20).
- **FR-006** (P1111): When the requested product has fewer direct neighbours than `limit`, the system MUST expand to depth 2: the neighbour lists of its 5 best direct neighbours (by score, ties by `productId` ascending) are read in one batch; a second-hop product's score is `seedScore × edgeScore × 0.5`; for a product reachable by several paths the highest score wins; a product that is already a direct neighbour stays direct; the requested product is never a result; no third hop is taken; a hidden seed still bridges but is itself not shown (AS-13–AS-20).
- **FR-007**: Items MUST be ordered direct (`hops: 1`) before indirect (`hops: 2`), within each group by score descending, ties by `productId` ascending, and cut to `limit`. The same input MUST yield a byte-identical body (AS-02, AS-18).
- **FR-008**: Stored entries that are not a UUID, equal the requested product, or have a non-numeric score or a score outside (0, 1] MUST be skipped and counted, never fail the request (AS-21).
- **FR-009**: Visibility. An item or the requested product is visible only when the product is `ACTIVE`, not a sandbox product, in stock, and its shop is `ACTIVE`. The candidate pool (requested product, direct and second-hop candidates, at most 121 products) MUST be checked with one batched product lookup (IX.7 **R1**, S05 `getProductsByIds`) and one batched shop lookup (IX.7 **R1**, S03 `getShopsByIds`), never per row. Hidden candidates are dropped and replaced by the next visible ones (AS-10, AS-12).
- **FR-010**: A `200` answer MUST carry `Cache-Control: public, max-age=60, s-maxage=300`, identical for every caller; every error answer MUST carry `no-store`. The body never depends on the caller (AS-01, AS-07, AS-09).
- **FR-011**: The endpoint MUST be rate limited per address by policy `discovery.recommendations` (600 per minute, fail open), answering `429` problem+json `rate_limited` with `Retry-After` (AS-08).
- **FR-012**: When the list store or either lookup fails or exceeds its time budget (store 100 ms, product lookup 100 ms, shop lookup 50 ms), the system MUST answer `503` problem+json `recommendations_unavailable` with `Retry-After: 5`, never an unfiltered or partial list, and MUST NOT retry inside the request (AS-45, AS-46).

**Basket capture (IX.7 R3)**

- **FR-013**: The system MUST consume `order.paid` from the orders event topic (key `orderId`), validate each payload against the shared contract schema before acting, and record one basket per `orderId` with the sorted distinct `productId`s of its lines, the `userId` as buyer, `paidAt`, and `orderVersion` (AS-29, AS-31).
- **FR-014**: Recording MUST be idempotent and version-guarded: a delivery with an `orderVersion` lower than or equal to the stored one changes nothing; a higher one replaces the lines; concurrent duplicates yield one basket (AS-30, AS-34).
- **FR-015**: Orders with fewer than 2 or more than 30 distinct products MUST be skipped (counted, not dead-lettered). Invalid payloads MUST be dead-lettered without side effects. Other event types on the topic MUST be ignored without effect (AS-31, AS-32, AS-33).
- **FR-016**: The basket store MUST be rebuildable by replaying the topic and MUST retain baskets for at least as long as the longest allowed build window; the maximum staleness of the graph relative to a paid order is one nightly cycle (about 24 hours) plus the 300 s edge cache (AS-34, AS-35).

**Nightly build**

- **FR-017**: A build job `recommendations.build-bought-together` MUST be scheduled at `17 3 * * *` (registered exactly once however many workers start) and be single-run with a 1-hour lease (AS-41, AS-44).
- **FR-018**: Job parameters are `days` (integer 1–390, default 180) and `buckets` (integer 1–256, default 16); anything else MUST fail validation before any read or write (AS-42).
- **FR-019**: The build MUST count, over baskets paid at or after `now − days`, each order once: `n(p)` is the number of such baskets containing `p`, `co(a,b)` the number containing both. A pair is an edge only if `co ≥ 3` and it was bought by at least 3 distinct buyers (AS-23, AS-24, AS-26).
- **FR-020** (normalisation): An edge's score MUST be `co(a,b) / sqrt(n(a) · n(b))`, identical in both directions (AS-22, AS-25).
- **FR-021**: Each product's list MUST hold at most its 20 best edges, ordered by score descending, ties by `productId` ascending (AS-27).
- **FR-022**: The build MUST process the product space in `buckets` partitions so that each query and each write batch stays bounded, and its output MUST NOT depend on `buckets` (AS-28).
- **FR-023**: Each product's list MUST be published atomically (readers see the old or the new list, never a partial one) with a time-to-live of 3 days (AS-37, AS-43).
- **FR-024**: After a complete successful build, a product that had a list and has no qualifying edge MUST lose its list. A build that fails MUST delete nothing, and a build that finds zero eligible baskets MUST end `skipped_empty`, writing and removing nothing (AS-38, AS-39, AS-40).
- **FR-025**: At most one build MUST run at a time; a concurrent invocation returns `skipped_locked` without writing; a crashed holder's lock expires by the lease (AS-41).
- **FR-026**: A build MUST return `{outcome, products, edges, removed}` and emit the metrics of AS-47 (AS-36, AS-47).

**Platform**

- **FR-027**: `discovery` MUST read no table of another domain and import no model of another domain for this capability: product and shop facts only through the R1 services, orders only through the event topic (R3), the product page composition only through this capability's HTTP API (R2). No Postgres table is added to the ownership registry for this capability (AS-50).
- **FR-028**: Logs and metrics MUST NOT contain buyer identifiers, order contents, or unbounded label values (AS-47).
- **FR-029**: Every tunable (thresholds, window and bucket defaults, caps, TTLs, time budgets) MUST be validated at startup; invalid configuration fails startup (AS-51).
- **FR-030**: Consumers of the endpoint (W02, S48) MUST treat the rail as optional, render `title` as text and money from `priceMinor` / `currency`, and handle `404`, `429`, `503` and empty `items` without breaking the page (AS-48, AS-49).

*(AS-50 and AS-51 are the platform scenarios below.)*

**Platform scenarios**

- **AS-50** (module boundary) — **Given** the final code, **Then** `pnpm check:table-ownership --strict` reports zero lines for the recommendations files; `pnpm check:boundaries` is green; the domain's entry point exports `RecommendationsModule`, `RecommendationsWorkerModule` and `RecommendationsProjectorModule` and no projector, job, model or key helper class; `apps/*` import only those modules.
- **AS-51** (configuration) — **When** the application starts with `minCoOrders = 0`, `minBuyers = 0`, a negative TTL, a `topN` above 20, or a time budget of 0, **Then** startup fails with a message naming the setting; with the defaults it starts.

### Key Entities *(include if feature involves data)*

- **Basket**: the distinct products of one paid order: `orderId`, `buyerId`, `paidAt`, `orderVersion`, `products[]`. One per order; replaceable only by a higher `orderVersion`. Retained at least 13 months. Contains only opaque IDs.
- **Edge**: an unordered pair of products with `co` (orders containing both), distinct buyers, and a cosine `score`. Exists only above the thresholds; derived, never stored on its own.
- **Neighbour list**: per product, at most 20 `{neighbourId, score}` entries ordered by score, with a 3-day lifetime; one owner (`discovery`). A cache of derived data, rebuildable from baskets; never the source of truth.
- **Recommendation item**: what the endpoint returns for one neighbour: `productId`, `title`, `priceMinor`, `currency`, `score`, `hops`. Facts come from the catalog at request time.
- **Build run**: one execution of the nightly job: parameters, outcome (`completed`, `skipped_empty`, `skipped_locked`, failed), counters, timestamps.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Adding the rail to a product page costs a buyer at most 300 ms at the 99th percentile when not served from the edge cache, and the page still renders fully when the rail is slow or down (the rail is dropped, never the page).
- **SC-002**: In 100% of the sampled products, a product that appears in more than half of all baskets is not the top suggestion unless it also has the highest similarity score for that product (hub products do not crowd out tight pairs); dataset D reproduces this exactly (AS-22).
- **SC-003**: 0 recommendations shown to a buyer, at origin, for a product that is archived, sandbox, out of stock, or in a non-active shop at the time of the request.
- **SC-004**: For a product with at least one direct neighbour and fewer than the requested number, the rail is filled up to the number of available second-hop products in 100% of requests.
- **SC-005**: A redelivered paid-order message changes the graph in 0% of cases; a replay of the whole order history rebuilds an identical graph.
- **SC-006**: A failed, interrupted, or concurrent nightly build leaves 0 half-written lists and removes 0 lists; an empty source never empties the rail.
- **SC-007**: The nightly build finishes in under 60 minutes at the target scale of 1 billion order lines, and a product's list is never older than 3 days (the rail is withdrawn rather than frozen).
- **SC-008**: A pair of products is recommended only when at least 3 different buyers bought them together: a single account cannot create a recommendation.
- **SC-009**: Operators can tell, from metrics alone, when the last successful build happened and how many products and edges it produced; an alert fires when no build has succeeded for 36 hours.

## Assumptions

- Product-page readers are mostly anonymous; the answer is the same for everyone, so the CDN may cache it for 5 minutes. Personalisation is out of scope.
- Hydration of titles, prices and visibility is done at request time through the S05 and S03 exported services (R1), not from a copy: the Product table stays with catalog, and S05 names S34 a consumer of `getProductsByIds`. An R3 product read model is the escape hatch if lookup latency ever exceeds the budget; it is not built now.
- Visibility means: product `ACTIVE`, not sandbox, `inStock`, and shop `ACTIVE`. This matches S32's visibility rule plus stock (a rail slot for an unbuyable item is wasted).
- Distinct buyers are distinct `userId` values of `order.paid`. Guest checkout does not exist (S10 requires sign-in), so `userId` is always present.
- Refunds do not retract a basket: `order.refunded` carries an amount, not lines, so a full return cannot be told from a partial one, and the purchase intent was real. Revisit if returns analytics exist.
- Orders that contain sandbox products are not filtered at capture (the event carries no sandbox flag); sandbox products are removed at read time (FR-009). Their edges are harmless noise at worst.
- The build window defaults to 180 days (basket retention is 13 months, so up to 390 days is allowed); the neighbour cap is 20; the 2-hop seed count is 5; the decay is 0.5; the minimum co-orders is 3; the minimum distinct buyers is 3; the basket size bounds are 2 and 30. All are configuration with these defaults.
- A failed build can leave lists of mixed generations (some products on the new build, some on the previous one) until the next successful build; this transient asymmetry is accepted. Per-list atomicity is the guarantee.
- The maximum staleness this read model accepts (IX.7 R3, to be copied into `plan.md`): a paid order influences the lists after the next nightly build (≤ 24 h + build duration), and a visible change in a product's state is reflected at origin immediately and at the edge within 300 s.
- The existing baskets in the analytics store lack `buyerId` and `orderVersion`; they are rebuilt by replaying the orders topic before the new build is enabled (see `questions.md`).
- "Customers who viewed this also viewed" is not built (DOUBTS Q42); `type` is validated so the parameter can grow.
- Mobile apps are not clients; the web storefront and the BFF are.

## Cross-capability contracts

Honoured from existing specs: **S10** names S34 a consumer of `order.paid` lines (honoured: FR-013); **S05** names S34 a consumer of `getProductsByIds` with the rule "pass `{shopId}` for ownership checks" (not applicable: public data, no ownership check; we call it without options); **S32** and **S33** only delegate "bought together" here and constrain nothing further; **W02** and **S48** (not yet specified) consume the endpoint.

**Provides** (exact names):

- HTTP `GET /api/products/{productId}/recommendations` (anonymous), schemas in `packages/contracts`: request `recommendationsQuerySchema` = `{limit?: integer 1–20 (default 8), type?: 'bought-together'}`; response `recommendationsResponseSchema` = `{type: 'bought-together', items: {productId: string (uuid), title: string, priceMinor: integer ≥ 0, currency: string (ISO 4217, 3 letters), score: number in (0, 1] (4 decimals), hops: 1 | 2}[]}`; errors problem+json with `code` `validation_failed` | `product_not_found` | `rate_limited` | `recommendations_unavailable`. Guarantees: `200` with at most `limit` items, all visible at the time of the request; direct before indirect; deterministic order; same body for every caller; `Cache-Control: public, max-age=60, s-maxage=300` on `200`, `no-store` on errors; `503` rather than an unfiltered list.
- Consumer obligations on **W02** / **S48** (FR-030): optional section with a 300 ms budget; render money from `priceMinor` and `currency`; render `title` as text; hide the section on empty `items`, `404`, `429`, `503`; validate the body with `recommendationsResponseSchema`. The aggregated product-page and GraphQL `recommendations` fields adopt the new shape (replacing the bare array and `price`).
- Rate-limit policy (declared in S50's registry): `discovery.recommendations` 600/minute per address, fail open.
- Scheduled job (registered with S49, single-run, lease 1 hour): `recommendations.build-bought-together`, cron `17 3 * * *`, payload `{days?: integer 1–390, buckets?: integer 1–256}`, idempotent.
- Consumer (apps/projector): `order.paid` from topic `orders.events`, group `discovery-order-baskets`, idempotency mechanism = version-guarded upsert keyed by `orderId` (IV.5); invalid payloads dead-lettered.
- Modules for the apps: `RecommendationsModule` (core: HTTP), `RecommendationsWorkerModule` (worker: build job), `RecommendationsProjectorModule` (projector: basket consumer). Nothing else is exported: no projector, job class, key helper or model (debt D-8).
- Metrics of AS-47.
- Events: none emitted.

**Requires** (owning capability, exact shape assumed):

- **S10** (`orders`): topic `orders.events` (key `orderId`), envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; `order.paid` payload `{orderId, userId, totalMinor, currency, paymentRef, paidAt, lines: [{productId, shopId, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}], shopOrders, orderVersion}` with `orderVersion` strictly increasing per order; zod schema `orderEventSchemas` in `packages/contracts` (used to validate; no import of `orders` internals, event contract only through the entry point if a type is needed). R3.
- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids: ProductId[], options?): Promise<Map<ProductId, ProductDto>>` (≤ 500 ids, one statement, unknown ids absent); fields used: `id`, `title`, `priceMinor`, `currency`, `status` (`'ACTIVE' | 'ARCHIVED'`), `isSandbox`, `inStock`, `shopId`. R1.
- **S03** (`tenancy`): `ShopQueryService.getShopsByIds(ids: ShopId[]): Promise<Map<ShopId, ShopSummaryDto>>` (≤ 500; unknown ids absent; suspended and tombstoned shops included with their status); field used: `status` (`'ACTIVE'` is visible). R1. `TenancyModule` and `ProductModule` must be loaded in the core app that hosts `RecommendationsModule`.
- **S49** (job scheduler): cron registration with a once-only guarantee, concurrency 1 per job, lease and retry for failed jobs.
- **S50** (rate limiter): the policy named above in the registry, fail-open mode.
- **S54** (platform toolkit): problem+json filter with `code` and `errors`, request context, metrics registry, config validation, dead-letter handling for projectors.
- **S48** (BFF): consumes the endpoint over HTTP (R2); this capability needs nothing from it.

## Review & Acceptance Checklist reference

See [`checklists/requirements.md`](checklists/requirements.md). Open decisions and their defaults: [`questions.md`](questions.md). Layer mapping per scenario: [`test-plan.md`](test-plan.md). Current-code to-do list: [`gaps.md`](gaps.md).
