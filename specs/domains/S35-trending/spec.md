# Feature Specification: S35 — Trending Products (Windowed Approximate Top-K per Category: Count-Min Sketch + Min-Heap, Event-Time Windows, Multi-Level Merge) (domain `discovery`)

**Feature Branch**: `S35-trending` (spec directory `specs/domains/S35-trending`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S35 of `scripts/sdd/capabilities.tsv`. Sources: `docs/showcase/sections/SD-32-trending-sponsored-clicks.md` (trending half only) and `10-System-Design/09-data-and-infrastructure.md` §32 (Interview-Prep; the notes win over the code). Pattern map row **P1102** (Count-Min Sketch + min-heap top-K). Contracts honoured from `specs/domains/S05-products/spec.md` (`getProductsByIds`, S35 named a consumer), `specs/domains/S32-product-search/` (the `TrendingConsumer` leaves the barrel, debt D-8), `specs/domains/S33-autocomplete/` (no trending blend is built), and the scope notes of S34.

## Scope

Everything a **buyer** sees as "Trending now", and the streaming machinery that keeps it fresh, bounded and honest:

- **Interaction capture**: product views and add-to-carts from the analytics event stream are counted with fixed weights (view 1, add-to-cart 5), per category and for `all`.
- **Tumbling one-minute windows by event time** with a watermark (allowed lateness 2 minutes), a **correction path** for late events, and a wall-clock close for idle partitions.
- **Approximate top-K**: a Count-Min Sketch gives frequency estimates in fixed memory, a min-heap of size K keeps the heavy hitters, per partition, per category, per window (pattern P1102).
- **Multi-level merge**: each partition's top-K is merged into one global aggregate per category and window, exactly once, however often the work is replayed.
- **Read endpoint**: `GET /api/trending?category=&limit=`, anonymous, CDN-cacheable, "the last hour", answered from the merged aggregates with a visibility and category check (only products a buyer can buy, in the category asked for).
- **Anti-manipulation and bounds**: one visitor moves a product's score by a bounded amount per window; category and memory cardinality are capped.
- **Platform**: validation, rate limit, cache headers, problem+json errors, timeouts and graceful failure, metrics, configuration validation, readiness, module boundary.

Out of scope (owners named):

- The analytics ingestion endpoint, its event schema and its clock rules → **S39** (`experimentation`). This capability only consumes the stream (IX.7 **R3**).
- "Bought together" → **S34**. Search and autocomplete → **S32**, **S33** (no trending blend is built: see Assumptions). Same domain, separate capabilities.
- Sponsored listings, exact deduplicated click counting, hot-key salting, click billing → **S36** (`marketing`). Trending is approximate by design and never feeds money.
- A **purchase** signal (`order.paid`) is not counted: add-to-cart is the conversion proxy (see Assumptions).
- The home page section, the product-page "trending in this category" section and their rendering → **W02** (UI) and **S48** (BFF composition, IX.7 **R2**). This spec states what they must do to use the endpoint correctly (Provides) and has one happy-path UI scenario (AS-41) and one composition-boundary scenario (AS-42).
- Rate-limit registry → **S50**. Problem+json filter, metrics registry, config validation, request context, readiness, dead-letter handling → **S54**. CDN rules honouring the cache headers → operations artifact.
- Postgres tables: `discovery` owns none for this capability (domain-map). The window aggregates are this capability's own non-Postgres store.

## User Scenarios & Testing *(mandatory)*

Notation: `A`, `B`, `C` are products of category `audio` ("Speaker A", "Headphones B", "Cable C"); `D` is a product of category `cameras` ("Camera D"); `H`, `I`, `J`, `K`, `L` are extra products used by single scenarios. All are `ACTIVE`, non-sandbox, in stock, in `ACTIVE` shops, unless a scenario says otherwise. `ANON` is an unauthenticated caller. "A visitor" is one distinct `anonymous_id`. "Time" is the frozen test clock. "Weight" is view = 1, add-to-cart = 5. "The aggregate" is the merged per-category, per-window count store. "Merge" means the point where a closed window's partition-level top-K is added to the aggregate.

**Dataset T** (used by AS-01 to AS-07, AS-10, AS-16, AS-26). Every event is sent by a different visitor, so the per-visitor cap (AS-22) does not apply. All events are `product_view` or `add_to_cart` carrying `props.product_id` and `props.category`.

| Minute | Events | Weighted total |
|---|---|---|
| 12:00 | 30 views of `A` (category `audio`) | `A` 30 |
| 12:01 | 10 views and 5 add-to-carts of `B` (`audio`) | `B` 10 + 25 = 35 |
| 12:02 | 3 views of `C` (`audio`) | `C` 3 |
| 12:03 | 12 views and 2 add-to-carts of `D` (`cameras`) | `D` 12 + 10 = 22 |

Then one event at 12:06:00 (any product) moves the watermark (maximum event time − 2 minutes = 12:04:00) past the end of the four windows, which close and merge. The test clock reads 12:07:10 when the endpoint is called. With so few distinct products the sketch estimate equals the exact count. Rankings after the merge: category `audio` → `B 35`, `A 30`, `C 3`; category `cameras` → `D 22`; `all` → `B 35`, `A 30`, `D 22`, `C 3`.

### User Story 1 - See what is trending in the last hour (Priority: P1)

A buyer opens the home page, or a category page, and sees "Trending now": the products people viewed and added to their carts most in the last hour, strongest first, with a title and a price they can act on. Everything shown can be bought right now.

**Why this priority**: this is the capability; without it the section is empty and the home page falls back to an untargeted catalogue list.

**Independent Test**: build dataset T through the real stream consumer, call the endpoint.

**Acceptance Scenarios**:

1. **AS-01** (happy path) — **Given** dataset T merged and all products visible, **When** `ANON` calls `GET /api/trending?category=audio`, **Then** `200` with `{category: "audio", windowMinutes: 60, generatedAt, items: [{rank: 1, productId: B, title: "Headphones B", priceMinor, currency, category: "audio", score: 35}, {rank: 2, productId: A, …, score: 30}, {rank: 3, productId: C, …, score: 3}]}`, header `Cache-Control: public, max-age=30, s-maxage=30`, no `Set-Cookie`, the body parses with `trendingResponseSchema`, `generatedAt` equals the frozen time as an ISO instant, and the stored aggregates are unchanged by the call (a `GET` changes no state).
2. **AS-02** (default category) — **When** `category` is omitted, or `category=all`, **Then** both answers are identical and equal `[B 35, A 30, D 22, C 3]` with `category: "all"`, and each item's `category` is its catalog category (`D` shows `cameras`).
3. **AS-03** (limit) — **When** `limit` is omitted, **Then** at most 20 items; `limit=2` returns the best two (`B`, `A`); `limit=1` and `limit=20` are accepted; `limit=0`, `limit=21`, `limit=-1`, `limit=abc`, `limit=2.5`, `limit=` each answer `400` (AS-04 shape) and nothing is clamped.
4. **AS-04** (validation) — **When** `category` is empty, longer than 40 characters, or contains anything outside lowercase letters, digits and hyphen (for example `Audio`, `a b`, `a:b`, `{x}`, `a*`, a Unicode letter), or an unknown query parameter `foo=1` is sent, or `limit` is invalid (AS-03), **Then** `400` `application/problem+json` with `type`, `title`, `status: 400`, `detail`, `instance`, `requestId`, `code: "validation_failed"` and `errors: [{field, message}]` naming the offending parameter; the category is never truncated, and no store is consulted (spy: zero reads on the aggregate store and on both lookups).
5. **AS-05** (order and replay) — **Given** a ranking in which `H` and `I` both have score 40, `J` has 50 and `K` has 40, **When** the endpoint is called twice, **Then** both bodies are byte-identical, ordered by score descending and equal scores by `productId` ascending (`J`, then `H`, `I`, `K` in ascending order of their IDs among the three with 40), and `rank` is 1, 2, 3, … without gaps.
6. **AS-06** (no traffic or unknown category) — **Given** no merged window in the last hour for category `garden` (or a category that no product has), **When** `GET /api/trending?category=garden`, **Then** `200 {category: "garden", windowMinutes: 60, generatedAt, items: []}` with the same `Cache-Control` as AS-01. A well-formed category is a label, not a resource, so there is no `404`.
7. **AS-07** (same answer for every caller) — **When** `ANON`, a signed-in buyer, a signed-in seller of another shop, and a caller with an invalid or expired bearer token request the same category, **Then** the four `200` bodies are identical (an invalid token is ignored, not a `401`), no `Set-Cookie`, no `Vary: Cookie` and no `Vary: Authorization` is sent, and neither request log lines nor metric labels contain a buyer, visitor or token identifier.
8. **AS-08** (rate limit) — **Given** policy `discovery.trending` allows 300 requests per minute per address, **When** one address sends 301 requests within one minute, **Then** the 301st answers `429` problem+json `code: "rate_limited"` with `Retry-After` (whole seconds ≥ 1) and `Cache-Control: no-store`, and another address is unaffected; **When** the rate-limit store is unavailable, **Then** every request answers `200` (fail open) and a counter increases.
9. **AS-09** (errors are never cached) — **When** any `400`, `429` or `503` is produced, **Then** it carries `Cache-Control: no-store` and the problem+json body of AS-04 (for `503`, AS-14).

---

### User Story 2 - Only products I can buy, in the category I asked for (Priority: P1)

The ranking is minutes old and built from untrusted client events. Between the events and my page view a product may sell out, be archived, or its shop may be suspended; and a client may have claimed a wrong category. I must never be shown such a product, and the section should still be as full as it can be.

**Why this priority**: showing unbuyable or mislabelled products erodes trust and wastes the most valuable slot on the home page.

**Independent Test**: merge dataset T, change product and shop state, call the endpoint.

**Acceptance Scenarios**:

1. **AS-10** (hidden products are dropped and replaced) — **Given** a merged ranking `N1…N10` by score in category `all`, of which `N1` is out of stock, `N2` archived, `N3` a sandbox product, `N4` of a `SUSPENDED` shop and `N5` unknown to the catalog (deleted), **When** `limit=4`, **Then** `200` with `N6, N7, N8, N9` (the next visible candidates) in score order and ranks 1 to 4; none of `N1…N5` appears; the candidate pool is `min(3 × limit, 60)` entries of the merged ranking, so ten candidates are read for `limit=4`; the product facts come from one batched lookup of the whole pool and the shop facts from one batched lookup of the pool's shops (spy: one call each, no per-row calls).
2. **AS-11** (the catalog is the authority on category) — **Given** the stream attributes a view of `D` (catalog category `cameras`) to category `audio` because a client sent a wrong `props.category`, so `D` ranks in the `audio` aggregate, **When** `GET /api/trending?category=audio`, **Then** `D` is absent (its catalog category differs); **When** `category=all`, **Then** `D` is present with `category: "cameras"`; **When** `category=cameras`, **Then** `D` is present only through the counts that carried `cameras`.
3. **AS-12** (fewer than asked, not padded) — **Given** only three products have been counted in the last hour and `limit=20`, **Then** exactly those three items are returned; **Given** every candidate is hidden, **Then** `200` with `items: []` and the same `Cache-Control` as AS-01.
4. **AS-13** (a stock change is seen immediately at origin) — **Given** `B` was served in the ranking, which is cached for 30 seconds, **When** `B` goes out of stock afterwards and the endpoint is requested at origin within the cache window, **Then** `B` is absent immediately: the ranking is cached, the visibility and facts are looked up on every origin request; a CDN copy may keep `B` for at most `s-maxage` (30 s), which is the accepted staleness. A price change is likewise shown at origin immediately.
5. **AS-14** (lookup or store failure or timeout → 503) — **When** the aggregate store, the product lookup or the shop lookup fails or exceeds its budget (aggregate read 100 ms, product lookup 100 ms, shop lookup 50 ms), **Then** `503` problem+json `code: "trending_unavailable"` with `Retry-After: 5` and `Cache-Control: no-store`, never an unfiltered or partial list, no retry inside the request, and a counter per failed dependency increases.
6. **AS-15** (concurrent cold reads share one computation) — **Given** the ranking for `all` is not cached, **When** 50 identical requests arrive concurrently (`Promise.all`), **Then** all answer `200` with identical bodies and the aggregate store is read once for that ranking (spy: one union read), and a different `category` in the same instant causes its own single read.

---

### User Story 3 - Counting by event time, in one-minute windows (Priority: P1)

The numbers must mean "what happened in the last hour", not "what arrived in the last hour". Events arrive out of order, late, with wrong clocks, or not at all for a quiet partition.

**Why this priority**: windowing is what turns a stream into a ranking. Wrong windowing silently ranks the wrong products.

**Independent Test**: deliver real envelopes to the stream consumer with chosen event times and read the aggregate and the endpoint.

**Acceptance Scenarios**:

1. **AS-16** (weights and relevant events only) — **Given** dataset T, **Then** the scores are exactly the weighted totals of the dataset; **When** events named `page_view`, `search`, `checkout_step`, `exposure`, `click` are delivered, **Then** they change nothing and are counted as `ignored`; **When** a `product_view` or `add_to_cart` carries no `product_id`, **Then** it changes nothing and is counted as `ignored`.
2. **AS-17** (event time, watermark, visibility) — **Given** events at 12:00:30 and 12:00:10 delivered in that order (out of order), **When** the maximum event time seen is 12:01:59 and the allowed lateness is 2 minutes, **Then** the window `[12:00, 12:01)` is still open and nothing of it is visible; **When** an event at 12:03:00 is delivered (watermark 12:01:00), **Then** the window closes, merges, and both events count in it, whichever order they arrived; a window closes only when the watermark passes its end, never because of arrival time.
3. **AS-18** (the last hour slides) — **Given** a view of `A` at 11:00:30 (window `[11:00, 11:01)`) merged, **When** the endpoint is called at 11:59:20, **Then** the view counts (that window is inside the 60 windows ending at the latest minute boundary 11:59:00); **When** called at 12:01:05, **Then** it does not (the 60 windows now end at 12:01:00 and start at 11:01:00); an event at 11:01:30 still counts at 12:01:05 and no longer at 12:02:05. The ranking then shows only what the remaining windows hold.
4. **AS-19** (late events: within lateness, correction path, dropped) — **Given** the watermark is 12:10:00, **Then**: (a) an event at 12:09:30 (its window is still open) counts in its own window; (b) an event at 12:05:30 (its window closed and merged, but is inside the last 60 minutes) is applied through the **correction path**: its weight is added to that window's aggregate through a merge of its own, applied once, visible after the next merge, and counted as `late_corrected`; (c) an event at 10:50:00 (outside the last 60 minutes) changes nothing and is counted as `late_dropped`. A closed window never reopens as a normal window.
5. **AS-20** (a wrong clock cannot move time) — **Given** the watermark is 12:00:00, **When** an event arrives with event time `ts = 13:30:00` and `received_at = 12:00:05`, **Then** its event time is the earlier of the two (12:00:05), the watermark stays below `received_at − 2 minutes` (never ahead of the newest receive time), no window closes early, and legitimate events at 12:00:10 afterwards are not late; **When** `ts` is older than the 60-minute horizon, **Then** AS-19(c).
6. **AS-21** (idle partition closes by the wall clock) — **Given** a partition delivered its last message at 12:00:20 (event time 12:00:15) and then no message for the idle timeout (30 s), **When** the wall clock reaches 12:03:20, **Then** the watermark advances to wall clock − 2 minutes, the window `[12:00, 12:01)` closes, merges, and is visible within the next merge cycle, although no later event ever arrived; **Given** the partition is not idle (messages keep arriving), **Then** the wall clock does not move the watermark.
7. **AS-22** (one visitor, one vote per window) — **Given** one visitor sends 50 `product_view` events of `A` within one window, **Then** `A` gains 1 from that visitor in that window; the same visitor's `add_to_cart` of `A` adds 5 once; the same visitor viewing `A` again in the next minute adds 1 again (the cap is per window, per visitor, per event name, per product); two visitors add 2. The cap is a probabilistic membership check that may wrongly treat a new (visitor, event, product, window) as already seen with probability at most 1% and never the reverse; visitor identifiers are held only in memory for the open window and are never logged, stored in the aggregate or used as metric labels.

---

### User Story 4 - Approximate top-K that stays accurate and bounded (Priority: P1)

With 50 million products and 500 thousand events per second an exact counter per product per category per window does not fit in memory. A Count-Min Sketch gives frequency estimates in fixed space and a min-heap keeps the K heaviest hitters; each partition does this independently and the partial results are merged into one global ranking. This is pattern **P1102**.

**Why this priority**: it is the algorithm the capability exists to show, and its guarantees (never undercount, bounded error, bounded memory, merge correctness) are what a reviewer checks.

**Independent Test**: pure unit tests on a seeded synthetic stream; e2e for the merge across partitions and for the bounds.

**Acceptance Scenarios**:

1. **AS-23** (Count-Min Sketch guarantees) — **Given** a sketch of width `w` and depth `d` fed a seeded Zipf-like stream of `N` events over 5,000 distinct products, **Then** for every product the estimate is at least its exact count (never an undercount) and, for the 10 heaviest products, the overcount is below 5% of the exact count; the overcount of any product is at most `e/w · N` with probability at least `1 − e^(−d)` (checked as the fraction of products within the bound over the whole stream); estimates of products never added are at least 0; two sketches of equal dimensions fed halves of the stream and added cell by cell give estimates equal to one sketch fed the whole stream (mergeability); the sketch's memory is `w × d` counters whatever the number of distinct products (a stream of 1,000,000 distinct products does not enlarge it).
2. **AS-24** (min-heap of K heaviest) — **Given** an empty heap of capacity K = 3, **When** counts are offered `a:5, b:3, c:4, d:9, e:2, b:7`, **Then** the heap holds `d 9, b 7, a 5` (c was evicted by `b`'s update beating it, `e` never entered), an offer for a key already in the heap updates its count in place without a second entry, a new key enters only when it beats the current minimum, the heap never holds more than K entries, and the result is ordered by count descending, ties by key ascending (compared by code unit, independent of locale).
3. **AS-25** (accuracy of the approximation) — **Given** a seeded stream of at least 200,000 events over 20,000 distinct products (Zipf-like), a sketch of default dimensions and a heap of K = 10, **Then** at least 9 of the exact top 10 are in the heap (precision ≥ 0.9, the proof target of the notes), and every count in the heap is ≥ the exact count; the stream is generated from a fixed seed so the test never flakes.
4. **AS-26** (multi-level merge) — **Given** two partitions `p1`, `p2` of the same consumer group, with `B`'s 35 weighted points split 20 and 15 between them, `A`'s 30 held entirely by `p1`, and `C`'s 3 held by `p2`, **When** both partitions' windows close, **Then** the aggregate holds `B 35`, `A 30`, `C 3` (partition-level top-K lists are summed into the global one), a product present in only one partition's top-K is not lost, and the endpoint answers as AS-01. **Given** a partition with more than K distinct products in a window, **Then** only that partition's K heaviest are merged (the accepted approximation: a product ranked below K in every partition is not counted); K is at least twice the largest allowed `limit`.
5. **AS-27** (cardinality and memory are bounded) — **Given** one partition's window receives events for 1,000 distinct categories and 10,000 distinct products, **Then** at most 100 categories (default) are tracked individually in that partition-window, further categories contribute to `all` only and are counted as `category_capped`, the categories already tracked keep counting normally, every tracked category uses one sketch and one heap of fixed size, and the consumer's tracked memory never exceeds the configured budget; a `category` value that is not valid (AS-04 pattern) is counted in `all` only and as `category_rejected`.
6. **AS-28** (counters saturate, never wrap) — **Given** a sketch counter at its maximum value, **When** more weight is added, **Then** the counter stays at the maximum (it does not wrap to a small number), so an estimate never decreases when events are added.

---

### User Story 5 - Every event counts once, none is lost (Priority: P1)

Streams redeliver, consumers crash, partitions move between instances, and the aggregate store has bad moments. The ranking must not double count a replayed window and must not lose the work of a window that was still open.

**Why this priority**: counting is only trustworthy if a restart or a duplicate cannot change the numbers; the notes say "dedupe, idempotent sinks, batch reconciliation for what must be exact" and trending is the approximate side of that split.

**Independent Test**: deliver the same envelopes twice; kill and restart the consumer at chosen points; move a partition; make the aggregate store fail.

**Acceptance Scenarios**:

1. **AS-29** (duplicate delivery → one effect, VII.4) — **Given** an event for `A` already counted, **When** the same message (same `event_id`) is delivered twice more, **Then** the weighted total of `A` rises once (the second and third deliveries are counted as `duplicate`), including when the copies arrive in different batches of the same open window and after a consumer restart that replays the batch.
2. **AS-30** (invalid payload → dead-lettered, VII.4) — **When** messages arrive that are not JSON, lack `event_id`, carry a `name` outside the analytics event names, an `anonymous_id` shorter than 8 or longer than 64 characters, a `ts` or `received_at` that is not a valid timestamp, or (for `product_view` and `add_to_cart`) a `product_id` that is not a UUID, **Then** each is dead-lettered with a reason and the aggregates, the sketches and the counters other than `invalid` are unchanged, and the next valid message in the same batch is processed normally (a poison message never blocks the partition).
3. **AS-31** (replayed merge changes nothing) — **Given** the consumer merged the closed window `[12:00, 12:01)` of partition `p1` into the aggregate and was killed before it committed its offsets, **When** it restarts and re-reads the same events, **Then** the rebuilt window is merged again but the aggregate is unchanged (the second merge is skipped and counted as `merge_replayed`), so `B` still reads 35 and not 70.
4. **AS-32** (a crash loses nothing) — **Given** three windows are open with events consumed and none of them merged, **When** the consumer is killed and restarted, **Then** it resumes from the earliest offset that still belongs to an unmerged window (it never committed past it), rebuilds the open windows, and after they close the aggregate equals the same counts as an uninterrupted run (checked by running both and comparing); no window is lost and none is doubled.
5. **AS-33** (partition moves and concurrent owners) — **Given** partition `p1` moves to another instance during a rebalance while the previous owner is still finishing a merge of `[12:00, 12:01)`, **When** both instances merge that window of `p1`, **Then** it is counted once; **When** `p1` and `p2` merge the same window concurrently (`Promise.all`), **Then** both are added (`p1`'s and `p2`'s counts sum), none is lost and none is doubled.
6. **AS-34** (graceful shutdown) — **When** the consumer receives a termination signal with open windows, **Then** it stops fetching, merges the partial counts of every open window of its partitions together with the commit of the matching offsets, closes its connections, and exits within the shutdown deadline; the next instance starts after the committed offset and the totals after both runs equal an uninterrupted run (no double count, no loss).
7. **AS-35** (aggregate store down during a merge) — **Given** the aggregate store is unreachable or a merge command exceeds its 100 ms budget, **When** a window closes, **Then** the merge is retried (exponential backoff with full jitter, at most 3 attempts per merge cycle, at one layer), no offset beyond the unmerged window is committed, the partition keeps consuming into memory up to the memory budget and then pauses (backpressure) rather than dropping events, and when the store returns the window merges once; a partial failure inside one merge (some commands succeed, some fail) leaves the aggregate unchanged or complete for that window, never half-added, and is reported as `merge_failed`.

---

### User Story 6 - Observable, bounded and safe to operate (Priority: P2)

An operator must be able to tell from metrics alone whether trending is fresh, how many events are dropped and why, and whether the consumer is alive; the consumer must never be silently dead.

**Why this priority**: an approximate ranking that silently stops updating looks healthy; observability is what makes approximation acceptable.

**Independent Test**: scrape metrics after scenarios; start the consumer with and without the event broker; start with invalid configuration.

**Acceptance Scenarios**:

1. **AS-36** (metrics and privacy) — **Given** scenarios AS-16 to AS-35 were run, **Then** the metrics exist with bounded labels (outcome and dependency names only; never a product, category, visitor or order identifier): events by outcome (`counted`, `ignored`, `duplicate`, `invalid`, `late_corrected`, `late_dropped`, `visitor_capped`, `category_capped`, `category_rejected`), windows closed, merges by outcome (`merged`, `merge_replayed`, `merge_failed`), the time of the last successful merge (gauge), the age of the oldest unmerged open window (gauge), consumer lag, tracked sketch memory, serving requests by outcome (`ok`, `empty`, `invalid`, `rate_limited`, `unavailable`), serving dependency failures by dependency, and cache hits and misses of the ranking. No log line contains an `anonymous_id`, `user_id`, a raw message body or a product title.
2. **AS-37** (configuration is validated at startup) — **When** the application starts with a weight of 0 or a non-integer weight, a sketch width that is not a power of two, a depth outside 1–8, a heap capacity below 40, an allowed lateness below 0 or above 10 minutes, a category cap below 1, a memory budget of 0, a negative idle timeout, or a time budget of 0, **Then** startup fails with a message naming the setting; with the defaults it starts.
3. **AS-38** (module boundary) — **Given** the final code, **Then** `pnpm check:table-ownership --strict` reports zero lines for the trending files; `pnpm check:boundaries` is green; no file of this capability imports a model or issues SQL against another domain's table; the entry point exports `TrendingModule` (HTTP, core) and `TrendingProjectorModule` (stream consumer, projector) and neither `TrendingService`, `TrendingConsumer`, nor any key helper, sketch or window class; `apps/*` import only those modules; the application layer imports no `infra/` class.
4. **AS-39** (retention and key ownership) — **Given** a merged window, **Then** its aggregate expires on its own after a bounded retention (at least the 60-minute horizon plus the allowed lateness plus the correction horizon, and at most 3 hours), the aggregate is read by computed key names (no pattern scan), one module owns the key space, and a window older than the horizon is never read by the endpoint even when its aggregate still exists.
5. **AS-40** (the consumer is never silently dead) — **Given** the event broker is unreachable at startup, **When** the projector starts, **Then** readiness reports not ready and the consumer retries with exponential backoff and jitter (every connect and subscribe call has a timeout), logs and counts each failure, and becomes ready only when it is subscribed; liveness stays up (it checks the process only); **When** the consumer loop ends with an error at runtime, **Then** the process reports not ready and exits so the supervisor restarts it, rather than serving a ranking that no longer updates.

---

### User Story 7 - The home page and product page show it (Priority: P2, owned by W02 and S48)

The home page "Trending now" section and the product page "trending in this category" section show the rail from the endpoint and fall back gracefully.

**Why this priority**: the section is the buyer-facing proof; but its rules are enforced at the API layer, so the UI only needs one happy path.

**Acceptance Scenarios**:

1. **AS-41** (UI happy path, W02) — **Given** dataset T merged, **When** a buyer opens the home page, **Then** the "Trending now" section lists `Headphones B`, `Speaker A`, `Camera D`, `Cable C` in that order with a price formatted from `priceMinor` and `currency`, each linking to its product page; when the endpoint returns no items or an error, the section falls back to the catalogue list and the page still renders fully.
2. **AS-42** (composition boundary, S48, R2) — **Given** the product-page composition calls `GET /api/trending?category={product's category}` with a 200 ms budget as an optional section, **When** the call is slow or fails, **Then** the page is returned with the trending section absent and the other sections intact; **When** it succeeds, **Then** the section holds the body validated with `trendingResponseSchema`, merged by `productId` and passed through unchanged (no ranking, no filtering in the composition).

---

### Unit-tested pure rules (listed for traceability, VII.5)

Proven at the unit layer (see `test-plan.md`): Count-Min Sketch guarantees, mergeability, saturation and fixed size (AS-23, AS-28), min-heap behaviour and tie order (AS-24), the accuracy target on a seeded stream (AS-25), ranking order and tie-break (AS-05), window assignment, watermark, late classification and idle advance (AS-17 to AS-21), event normalisation (event time clamp, weights, category validity, ignored names: AS-16, AS-20), the serving window arithmetic (AS-18), the per-visitor cap's no-false-negative property (AS-22), candidate pool size (AS-10), configuration validation (AS-37). Everything that depends on the stores, the stream and the lookups is proven at the API/stream layer against the real engines.

### Edge Cases

- **Concurrency**: concurrent cold reads (AS-15), two partitions merging the same window at once and a rebalance with an old owner still merging (AS-33).
- **Idempotent replay and duplicates**: the same `event_id` twice (AS-29), a replayed merge (AS-31), a restart that replays the batch (AS-29, AS-32).
- **Out-of-order and late events**: AS-17, AS-19, AS-21.
- **Illegal state transitions**: a window is `open → closed → merged`; a closed window never reopens as a normal window, late data takes the correction path (AS-19); a merged window is never merged a second time (AS-31). There is no persisted status machine.
- **Cross-tenant access**: trending is public data without tenant-scoped records; the access question is "may a buyer see this product at all", answered by AS-10 and AS-11 (another shop's sandbox, archived or suspended-shop products never leak) and AS-07 (no caller-specific output).
- **Limits**: `limit` 1–20 (AS-03), category length and alphabet (AS-04), K entries per heap (AS-24), 100 categories per partition-window (AS-27), memory budget and backpressure (AS-35), 60-minute horizon (AS-18).
- **Timeouts**: serving budgets (AS-14), merge budget with retries (AS-35), connect and subscribe timeouts (AS-40), shutdown deadline (AS-34).
- **Hostile input**: forged categories (AS-11, AS-27), floods from one visitor (AS-22), forged clocks (AS-20), forged product IDs (unknown products are dropped at the visibility check, AS-10).
- **Empty and degenerate states**: no traffic (AS-06), all candidates hidden (AS-12), a window with no events never merges anything, a quiet partition (AS-21).
- **Dependency failures on the read path**: AS-14; rate-limit store down: AS-08.

## Requirements *(mandatory)*

### Functional Requirements

**Read path**

- **FR-001**: The system MUST expose `GET /api/trending` to anonymous callers, with optional query parameters `category` and `limit` (AS-01, AS-07).
- **FR-002**: `category` MUST be 1–40 characters of lowercase letters, digits and hyphen (default `all`), `limit` an integer from 1 to 20 (default 20). Any other value, and any unknown parameter, MUST answer `400` problem+json `validation_failed` naming the field; nothing is truncated, clamped or ignored silently, and no store is consulted (AS-03, AS-04).
- **FR-003**: A `200` body MUST be `{category, windowMinutes: 60, generatedAt, items: [...]}` where each item is `{rank, productId, title, priceMinor, currency, category, score}`: `rank` from 1 without gaps, `priceMinor` an integer in minor units, `score` a positive integer (the approximate weighted interaction count over the last hour), `category` the catalog category. No floating-point money (AS-01, AS-02).
- **FR-004**: The ranking MUST be the sum, per product, of the aggregates of the 60 one-minute windows ending at the most recent minute boundary, ordered by score descending and equal scores by `productId` ascending. The same input MUST yield a byte-identical body (AS-05, AS-18).
- **FR-005**: A well-formed category with no data MUST answer `200` with empty `items`, never `404` (AS-06).
- **FR-006**: Visibility. An item is shown only when the product is `ACTIVE`, not a sandbox product, in stock, its shop is `ACTIVE`, and — for a category other than `all` — its catalog category equals the requested one. The candidate pool (the first `min(3 × limit, 60)` entries of the ranking) MUST be checked with one batched product lookup (IX.7 **R1**, S05 `getProductsByIds`) and one batched shop lookup (IX.7 **R1**, S03 `getShopsByIds`), never per row. Hidden candidates are dropped and replaced by the next visible ones; the list is not padded (AS-10, AS-11, AS-12).
- **FR-007**: The ranking MAY be cached for 30 seconds and concurrent computations of the same ranking MUST share one read; the product facts and the visibility MUST be looked up on every origin request, so a stock, status or price change is shown at origin immediately (AS-13, AS-15).
- **FR-008**: A `200` answer MUST carry `Cache-Control: public, max-age=30, s-maxage=30`, identical for every caller; every error answer MUST carry `no-store`. The body never depends on the caller (AS-01, AS-07, AS-09).
- **FR-009**: The endpoint MUST be rate limited per address by policy `discovery.trending` (300 per minute, fail open), answering `429` problem+json `rate_limited` with `Retry-After` (AS-08).
- **FR-010**: When the aggregate store or either lookup fails or exceeds its time budget (aggregate read 100 ms, product lookup 100 ms, shop lookup 50 ms), the system MUST answer `503` problem+json `trending_unavailable` with `Retry-After: 5`, never an unfiltered or partial list, and MUST NOT retry inside the request (AS-14).

**Counting (stream consumer, IX.7 R3)**

- **FR-011**: The system MUST consume the analytics event topic `analytics.events` (key `anonymous_id`) in its own consumer group `discovery-trending-topk`, validate every message against the shared event schema before acting, and count only `product_view` (weight 1) and `add_to_cart` (weight 5) events that carry a UUID `props.product_id`. Other event names MUST be ignored without effect (AS-16, AS-30).
- **FR-012**: Counting MUST use tumbling one-minute windows assigned by **event time**, where the event time is the earlier of the event's `ts` and its `received_at`, and a watermark equal to the maximum event time seen minus the allowed lateness (default 2 minutes), never ahead of the newest `received_at` minus the lateness. A window closes when the watermark passes its end (AS-17, AS-20).
- **FR-013**: A partition that has delivered no message for the idle timeout (default 30 seconds) MUST advance its watermark with the wall clock (wall clock minus the allowed lateness) so quiet partitions still close their windows; a non-idle partition MUST NOT be advanced by the wall clock (AS-21).
- **FR-014** (late events, correction path): An event for an already closed window MUST NOT be dropped silently. If its window is inside the 60-minute horizon, its weight MUST be added to that window's aggregate through a correction merge applied once; otherwise it MUST be dropped and counted. A closed window never reopens as a normal window (AS-19).
- **FR-015**: One visitor MUST contribute at most one view and one add-to-cart per product per window; the cap is a bounded-memory membership check with a false-"seen" probability of at most 1% and no false-"unseen"; visitor identifiers are never persisted, logged or used as labels (AS-22, AS-36).
- **FR-016** (P1102): Per partition, per tracked category (and `all`) and per window, counts MUST be estimated by a Count-Min Sketch of fixed width and depth that never undercounts and whose counters saturate instead of wrapping, and the K heaviest estimates MUST be kept by a min-heap of fixed capacity K with in-place update of keys already held. Memory per sketch and heap is fixed regardless of the number of distinct products (AS-23, AS-24, AS-25, AS-28).
- **FR-017**: Categories MUST be tracked individually only when valid (FR-002 alphabet) and while fewer than the cap (default 100) are tracked in that partition-window; others contribute to `all` only and are counted. Total tracked memory MUST stay within the configured budget (AS-27).
- **FR-018** (multi-level merge): When a window closes, each partition's heap contents per category MUST be added to the aggregate of that category and window (partition-level top-K → global ranking), with a bounded retention (AS-26, AS-39).
- **FR-019** (idempotent merge): A merge is identified by (partition, window, the offsets it covers); applying the same merge twice MUST change the aggregate once, and a merge MUST be all-or-nothing for its window (AS-31, AS-33, AS-35).
- **FR-020** (no loss, no double count): Offsets MUST be committed only up to the earliest offset belonging to a window that has not been merged yet; a restart therefore rebuilds open windows, and the idempotent merge prevents double counting. On graceful shutdown all open windows MUST be merged and their offsets committed together (AS-32, AS-34).
- **FR-021**: Invalid messages MUST be dead-lettered with a reason and without any side effect; a poison message MUST NOT block its partition; duplicate `event_id`s MUST have one effect (AS-29, AS-30).
- **FR-022**: Every outbound call (aggregate store, event broker connect and subscribe) MUST have an explicit timeout; merge retries happen at one layer only, with exponential backoff plus full jitter and at most 3 attempts per cycle; while the aggregate store is down the consumer MUST buffer up to its memory budget and then pause, never drop (AS-35, AS-40).
- **FR-023**: The consumer MUST NOT start serving silently without a subscription: readiness reflects "subscribed", a failed connect or a dead consumer loop fails readiness and ends the process (AS-40).

**Platform**

- **FR-024**: `discovery` MUST read no table of another domain and import no model of another domain for this capability: product and shop facts only through the R1 services, analytics only through the event topic (R3), the page composition only through this capability's HTTP API (R2). No Postgres table is added to the ownership registry for this capability (AS-38).
- **FR-025**: The metrics of AS-36 MUST exist with bounded labels; logs and metrics MUST NOT contain visitor, buyer or order identifiers, raw message bodies, or unbounded label values (AS-36).
- **FR-026**: Every tunable (weights, window size, allowed lateness, idle timeout, sketch width and depth, heap capacity, category cap, memory budget, retention, serving budgets) MUST be validated at startup; invalid configuration fails startup (AS-37).
- **FR-027**: Consumers of the endpoint (W02, S48) MUST treat the rail as optional, render `title` as text and money from `priceMinor` / `currency`, handle empty `items`, `429` and `503` without breaking the page, and validate the body with `trendingResponseSchema` (AS-41, AS-42).
- **FR-028**: The scheduling clock (current time) MUST be injected everywhere in the pure logic; no pure code reads the wall clock directly (supports every frozen-time scenario).

### Key Entities *(include if feature involves data)*

- **Interaction event** (consumed, not owned): `{event_id, name, anonymous_id, ts, received_at, props.product_id, props.category}`; only `product_view` and `add_to_cart` are counted. Owned by S39.
- **Window**: a one-minute interval `[start, start + 60 s)` by event time; lifecycle `open → closed → merged`; per-partition working state exists only while open.
- **Sketch and heap**: per partition, per tracked category, per window: a fixed-size frequency table plus a heap of the K heaviest `{productId, estimate}`; never persisted.
- **Window aggregate**: per category and window: `{productId → weighted count}` for the products that made some partition's top-K, with a bounded lifetime; owned by `discovery`; a cache of derived data, rebuildable from the topic, never the source of truth.
- **Merge record**: the identity of one applied merge (partition, window, covered offsets), kept for as long as its window's aggregate lives; enforces FR-019.
- **Trending item**: what the endpoint returns for one product: `rank`, `productId`, `title`, `priceMinor`, `currency`, `category`, `score`. Facts come from the catalog at request time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A buyer sees an interaction (view or add-to-cart) reflected in the "Trending now" ranking within 5 minutes of it happening at least 99% of the time (window 1 minute + lateness 2 minutes + idle close 30 seconds + merge cycle + 30-second cache), and the home page still renders fully when the section is slow or down.
- **SC-002**: On a stream of at least 200,000 events over 20,000 products, at least 9 of the true top 10 products appear in the approximate top 10 (precision ≥ 0.9), and no product's counted score is below its true score (AS-25).
- **SC-003**: 0 products shown to a buyer, at origin, that are archived, sandbox, out of stock, in a non-active shop, or outside the category asked for, at the time of the request.
- **SC-004**: A redelivered event, a replayed window, a restarted or moved consumer changes a product's score in 0% of cases; a crash loses 0 windows (AS-29, AS-31, AS-32, AS-33).
- **SC-005**: One visitor can raise any product's score by at most 6 points per minute (one view and one add-to-cart), however many events they send, so a single script cannot make a product trend.
- **SC-006**: The consumer's memory stays within its configured budget at 10 million distinct products and 1,000 distinct categories per window, with no loss of events (they are buffered, then back-pressured).
- **SC-007**: The endpoint answers in under 200 ms at the 99th percentile for uncached requests at 500 requests per second, and never serves an unfiltered list (it answers `503` instead).
- **SC-008**: Operators can tell from metrics alone when the last window merged, how many events were dropped and why, and whether the consumer is alive; an alert fires when no window has merged for 10 minutes while events are flowing.
- **SC-009**: At the capacity target of 500,000 events per second across 64 partitions (about 30,000 events per second per consumer), a consumer keeps up (lag stays under 60 seconds) in the load proof (operations artifact).

## Assumptions

- **Source of truth**: the analytics event stream is the only input. Trending is approximate by design; money never uses it (S36 uses exact, deduplicated counts).
- **Signal**: views weigh 1 and add-to-carts 5 (the notes' implementation weights). Purchases are not counted: an `order.paid` consumer would need the product's category, which the order event does not carry, and add-to-cart is already the conversion signal. Weights are configuration.
- **Window and horizon**: tumbling windows of one minute, allowed lateness 2 minutes, "trending" means the last 60 windows. Window aggregates live at most 3 hours. These are configuration with these defaults.
- **Category**: the category in an event is a client claim. It decides which per-category ranking a count goes to, but the catalog category is authoritative at read time (FR-006). Categories are catalog slugs (lowercase letters, digits, hyphen, ≤ 40). A forged category can only waste a category slot (capped at 100 per partition-window) or hide a product from its true category for one window; it cannot show a product under a category it does not belong to.
- **Approximation error**: a product ranked below K (default 50) in every partition for a window is not counted; the sketch overcounts by at most `e/w · N` with high probability. Both are the approximation the notes accept; the accuracy target is precision ≥ 0.9 on the top 10.
- **Partitioning**: events are keyed by `anonymous_id`, so one visitor's events share a partition; the per-visitor cap therefore needs no cross-consumer coordination. After a rebalance a visitor's open-window state is rebuilt by replaying from the commit floor.
- **Delivery semantics**: at-least-once consumption with an idempotent merge gives exactly-once effect on the aggregate; the decision to prefer this over "commit as consumed, lose open windows" is recorded in `questions.md`.
- **Maximum staleness this read model accepts** (IX.7 R3, to be copied into `plan.md`): an interaction is visible after at most window (1 min) + lateness (2 min) + idle timeout (30 s) + merge cycle, about 4 minutes, plus the 30-second cache; a product state change is reflected at origin immediately and at the edge within 30 seconds.
- **Capacity**: 500,000 events per second, 64 partitions, 16 consumers (the notes' target). Sketch default dimensions: width 2^16, depth 4 for `all` (about 1 MB); per-category sketches use width 2^14 (about 256 KB). Both are configuration.
- **Visibility** matches S34: `ACTIVE`, not sandbox, `inStock`, shop `ACTIVE`.
- **No blend into autocomplete**: S33 deferred a trending-terms blend to S35; trending products are not search terms, so no `trending` source is added to autocomplete (`[CONTRACT]` question).
- **Clients emit the events**: the web storefront emits `product_view` (product page) and `add_to_cart` (cart) with `props.product_id` and `props.category` (S39 forwards `props` as strings). Today nothing in the web app emits them; that is a gap for W02 and W03 (`[CONTRACT]`).

## Cross-capability contracts

Specs already written were searched (`grep` over `specs/domains` for `S35` and `trending`; `specs/web` and `specs/journeys` do not exist yet). Contracts they require from S35 and how they are honoured:

- **S05** names S35 a consumer of `getProductsByIds` for "titles and prices for rails" (honoured: FR-006; no `{shopId}` option because trending is public data).
- **S32** (gaps A29, D-8) requires that `TrendingConsumer` leaves the barrel and that `trending.service.ts:37` reads the catalog only through R1 (honoured: FR-024, AS-38).
- **S33** defers a trending blend to S35 and says that if S35 wants it, it adds a `trending` source (decided: no blend; `[CONTRACT]` question).
- **S34** states `trending.service.ts` reads `Product` and that it is not its concern (honoured: FR-024).
- **W02**, **S48**, **S39**, **S50** (not yet specified) consume or serve what is below.

**Provides** (exact names):

- HTTP `GET /api/trending` (anonymous), schemas in `packages/contracts`: request `trendingQuerySchema` = `{category?: string (1–40, ^[a-z0-9-]+$, default 'all'), limit?: integer 1–20 (default 20)}`; response `trendingResponseSchema` = `{category: string, windowMinutes: 60, generatedAt: string (ISO 8601 instant), items: {rank: integer ≥ 1, productId: string (uuid), title: string, priceMinor: integer ≥ 0, currency: string (ISO 4217, 3 letters), category: string, score: integer ≥ 1}[]}`; errors problem+json with `code` `validation_failed` | `rate_limited` | `trending_unavailable`. Guarantees: `200` with at most `limit` items, all visible at the time of the request and in the requested category (for a category other than `all`); deterministic order (score descending, `productId` ascending); same body for every caller; `Cache-Control: public, max-age=30, s-maxage=30` on `200`, `no-store` on errors; `503` rather than an unfiltered list; empty `items` for a category without data.
- Consumer obligations on **W02** / **S48** (FR-027): optional section with a 200 ms budget in the composition; render money from `priceMinor` and `currency` and `title` as text; hide or fall back on empty `items`, `429`, `503`; validate the body with `trendingResponseSchema`; the aggregated product-page `trending` field adopts the new envelope (replacing the bare array and `price`); the home page stops displaying the implementation note ("Powered by Count-Min Sketch…").
- Rate-limit policy (declared in S50's registry): `discovery.trending` 300/minute per address, fail open.
- Consumer (apps/projector): topic `analytics.events`, group `discovery-trending-topk`; idempotency mechanism = event-level per-visitor window cap plus idempotent window merges identified by (partition, window, covered offsets) (IV.5); invalid payloads dead-lettered.
- Modules for the apps: `TrendingModule` (core: HTTP), `TrendingProjectorModule` (projector: stream consumer). Nothing else is exported: no `TrendingService`, `TrendingConsumer`, sketch, heap, window class or key helper (debt D-8; the old name `TrendingConsumerModule` is removed).
- Metrics of AS-36.
- Events: none emitted.

**Requires** (owning capability, exact shape assumed):

- **S39** (`experimentation`, analytics ingestion): topic `analytics.events` (constant `ANALYTICS_TOPIC`, exported through the `experimentation` entry point as an event contract), key `anonymous_id`, message value `{event_id: uuid, name: 'page_view' | 'product_view' | 'search' | 'add_to_cart' | 'checkout_step' | 'exposure' | 'click', anonymous_id: string (8–64), user_id: string ('' when anonymous), ts: string 'YYYY-MM-DD HH:mm:ss.SSS' (UTC), received_at: same format, country, platform, page, props: Record<string, string>}`, produced by both the edge worker and the backend fallback with the same shape; a zod schema for the stored event exported in `packages/contracts` (`storedAnalyticsEventSchema`); `ts` already clamped to receive time when more than 10 minutes in the future and events older than 7 days rejected. For `product_view` and `add_to_cart`, `props.product_id` (UUID) and `props.category` (catalog slug) are forwarded unchanged. R3.
- **W02** / **W03** (web emitters, not yet specified): the product page emits `product_view` and the add-to-cart action emits `add_to_cart`, each with `props.product_id` and `props.category`, through the S39 ingestion (`[CONTRACT]`).
- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids: ProductId[], options?): Promise<Map<ProductId, ProductDto>>` (≤ 500 ids, one statement, reads the database, unknown ids absent); fields used: `id`, `title`, `priceMinor`, `currency`, `category`, `status` (`'ACTIVE' | 'ARCHIVED'`), `isSandbox`, `inStock`, `shopId`. R1.
- **S03** (`tenancy`): `ShopQueryService.getShopsByIds(ids: ShopId[]): Promise<Map<ShopId, ShopSummaryDto>>` (≤ 500; unknown ids absent; suspended and tombstoned shops included with their status); field used: `status` (`'ACTIVE'` is visible). R1. `TenancyModule` and `ProductModule` must be loaded in the core app that hosts `TrendingModule`.
- **S50** (rate limiter): the policy named above in the registry, fail-open mode.
- **S54** (platform toolkit): problem+json filter with `code` and `errors`, request context, metrics registry, config validation, readiness and graceful shutdown hooks, dead-letter handling for consumers, resilient timeouts.
- **S48** (BFF): consumes the endpoint over HTTP (R2); this capability needs nothing from it.

## Review & Acceptance Checklist reference

See [`checklists/requirements.md`](checklists/requirements.md). Open decisions and their defaults: [`questions.md`](questions.md). Layer mapping per scenario: [`test-plan.md`](test-plan.md). Current-code to-do list: [`gaps.md`](gaps.md).
