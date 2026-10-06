# Feature Specification: S26 — Follow graph and home feed (hybrid fan-out, celebrity merge, rebuild on return)

**Feature Branch**: `S26-follow-feed` (spec directory only; no branch created)

**Created**: 2026-10-05

**Status**: Draft

**Domain**: `community` (capability S26 of `scripts/sdd/capabilities.tsv`)

**Input**: Write the specification for capability S26 — Follow graph and home feed (hybrid fan-out, celebrity merge, rebuild on return). Sources: `docs/showcase/sections/SD-09-follow-feed.md`, `10-System-Design/05-social-and-content.md` §9, the constitution, `domain-map.md`, and `pattern-map.md` rows P0101, P0609 and P1112.

## Scope

**In scope**

- The follow graph: buyers follow shops and other buyers, unfollow, list whom they follow, and see follow state and follower counts.
- Feed items: turning things that happened (a shop listed a product, a price dropped, a drop was announced, an auction started, a buyer posted a discussion) into a feed item that is stored once.
- The home feed: a buyer's personal, newest-first, cursor-paged timeline of items from the accounts they follow.
- Hybrid fan-out: items of normal accounts are pushed into the timelines of active followers; items of celebrity accounts are never pushed and are merged in when a follower reads.
- Rebuild on return: users who were away longer than the active window get a timeline rebuilt by pulling when they come back.
- Hydration: timelines hold item identifiers only; items are loaded in batches and deleted, hidden, unfollowed or unavailable items are dropped at read time.
- Consumer-side behaviour: idempotent consumers, ordering, backpressure, dead-lettering, degraded modes, retention, and operational signals.

**Out of scope (owner)**

- Creating, ranking, voting and moderating discussion posts → S25. S26 only consumes `discussion.post_created` / `discussion.post_deleted` and hydrates posts through S25's exported batch query.
- Product data, prices and stock → S05. S26 keeps its own copy of the few product fields it needs, fed by S05's events.
- Auctions → S21. S26 consumes `auction.created` and `auction.opened`.
- Shops and shop status → S03. Users and accounts → S01. Rate-limit mechanics → S50. Event envelope and producer → S53. Notifications about feed items → S28.
- The web pages for the home feed and follow buttons: no web capability owns them today (see `questions.md`). The cross-domain journey J05 covers follow → feed at the UI level.
- Restock items, "shop posts" authored directly by sellers, blocking and muting, suggestions of whom to follow, ranking beyond newest-first, and erasure of a deleted user's follows.

## User Scenarios & Testing *(mandatory)*

Test configuration used by the scenarios (production defaults in brackets): celebrity threshold 3 [10,000]; pushed-timeline window 5 [800]; follower page size 2 [1,000]; following limit 3 [2,000]; active window 7 days; feed retention 90 days. Time is frozen and advanced explicitly. "Account" means a shop (`shop:<uuid>`) or a buyer (`user:<uuid>`).

### User Story 1 — Follow and unfollow accounts (Priority: P1)

A buyer follows a shop or another buyer so that its activity shows up in their home feed, and unfollows when they lose interest. Following is idempotent, safe under double clicks, private to the buyer, and bounded.

**Why this priority**: nothing else works without the graph, and double submits, races and abuse start here.

**Independent Test**: sign in, follow a shop, see it in the following list and follow status, unfollow, see it gone; no feed needed.

**Acceptance Scenarios**:

1. **AS-01** — **Given** a signed-in buyer U and an existing shop S with 0 followers, **When** `POST /follow/shop:S`, **Then** `204` with no body; U's following list contains `shop:S` with `followedAt` = the frozen time; S's follower count is 1; both directions of the relation exist (U follows S, S has follower U).
2. **AS-02** — **Given** U already follows S, **When** `POST /follow/shop:S` again, **Then** `204`, `followedAt` is unchanged, and S's follower count is still 1.
3. **AS-03** — **Given** U does not follow S, **When** 20 identical `POST /follow/shop:S` requests run concurrently (`Promise.all`), **Then** every response is `204`, exactly one follow relation exists in each direction, and S's follower count is 1.
4. **AS-04** — **Given** a signed-in buyer, **When** following with: a malformed account ID (`shop:123`, `team:<uuid>`, uppercase UUID, 100-character string), **Then** `400 validation_failed`; a well-formed but unknown shop, an unknown or deleted user, or a shop whose status is `DELETING` or `DELETED`, **Then** `404 account_not_found`; the buyer's own ID `user:U`, **Then** `422 cannot_follow_self`; in every case nothing is stored and no count changes.
5. **AS-05** — **Given** U follows S (count 1), **When** `DELETE /follow/shop:S`, **Then** `204`, both directions are gone, S's count is 0; **When** the same request is repeated or U never followed S, **Then** `204` and the count stays 0 (never negative); unfollowing a shop that no longer exists also answers `204`.
6. **AS-06** — **Given** U does not follow S, **When** a `POST /follow/shop:S` and a `DELETE /follow/shop:S` run concurrently 20 times (fresh pair each time), **Then** every response is `204`, and after each round the two directions agree with each other (both present or both absent) and S's count equals the number of existing relations (0 or 1).
7. **AS-07** — **Given** U already follows 3 accounts (the test limit), **When** U follows a fourth, **Then** `422 following_limit_reached` with `{limit: 3}` and nothing is stored; **When** U re-follows one of the three, **Then** `204`; **Given** U follows 2 accounts, **When** two different follows run concurrently, **Then** exactly one answers `204`, the other `422 following_limit_reached`, and U follows exactly 3 accounts.
8. **AS-08** — **Given** no credentials (and separately an expired or tampered session), **When** any of `POST /follow/:id`, `DELETE /follow/:id`, `GET /feed`, `GET /me/following`, `GET /follow-status` is called, **Then** `401` problem+json, nothing changes.
9. **AS-09** — **Given** the follow-write profile allows 30 writes per minute per user and the read profile 120 feed reads per minute per user (frozen clock), **When** a user exceeds either, **Then** `429` problem+json with `Retry-After`, and nothing from the rejected request is stored; the write profile fails closed when the limiter is unavailable (`503`), the read profile fails open.
10. **AS-10** — **Given** buyers A and B where A follows shop S and B follows nothing, **When** B calls `GET /me/following`, `GET /follow-status?accountIds=shop:S`, and `GET /feed`, **Then** B's following list is empty, the status shows `following: false` (with the real follower count 1), the feed is empty; no route accepts another user's ID, and B's `DELETE /follow/shop:S` changes nothing for A (A still follows S).
11. **AS-11** — **Given** U follows 3 accounts at three different times, **When** `GET /me/following?limit=2`, **Then** `200 {items: [{accountId, followedAt}, …], nextCursor}` newest follow first with an opaque cursor; the second page returns the remaining item and `nextCursor: null`; `limit` of 0, 101 or `abc`, an unknown query parameter, or a tampered cursor → `400` (`validation_failed`, or `invalid_cursor` for the cursor); default limit is 50.
12. **AS-12** — **Given** U follows S1 (3 followers in total) but not S2, **When** `GET /follow-status?accountIds=shop:S1,shop:S2,shop:Unknown`, **Then** `200` with one entry per requested ID in request order: `{accountId, following: true, followerCount: 3}`, `{…following: false, followerCount: <n>}`, `{…following: false, followerCount: 0}`; more than 100 IDs or a malformed ID → `400 validation_failed`; duplicates are collapsed.

---

### User Story 2 — See followed accounts' new items in my home feed (Priority: P1)

A buyer who follows a shop sees its new products, price drops, drop announcements, auction starts and its discussion posts in their home feed within seconds, newest first, page after page without repeats or gaps.

**Why this priority**: it is the capability's reason to exist and the J05 journey's first half.

**Independent Test**: follow a shop, publish a product through the source event, wait for fan-out, read `GET /feed`.

**Acceptance Scenarios**:

1. **AS-13** — **Given** an active follower R of normal shop S (R has read the feed within 7 days), **When** `catalog.product_created` for product P of S (ACTIVE, not sandbox, price 12,900 USD minor units) is consumed and fan-out runs, **Then** `GET /feed` as R returns `{items: [{itemId, kind: "new_product", author: {accountId: "shop:S", type: "shop", name: <S's name>}, title: <P title>, payload: {productId, priceMinor: 12900, currency: "USD"}, createdAt}], nextCursor: null}`; one `feed.item_published` announcement exists for the item.
2. **AS-14** — **Given** the source events below, **When** each is consumed, **Then** exactly the listed item is created and every other event creates nothing: `catalog.product_created` ACTIVE non-sandbox → `new_product`; `catalog.product_updated` with `priceMinor` lower than the last known price (changedFields contains the price) → `price_drop {productId, previousPriceMinor, priceMinor, currency}`, at most one per product per 24 hours (a second drop within 24 h creates nothing; after 24 h it does); `discussion.post_created` → `post {postId, boardId}` authored by `user:<authorId>`; `auction.created` → `drop_announced {auctionId, productId, startsAt}`; `auction.opened` → `auction_started {auctionId, productId, endsAt}`. No item for: a price increase or equal price, an update that changes no price, a product with `isSandbox: true`, a product whose status is not ACTIVE at creation, or `product_archived` / `product_restored` / `product_deleted` (these change visibility only, see User Story 5).
3. **AS-15** — **Given** the same `catalog.product_created` event delivered twice (same `eventId`), and a different event (different `eventId`) for the same product `productVersion`, **When** both are consumed, **Then** exactly one `new_product` item exists for the product, one announcement was recorded, and followers' pages show it once; the same holds when 20 deliveries run concurrently.
4. **AS-16** — **Given** an event on any source topic whose payload fails validation (missing `productId`, `priceMinor` as a float or string, unknown `type`, or `postId` not a UUID), **When** it is consumed, **Then** it is rejected to the dead-letter destination with the reason, no item, snapshot, cache key or announcement is written, and the next valid event on the partition is processed.
5. **AS-17** — **Given** events arrive out of order, **When** `catalog.product_archived` (productVersion 5) is consumed before `catalog.product_created` (productVersion 4), **Then** the stored product copy keeps version 5 and status ARCHIVED, the late created event creates no feed item, and the product never appears in any feed; **When** `discussion.post_deleted` arrives before `discussion.post_created` for the same post, **Then** the late created event creates no item (the deletion is remembered for 30 days); **When** `auction.opened` arrives before the product's copy exists, **Then** no item is created yet and the event is retried; once the product's event is consumed the item is created exactly once.
6. **AS-18** — **Given** two published items (ms 2000, then 1000) whose pushes reach R's timeline in the order 2000, 1000, **And** another pair whose pushes arrive in the reverse order, **When** R reads `GET /feed`, **Then** both pairs are returned newest first; two items with the same millisecond are ordered by `itemId` descending, deterministically on every read.
7. **AS-19** — **Given** R follows S and 12 items of S exist (pushed-timeline window 5), **When** R pages with `GET /feed?limit=4`, following each `nextCursor`, **Then** three pages of 4, 4, 4 items are returned newest first with no duplicate and no missing item, the last `nextCursor` is `null`; items published between page requests never shift or repeat items of later pages; paging past the pushed window continues from the durable per-author history without a gap.
8. **AS-20** — **Given** a signed-in buyer, **When** `GET /feed` with `limit` 0, 51, `abc`, an unknown query parameter, or a cursor that is malformed or was edited, **Then** `400` (`validation_failed`, or `invalid_cursor` for cursors); default limit is 30, maximum 50; cursors are opaque and encode the position (time, `itemId`), not an offset.
9. **AS-21** — **Given** a buyer who follows no one, **When** `GET /feed`, **Then** `200 {items: [], nextCursor: null}`.
10. **AS-22** — **Given** `feed.item_published` for item I delivered twice to the fan-out consumer (same `eventId`), **When** both deliveries are processed, **Then** the second performs no pushes, each active follower's page contains I once, and no timeline exceeds the window; **Given** an invalid `feed.item_published` payload, **Then** it is dead-lettered with no pushes.
11. **AS-23** — **Given** items older than 90 days exist for a followed shop, **When** R reads and pages to the end, **Then** none of them is returned and the stored items and per-author history expire on their own.

---

### User Story 3 — Celebrity accounts are merged at read time (Priority: P1)

A shop with a huge audience ("Apple", 20M followers) must not turn every item into millions of writes. Its items are never pushed; each follower's read merges the celebrity's recent items into their feed in the right order.

**Why this priority**: it is the central scalability decision of the design and a named pattern (P1112).

**Independent Test**: bring a shop to the celebrity threshold, publish an item, observe zero per-follower writes and that every follower still sees it in order.

**Acceptance Scenarios**:

1. **AS-24** — **Given** shop C with 3 followers (the test threshold; two active, one inactive), **When** C's item is fanned out, **Then** the result reports `celebrity: true, pushed: 0`, no follower timeline was written, and `GET /feed` as each of the three followers (active or inactive) returns the item exactly once.
2. **AS-25** — **Given** shop N with 2 followers (below the threshold; one active, one inactive), **When** N's item is fanned out, **Then** it is pushed to the active follower only (`pushed: 1`), nothing is written for the inactive one, and both see the item on their next read (the inactive one through rebuild).
3. **AS-26** — **Given** R follows celebrity C1 and C2 and normal shop N, each with items interleaved in time (including two items with the same millisecond), **When** R reads, **Then** the page is the global newest-first merge of R's pushed timeline and both celebrities' recents, ties broken by `itemId` descending, with no duplicate even when an item is present both as a pushed entry and as a celebrity recent.
4. **AS-27** — **Given** shop S has 2 followers and publishes item I1, **When** a third buyer follows S (reaching the threshold) while a fourth item I2 is published concurrently (repeated 20 times with fresh data), **Then** each follower's page contains I1 once and I2 once, never twice and never zero times.
5. **AS-28** — **Given** C is a celebrity, **When** the in-memory state is wiped (celebrity recents, active markers, timelines), **Then** C is still treated as a celebrity (its status is derived from durable follower counts), C's recent items are rebuilt from the durable per-author history on the next read, C's next item is still not pushed, and no follower misses C's items from the last 200 items.
6. **AS-29** — **Given** C reached the threshold and later lost followers down to 1, **When** C publishes, **Then** C is still a celebrity (status is sticky; it is never demoted automatically).
7. **AS-30** — **Given** R follows celebrities C1, C2, C3 and the read of C2's recents times out (per-call timeout), **When** R reads the feed, **Then** `200` with `degraded: true`; items from the other celebrities and R's pushed timeline are intact and in order; C2's items are absent from this response only, and the next read without the fault includes them.
8. **AS-31** — **Given** the merge of k sorted lists with limit and cursor, **When** the pure merge rule is evaluated (empty lists, one list, equal timestamps across lists, duplicate IDs across lists, cursor before everything, limit larger than the total, 50 lists), **Then** the output equals the sort of the union (newest first, `itemId` descending on ties, duplicates removed, cursor exclusive, limit honoured).

---

### User Story 4 — Come back after a break and find a full feed (Priority: P2)

Only active users (seen in the last 7 days) get items pushed. A buyer who returns after weeks finds a complete feed, built on demand by pulling the recent items of everyone they follow.

**Why this priority**: it is what makes "push only to active users" safe; it caps memory and write cost.

**Independent Test**: follow shops, let 8 days pass without reading, publish items, read the feed.

**Acceptance Scenarios**:

1. **AS-32** — **Given** R follows normal shops A and B and has not read the feed for 8 days (frozen clock advanced), **When** A and B publish and fan-out runs, **Then** no write is made for R (`pushed: 0`); **When** R reads `GET /feed`, **Then** both items are returned newest first (rebuilt by pull from the per-author history), R becomes active (marker with a 7-day sliding expiry), and the next item from A is pushed to R's timeline.
2. **AS-33** — **Given** an active R whose pushed timeline was lost (list removed, active marker still present), **When** R reads, **Then** the timeline is rebuilt from the durable history, the response contains all the followed accounts' recent items (up to 50 per author, from the last 60 days), and R stays active.
3. **AS-34** — **Given** an inactive R following 5 authors, **When** 10 `GET /feed` requests run concurrently, **Then** every response is `200` and identical, contains each item once, and R's stored timeline contains each item once.
4. **AS-35** — **Given** an active R and an item pushed to R while R's rebuild is in flight (20 repetitions with fresh data, concurrent `fanOut` and `GET /feed`), **When** both complete, **Then** a read afterwards contains the pushed item exactly once; no pushed item is lost by the rebuild.
5. **AS-36** — **Given** an active R and a shop X with 3 old items (within 60 days) that R does not follow, **When** R follows X, **Then** `204`, and R's next `GET /feed` includes X's recent items in order with no duplicates; **When** R unfollows X, **Then** the very next `GET /feed` contains no item of X (even though they were pushed earlier); **When** R follows X again, **Then** X's items reappear.
6. **AS-37** — **Given** an inactive R following 30 authors with the rebuild's concurrency bound 16, **When** R reads, **Then** at most 16 history reads are in flight at any time (measured at the store edge), and every read has a timeout; **Given** the history read of one author times out, **Then** `200` with `degraded: true`, the other authors' items are served, the rebuild is not recorded as complete, and the next read retries it.

---

### User Story 5 — Deleted, hidden and unavailable content never shows (Priority: P1)

Timelines hold identifiers only. When an item is read, deleted posts, archived or deleted products, suspended or deleted shops and unfollowed authors are filtered out, because fan-out already happened.

**Why this priority**: showing deleted or moderated content to followers is a safety and trust failure, not a cosmetic one.

**Independent Test**: publish items, then delete a post, archive a product, suspend a shop, unfollow an author; each vanishes from the next read.

**Acceptance Scenarios**:

1. **AS-38** — **Given** a feed containing a `post` item, a `new_product` item and an item of shop S, **When** the post is deleted (absent from S25's batch query, with `discussion.post_deleted` consumed), **Then** the next `GET /feed` omits the post item (no consumer lag needed because S25's batch query is consulted on read); **When** `catalog.product_archived` is consumed, **Then** product-linked items (`new_product`, `price_drop`, `drop_announced`, `auction_started`) of that product are omitted; **When** `catalog.product_restored` is consumed, **Then** they return; **When** `catalog.product_deleted` is consumed, **Then** they are omitted permanently (a later `restored` with a lower `productVersion` changes nothing); **When** S's status becomes `SUSPENDED`, `DELETING` or `DELETED`, **Then** S's items are omitted; **When** it returns to `ACTIVE`, they return.
2. **AS-39** — **Given** a limit of 4 and 6 candidate items of which 2 are hidden, **When** R reads, **Then** the page contains 4 visible items (hidden ones are replaced by the next older candidates), `nextCursor` is non-null only while further candidates exist, and an unfilled page is returned only when candidates are exhausted or the scan bound (5 × limit candidates) is reached, in which case `nextCursor` is non-null so the client can continue.
3. **AS-40** — **Given** a page of 30 items from 3 shops, 10 posts and 20 product items, **When** it is hydrated, **Then** the store sees one batch read for items, one for product copies, one shop lookup (R1, one call with all distinct shop IDs, ≤ 500) and one post lookup (R1, one call with the distinct post IDs, ≤ 100); never one call per item; the four reads run in parallel (total time below the sum of their delays).
4. **AS-41** — **Given** S25's post lookup fails or times out, **When** R reads, **Then** `200` with `degraded: true`, `post` items are omitted (deleted content must never leak), all other items are served; **Given** S03's shop lookup fails, **Then** `200` with `degraded: true`, shop-authored items are omitted for that response (their visibility cannot be verified), user-authored items are served; the failures are logged with the source name and no stack trace or upstream message reaches the client.
5. **AS-42** — **Given** the in-memory store used for timelines is unreachable, **When** R reads, **Then** `200` with `degraded: true`, the feed is built by pull from the durable history (followed accounts, newest first), and an alert-worthy log line and a counter record the fallback; **Given** the durable store is unreachable, **Then** `503 feed_unavailable` problem+json with a generic `detail`, `Retry-After`, and no store name, query or stack trace.
6. **AS-43** — **Given** items of every kind, **When** a page is returned, **Then** each item has exactly `{itemId, kind, author: {accountId, type: "shop" | "user", name: string | null}, title, payload, createdAt}`, `payload` matches its kind (`new_product {productId, priceMinor, currency}`, `price_drop {productId, previousPriceMinor, priceMinor, currency}`, `post {postId, boardId}`, `drop_announced {auctionId, productId, startsAt}`, `auction_started {auctionId, productId, endsAt}`), money is an integer in minor units, `name` is the shop's name or `null` for a buyer, `createdAt` is ISO 8601 UTC; the response parses with the contract schema and contains no internal field (store IDs, bucket, raw events).

---

### User Story 6 — Fan-out stays healthy under load (Priority: P2)

Fan-out runs asynchronously: the author's action never waits for follower writes. Workers page followers, write in pipelined batches, never overload the timeline store, and recover from partial failure without duplicates or losses.

**Why this priority**: operational safety of the push path (P0609) and the stated scale targets.

**Independent Test**: publish an item for an author with more followers than the page size and check every active follower got it once; then break the store mid-way.

**Acceptance Scenarios**:

1. **AS-44** — **Given** a normal author with 5 followers (4 active) and page size 2, **When** fan-out runs, **Then** followers are read in 3 pages, the 4 active followers each get the entry once (`pushed: 4`), the store sees one batched existence check and one batched write per page (at most 2 round trips per page), and the item's own storage was written once, before the announcement.
2. **AS-45** — **Given** the timeline store signals saturation (writes slower than the latency bound or failing), **When** fan-out is running, **Then** the consumer pauses the partition, resumes after the cooldown, and once resumed every active follower has each item exactly once and nothing is lost; a counter records each pause and resume.
3. **AS-46** — **Given** fan-out fails after the first follower page (the store errors on page 2), **When** the event is redelivered, **Then** the fan-out completes and every active follower has the item exactly once (read-time and write-time deduplication), and a `feed.fanout.failed` log line carries `authorId`, `itemId` and the page reached.
4. **AS-47** — **Given** an author publishes items I1, I2, I3 in that order, **When** the announcements are consumed, **Then** they are handled in publish order (keyed by author), so one author's items are never reordered by fan-out.
5. **AS-48** — **Given** the event bus is down when an item is stored, **When** the bus returns, **Then** the item is announced at least once without any source event being redelivered; the item was never lost, and an announcement repeated after a crash is harmless (AS-22).
6. **AS-49** — **Given** any pushed timeline, active marker, celebrity recents list, or following cache entry, **When** it is written, **Then** it has an expiry (timeline and marker: 7 days from last activity; celebrity recents: 24 hours from last item; following cache: 1 hour), and the active marker's expiry slides forward on each feed read; no key without an expiry exists.
7. **AS-50** — **Given** the fan-out of an author with 3 followers completes, **When** the logs and metrics are inspected, **Then** one structured line `feed.fanout.completed` carries `{authorId, itemId, followers, pushed, skippedInactive, celebrity, durationMs, lagMs}` (no follower IDs, no personal data), and the metrics `feed_fanout_lag_seconds`, `feed_fanout_pushed_total`, `feed_rebuild_total`, `feed_degraded_total{reason}`, `feed_consumer_paused_total` are updated.
8. **AS-51** — **Given** the stored follower count of account S is 7 while 5 follower records exist, or a follow relation exists in one direction only (a crash between the two writes), **When** the daily reconciliation job runs (single run across replicas, idempotent), **Then** the count equals the number of follower records, the half-written relation is completed in the direction that records the buyer's intent (the buyer-side record wins), and a second run changes nothing.

### Edge Cases

Every case below is an acceptance scenario above:

- Double submit, concurrent identical follows, follow racing unfollow, following limit raced at its edge (AS-03, AS-06, AS-07).
- Replayed follow or unfollow, unfollow of a missing or vanished account, count never negative (AS-02, AS-05).
- Illegal input: malformed IDs, self-follow, unknown or deleted accounts, bad limits and cursors, oversized batches (AS-04, AS-11, AS-12, AS-20).
- Cross-user access: no route takes another user's ID (AS-10).
- Limits and rate limits (AS-07, AS-09).
- Duplicate, out-of-order and invalid events (AS-15, AS-16, AS-17, AS-22).
- Out-of-order pushes into a timeline (AS-18); promotion to celebrity during publishing (AS-27); push during rebuild (AS-35).
- Concurrent first reads of a returning user (AS-34).
- Lost in-memory state: timelines (AS-33) and celebrity data (AS-28); unreachable stores (AS-42).
- Partial failures of hydration sources and of fan-out (AS-30, AS-37, AS-41, AS-46).
- Filtering after fan-out: delete, archive, suspend, unfollow (AS-36, AS-38, AS-39).
- Drift between the two relation directions and the counter (AS-51).

## Requirements *(mandatory)*

### Functional Requirements

**Follow graph**

- **FR-001**: A signed-in buyer MUST be able to follow and unfollow an account (`shop:<uuid>` or `user:<uuid>`, lowercase UUID); both operations answer `204` and are idempotent (AS-01, AS-02, AS-05).
- **FR-002**: The system MUST keep each relation readable from both sides (whom a buyer follows; who follows an account) and the two sides MUST converge to the same state even after a partial failure (AS-06, AS-51).
- **FR-003**: Concurrent identical follows MUST create one relation and count it once; follow racing unfollow MUST end in a state where both sides agree and the count equals the number of relations (AS-03, AS-06).
- **FR-004**: Following MUST be refused with `404 account_not_found` for an account that does not exist: a shop is looked up through S03's exported batch query and a user through S01's (R1); shops in `DELETING`/`DELETED` and unknown or deleted users are not found; `SUSPENDED` shops can be followed. Self-follow answers `422 cannot_follow_self`; malformed IDs answer `400 validation_failed` (AS-04).
- **FR-005**: A buyer MUST NOT follow more than the configured limit (default 2,000) accounts; the limit holds under concurrent requests; re-following an existing relation at the limit succeeds (AS-07).
- **FR-006**: Unfollowing MUST work for accounts that no longer exist and MUST never drive a count below 0 (AS-05).
- **FR-007**: A buyer MUST be able to list whom they follow, newest follow first, with keyset pagination (`limit` 1–100, default 50, opaque cursor) and nothing else about other users (AS-10, AS-11).
- **FR-008**: A buyer MUST be able to read follow status and follower count for up to 100 accounts in one call (AS-12).
- **FR-009**: The follower count of an account MUST equal the number of its follower records; drift MUST be corrected by a scheduled reconciliation that runs once per schedule across replicas and is idempotent (AS-51).
- **FR-010**: Follow and unfollow MUST be rate limited per user under the `follow.write` profile (`429` with `Retry-After`; fail closed) and feed reads under `feed.read` (fail open) (AS-09).
- **FR-011**: Every route MUST reject unauthenticated callers with `401`; every response and error MUST be a contract-typed body or RFC 9457 problem+json with no internals (AS-08, AS-42).

**Feed items**

- **FR-020**: The system MUST turn the following source events into feed items, each stored once with a copy of the fields it shows: `catalog.product_created` → `new_product`; `catalog.product_updated` with a lower price → `price_drop` (at most one per product per 24 hours); `discussion.post_created` → `post`; `auction.created` → `drop_announced`; `auction.opened` → `auction_started` (AS-14).
- **FR-021**: Items MUST NOT be created for sandbox products, products not ACTIVE at creation, price increases, or updates that change no price (AS-14).
- **FR-022**: Item creation MUST be idempotent per source: one item per `(kind, source)` regardless of duplicate or concurrent delivery, with no dependence on a time-limited marker (AS-15).
- **FR-023**: The system MUST keep its own copy of the product fields it needs (`productId`, `shopId`, `title`, `priceMinor`, `currency`, `status`, `isSandbox`, `productVersion`) from S05's snapshot events, apply them only when `productVersion` is newer than the stored one, and never read the catalog's tables (AS-17).
- **FR-024**: A deletion seen before its creation (post deleted before created; product archived or deleted at a newer version before created) MUST prevent the item from appearing (AS-17).
- **FR-025**: A source event that cannot be applied yet because the product copy it needs does not exist MUST be retried with backoff (at most 5 attempts) and then dead-lettered; it MUST NOT produce a partial item (AS-17).
- **FR-026**: Every stored item MUST be announced at least once on `feed.item_published` even if the bus is unavailable at storing time, without requiring a source event to be redelivered; repeated announcements MUST be harmless (AS-13, AS-22, AS-48).
- **FR-027**: Every consumer in this capability (product copy and item projector, discussion projector, auction projector, fan-out) MUST be idempotent (inbox by `eventId` or version-guarded upsert), validate its payload with a schema, and dead-letter invalid payloads without side effects (AS-15, AS-16, AS-22).
- **FR-028**: Items and per-author history older than 90 days MUST not be served and MUST expire (AS-23).

**Hybrid fan-out (P0609, P1112, notes §9)**

- **FR-030**: For a normal account, fan-out MUST push the item's identifier (never its body) into the timelines of its active followers only, pushing in pipelined batches per follower page and keeping at most the configured window (default 800) newest entries per timeline (AS-25, AS-44).
- **FR-031**: Inactive followers (no feed read within 7 days) MUST receive no write (AS-25, AS-32).
- **FR-032**: An account whose follower count has reached the celebrity threshold (default 10,000, configurable) MUST never be fanned out; its items are placed in a bounded recent list (200 newest) and merged into each follower's read; celebrity status is derived from the durable count, survives loss of in-memory state, and is never demoted automatically (AS-24, AS-28, AS-29).
- **FR-033**: A page MUST be the newest-first merge of the reader's pushed timeline and the recent lists of every celebrity they follow, deterministic on ties (`itemId` descending), without duplicates, honouring the cursor (AS-26, AS-31).
- **FR-034**: Pushes arriving out of order MUST NOT break newest-first ordering of the pushed timeline (AS-18).
- **FR-035**: Promotion to celebrity concurrent with publishing MUST NOT lose or duplicate an item (AS-27).
- **FR-036**: Fan-out MUST be asynchronous and ordered per author; the author's action never waits for follower writes (AS-47).
- **FR-037**: The fan-out consumer MUST apply backpressure: pause the partition when the timeline store signals saturation and resume after a cooldown, losing nothing (AS-45).
- **FR-038**: A fan-out failure part-way MUST be recoverable by redelivery with every active follower ending up with the item exactly once (AS-46).
- **FR-039**: Every in-memory key MUST have an expiry; the in-memory stores are caches that can be rebuilt from durable data (AS-28, AS-33, AS-49).

**Reading and hydration**

- **FR-040**: `GET /feed` MUST return the buyer's feed with keyset pagination (`limit` 1–50, default 30, opaque cursor of time and `itemId`), `nextCursor: null` at the end, and `degraded: true` when any optional part could not be served (AS-19, AS-20, AS-21, AS-30).
- **FR-041**: Paging beyond the pushed window MUST continue from durable per-author history without gaps or duplicates (AS-19).
- **FR-042**: A reader inactive for more than 7 days, or whose pushed timeline is absent, MUST get it rebuilt from the recent items of every followed non-celebrity account (up to 50 per author, last 60 days); the rebuild is concurrency-bounded, time-bounded, safe under concurrent reads, loses no concurrent push, and is recorded as complete only when every author was read (AS-32, AS-33, AS-34, AS-35, AS-37).
- **FR-043**: Following an account MUST make its recent items visible on the next read; unfollowing MUST hide its items on the next read (AS-36).
- **FR-044**: Items MUST be hydrated in batches, one read per source per page, with the independent sources queried in parallel under per-call timeouts and a partial result when an optional source fails (P0101) (AS-40, AS-41).
- **FR-045**: Items MUST be hidden at read time when: the author is no longer followed; a post is absent from S25's batch query (R1, ≤ 100 IDs); a product-linked item's product copy is not ACTIVE or is sandbox; the author shop is not `ACTIVE` per S03's batch query (R1, ≤ 500 IDs) (AS-38).
- **FR-046**: When a source that decides visibility cannot be queried, the items depending on it MUST be omitted (fail closed) and the response marked `degraded: true`; independent items are still served (AS-41).
- **FR-047**: A page MUST be filled to `limit` from further candidates when filtered items leave it short, scanning at most 5 × `limit` candidates; `nextCursor` is non-null while candidates remain (AS-39).
- **FR-048**: When the timeline store is unreachable, the feed MUST be served from durable history with `degraded: true`; when the durable store is unreachable the response is `503 feed_unavailable` (AS-42).
- **FR-049**: Item and page shapes MUST follow AS-43 exactly; money is integer minor units.

**Observability and operations**

- **FR-050**: Fan-out, rebuild, degradation and consumer pauses MUST emit the structured log lines and metrics of AS-50 without personal data or follower identifiers.
- **FR-051**: Cross-domain data MUST come only through these mechanisms: S03 `ShopQueryService.getShopsByIds` (R1), S01 `UserDirectoryService.getUsersByIds` (R1), S25 `DiscussionQueryService.getPostsByIds` (R1), and S05, S21 and S25 events (R3, into stores owned by `community`). `community` MUST NOT read, join, associate or inject another domain's tables or models (IX.4, IX.5).
- **FR-052**: No other domain MUST be able to publish into the feed in-process: feed items are created only from events.

### Key Entities

- **Follow relation**: a buyer follows an account, with the time of following. Readable by buyer and by account. Private to the buyer.
- **Account**: a shop or a buyer, identified as `shop:<uuid>` or `user:<uuid>`; has a follower count and a celebrity status.
- **Feed item**: something that happened, authored by an account, of a kind (`new_product`, `price_drop`, `post`, `drop_announced`, `auction_started`), with a title, a kind-specific payload copied at creation, a creation time that orders it, and a visibility that can change (hidden or visible).
- **Timeline**: a buyer's bounded, newest-first list of item identifiers pushed for them; a cache that can be rebuilt.
- **Celebrity recents**: the 200 newest item identifiers of a celebrity account; a cache that can be rebuilt.
- **Product copy**: the few product fields the feed needs, with the product's version; owned by `community`, fed by catalog events.
- **Activity marker**: whether a buyer read their feed in the last 7 days.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An item from a normal author is visible in every active follower's feed within 5 seconds at the 99th percentile for an author with 10,000 followers (AS-13, AS-44; load script).
- **SC-002**: Publishing an item from an account at or above the celebrity threshold causes 0 writes per follower (AS-24).
- **SC-003**: Items from normal authors cause 0 writes for inactive followers; with 30% of followers active, write volume is at most 30% of the all-followers volume (AS-25, AS-32).
- **SC-004**: 95% of feed page loads for a user with a populated timeline return in under 300 ms, and a returning user's first page after a rebuild (500 followed accounts) in under 2 seconds.
- **SC-005**: Paging through a feed of 100 items yields every visible item exactly once, newest first, in 100% of runs, including while new items are published (AS-19).
- **SC-006**: A deleted post, archived product, suspended shop or unfollowed author never appears on the next feed read (0 leaks across AS-36, AS-38).
- **SC-007**: 20 concurrent identical follows, and follow-versus-unfollow races, leave counts equal to the number of relations in 100% of runs (AS-03, AS-06).
- **SC-008**: After the in-memory stores are wiped, the next read of every user returns the same items as before the wipe with no manual step (AS-28, AS-33).
- **SC-009**: A saturated timeline store causes 0 lost and 0 duplicated items once it recovers (AS-45, AS-46).
- **SC-010**: Errors never reveal internals: 0 stack traces, store names or query text in 5xx bodies (AS-42).

## Cross-capability contracts

**Provides** (exact names):

- **HTTP endpoints** (all under `/api`, `Firewall()` on every one, problem+json errors, zod schemas in `packages/contracts`):
  - `POST /follow/:accountId` → `204`; `DELETE /follow/:accountId` → `204`. `accountId` = `shop:<uuid>` | `user:<uuid>` (lowercase UUID). Errors: `400 validation_failed`, `404 account_not_found`, `422 cannot_follow_self`, `422 following_limit_reached {limit}`, `429` with `Retry-After`. Rate profile `follow.write`.
  - `GET /me/following?limit=1..100&cursor=` → `200 {items: {accountId, followedAt}[], nextCursor: string | null}` (schema `FollowingPage`).
  - `GET /follow-status?accountIds=<comma-separated, ≤ 100>` → `200 {accountId, following: boolean, followerCount: number}[]` (schema `FollowStatus`). **Consumers: W02 / S48 (shop page follow button, R2 over HTTP), J05.**
  - `GET /feed?limit=1..50&cursor=` → `200 {items: FeedItemView[], nextCursor: string | null, degraded?: true}` (schema `FeedPage`); `FeedItemView = {itemId, kind: "new_product" | "price_drop" | "post" | "drop_announced" | "auction_started", author: {accountId, type: "shop" | "user", name: string | null}, title, payload, createdAt}`; `payload` per kind as in AS-43. Rate profile `feed.read`. **Consumers: the future home-feed page (owner not assigned, see questions), J05.**
- **Event** (recorded with the item, published at least once; envelope per constitution IV.4: `eventId`, `type`, `version`, `occurredAt`, `aggregateId = itemId`): `feed.item_published` v1 `{itemId, authorId, kind, createdAt}` on topic `feed.events`, keyed by `authorId`. **Consumers: this capability's fan-out; S28 may consume it for "new from a shop you follow" notifications (not required).** No event for follows or unfollows.
- **R1 exports**: none. The feed's publisher is no longer exported or injectable by other domains (FR-052).
- **Operations**: metrics `feed_fanout_lag_seconds`, `feed_fanout_pushed_total`, `feed_rebuild_total`, `feed_degraded_total{reason}`, `feed_consumer_paused_total`; log line `feed.fanout.completed`.

**Requires** (owner, exact shape assumed):

- **S05** events on topic `products.events`, key `productId`, envelope `{eventId, type, version: 1, occurredAt, aggregateId}`: `catalog.product_created|updated|archived|restored` payload `{productId, shopId, title, priceMinor, currency, status: "ACTIVE" | "ARCHIVED", isSandbox, productVersion, changedFields: string[], createdAt, updatedAt}` (other fields ignored); `catalog.product_deleted` `{productId, shopId, productVersion}`. A price change is signalled by `changedFields` containing `"priceMinor"`; the previous price is taken from this capability's own copy. Consumer: this capability's product projector (R3).
- **S25** events on topic `discussion.events`, key `postId`: `discussion.post_created` v1 `{postId, boardId, authorId, title, createdAt}` and `discussion.post_deleted` v1 `{postId, boardId, deletedBy}`; R1 `DiscussionQueryService.getPostsByIds(ids: PostId[]): Promise<Map<PostId, PostSummaryDto>>` (≤ 100 IDs, one batch; deleted and shadow posts are absent; fields used: `postId`, `title`).
- **S21** events on topic `auctions.events`, key `auctionId`: `auction.created` v1 `{startsAt, endsAt, auctionVersion, shopId, productId}` and `auction.opened` v1 `{endsAt, auctionVersion, shopId, productId}` (envelope aggregate = `auctionId`).
- **S03** `ShopQueryService.getShopsByIds(ids: ShopId[]): Promise<Map<ShopId, ShopSummaryDto>>` (R1, ≤ 500, unknown IDs absent, one query); fields used: `id`, `name`, `status: "ACTIVE" | "SUSPENDED" | "DELETING" | "DELETED"`.
- **S01** `Firewall()`, `@User()` with `AuthenticatedUser = {id, role, sessionId, amr}`; `UserDirectoryService.getUsersByIds(ids: UserId[]): Promise<Map<UserId, UserSummaryDto>>` (R1, ≤ 500; unknown and deleted users absent; only `id` is used).
- **S50** rate-limit profiles `follow.write` (30 per minute per user, token bucket, fail closed) and `feed.read` (120 per minute per user, fail open), answering `429` with `Retry-After`; no other capability may reuse these names.
- **S53** event envelope and producer (`defineEvent`, keyed send), consumer framework (idempotent consumers, dead-lettering, partition pause/resume for backpressure, retry with backoff); this capability records its own events in its own store and relays them (it owns no PostgreSQL table, so the outbox table would be a dual write).
- **S49** a single-run scheduled job facility for the daily reconciliation and the announcement relay.
- **Clock**: an injected clock port (ID timestamps, active window, retention, 24-hour price-drop rule).
- **Contracts package**: schemas `FeedPage`, `FeedItemView`, `FollowingPage`, `FollowStatus`.

## Assumptions

- Every default below is also a line in `questions.md`.
- **Celebrity threshold is 10,000 followers** (configurable). SD-09's table says 50k and its implementation notes 10k; notes §9 says "~10k–100k". Status is derived from the durable count and never demoted automatically; a second-order gap (items published while celebrity and not yet pushed) is thereby avoided.
- **Only active users (read within 7 days) receive pushes**; the pushed window is 800 entries. Feed retention is 90 days; rebuild pulls up to 50 items per followed author from the last 60 days.
- **No durable per-user timeline table**: returning users are rebuilt by pull, as SD-09's implementation notes decided; this is also what notes §9 calls "built on demand when they return".
- **Item identifiers are time-ordered** (Snowflake-like), so the cursor is the position `(time, itemId)` and needs no offset.
- **Following is naturally idempotent** (set semantics), so it takes no `Idempotency-Key` (constitution V.6 lists creations of orders, payments, bookings, bids and ledger movements).
- **Following limit 2,000** per buyer keeps a rebuild's cost bounded.
- **Authors are shown as `accountId` plus the shop's name**; buyers have no public display name (same decision as S25 and S24).
- **Hydration visibility**: posts and shops are checked synchronously on read (R1) because deletion and suspension must take effect at once; products are checked against this capability's own copy (R3, staleness bounded by event delay, accepted maximum 10 seconds) so a catalog outage never blanks the feed.
- **Fail closed on visibility, fail open on decoration**: an unverifiable item is omitted and the response is marked degraded.
- **Restock items, seller-authored "shop posts", muting and blocking** are not part of this capability.
- **Account deletion**: purging a deleted user's follows needs an identity deletion event that S01 does not yet publish; until then follows of deleted users stay stored and are never shown to anyone.
