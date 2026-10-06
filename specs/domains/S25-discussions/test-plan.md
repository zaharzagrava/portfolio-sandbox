# Test Plan: S25 — Product discussions (domain `community`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (55 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. A unit entry proves the pure rule table; the API e2e entry of the same row proves one wired case through the real stack, never the table again.

- API e2e files live in `packages/backend/libs/domains/community/` and boot the real `DiscussionsModule`, `DiscussionsWorkerModule` (jobs, relay) and the identity and catalog modules they import, with the production global prefix, `ValidationPipe`, problem+json filter and interceptors, called through `supertest`, against real ScyllaDB (CQL migrations applied), Redis and Kafka stand-ins from `docker-compose.test.yaml`. Each file's top-level `describe` names its feature (VII.8). The existing `discussions.e2e-spec.ts` calls services directly: it is replaced by the files below, which must call HTTP.
  - `discussions-posts.e2e-spec.ts` — describe "Product discussions: boards, posts and idempotent create"
  - `discussions-comments.e2e-spec.ts` — describe "Product discussions: nested comments, threads and tombstones"
  - `discussions-votes.e2e-spec.ts` — describe "Product discussions: votes, concurrency and rate limits"
  - `discussions-ranking.e2e-spec.ts` — describe "Product discussions: hot, top, new, best, paging and cache"
  - `discussions-markdown.e2e-spec.ts` — describe "Product discussions: safe markdown over HTTP"
  - `discussions-abuse.e2e-spec.ts` — describe "Product discussions: abuse controls and moderation"
  - `discussions-resilience.e2e-spec.ts` — describe "Product discussions: derived-state recovery, outages and observability" (includes the reconciliation job, the event relay duplicate-delivery test and the invalid-recorded-event test, VII.4)
- Users, products and moderators are seeded only through the shared fixture helpers, the identity fixture (`SessionIssuer`) and catalog's exported services; no spec injects `UserModel` or `ProductModel` (D-7). Account age (AS-44) is set through the identity fixture's `createdAt`. The clock is frozen and advanced explicitly.
- Only system edges are faked: identity token verification, the event bus (a spy plus a switchable failure), and the clock. Faults for the ranking cache and the durable store (AS-51, AS-52) are injected through switchable wrappers at the driver edge, never by stubbing community's own services. The same edge wrapper counts rows read per page (AS-18). The configuration overrides used by tests: top-level partition size 5, ranking cap 3.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`) and exist only for pure logic (VII.5): `ranking.spec.ts` (hot, Wilson), `content.spec.ts` (markdown allow-list and XSS corpus, complexity), `ids.spec.ts` (time-based IDs), `paths.spec.ts` (thread positions, partition spill), `top-window.spec.ts`, `vote-weight.spec.ts`, `vote-transition.spec.ts` (delta computation; `fast-check` property: for any sequence of votes by any users the derived counts equal the count of final records), `anomaly.spec.ts`, `cursor.spec.ts` (opaque keyset cursors, tamper detection). Controllers, repositories and glue get no unit tests.
- UI journey (Playwright): one happy-path journey owned by W02 in `packages/web/tests/product-community.spec.ts` — a buyer opens a product's Discussions tab, starts a discussion with a markdown body (bold rendered, no raw HTML), upvotes it, replies to it, and sees the score and the reply. Rows marked "W02 journey" below are the only UI coverage S25 asks for; edge cases are never re-tested there. FE unit and component tests (Vitest + RTL + MSW) for the board components belong to W02.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (no community finding); `pnpm check:module-graph`; `pnpm check:model-registry`.
- Gate 9 (VII.9) fallback/degradation tests that force the fault: AS-07 (bus down), AS-45 (user directory failing), AS-49 (cache emptied), AS-50 (drift injected), AS-51 (ranking cache down), AS-52 (store timeout).
- Concurrency tests use `Promise.all` and assert that exactly the allowed number succeed and the invariant holds (VII.3), repeated at least 20 times in one test: AS-06, AS-17, AS-19, AS-23, AS-29, AS-30.
- Rate-limit tests (VII.3) freeze the clock: AS-05, AS-31. Idempotency tests (VII.3: replay, in-flight, different body): AS-06, AS-17.
- Async relay (VII.4): the event relay in `discussions-resilience.e2e-spec.ts` gets a duplicate-delivery test (same `eventId` delivered twice → one effect in the consumer spy contract) and an invalid-recorded-event test (rejected or dead-lettered, no side effect), under AS-07.
- Every e2e response is parsed with the matching `packages/contracts` schema (VII.6) and every test asserts the response body and the persisted state (store rows, ranking cache keys and TTLs, recorded events) (VII.2).
- The k6 vote-storm script `scripts/load-tests/discussions.test.js` (`pnpm loadtest:discussions`: 10,000 votes per second plus board reads; invariant: final count equals distinct voters; p99 read < 50 ms, vote < 30 ms) proves SC-002, SC-003 and SC-005. It is an ops artifact, not part of this table.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create post | `discussions-posts.e2e-spec.ts` | W02 journey (start a discussion) | `ids.spec.ts` (ID time = `createdAt`) |
| AS-02 board validity (unknown, archived, non-UUID, legacy ids) | `discussions-posts.e2e-spec.ts` | — | — |
| AS-03 post validation (title, body, control and bidi characters, unknown field) | `discussions-posts.e2e-spec.ts` (one case per failure class) | — | `content.spec.ts` (title normalisation table) |
| AS-04 unauthenticated writes → 401 | `discussions-posts.e2e-spec.ts` (every state-changing route) | — | — |
| AS-05 write rate limit → 429 | `discussions-posts.e2e-spec.ts` | — | — |
| AS-06 post idempotency (replay, different body, in-flight, concurrent, user scope, TTL) | `discussions-posts.e2e-spec.ts` | — | — |
| AS-07 event recorded with the write; bus down; shadow posts record none; relay duplicate and invalid event | `discussions-resilience.e2e-spec.ts` | — | — |
| AS-08 markdown allow-list (tags, attributes, link rel/target, headings) | `discussions-markdown.e2e-spec.ts` (one wired post) | W02 journey (bold rendered) | `content.spec.ts` (table of FR-040) |
| AS-09 XSS corpus on posts and comments | `discussions-markdown.e2e-spec.ts` (whole corpus posted once; stored raw markdown unchanged) | — | `content.spec.ts` (every payload) |
| AS-10 old rendition re-rendered on read | `discussions-markdown.e2e-spec.ts` | — | — |
| AS-11 title verbatim, JSON content type, nosniff | `discussions-markdown.e2e-spec.ts` | — | — |
| AS-12 markdown complexity bound | `discussions-markdown.e2e-spec.ts` (one over-limit body → 400; one max-size body in time) | — | `content.spec.ts` (nesting counter table) |
| AS-13 create comment and reply | `discussions-comments.e2e-spec.ts` | W02 journey (reply) | — |
| AS-14 thread order, sorts old and new | `discussions-comments.e2e-spec.ts` | — | `paths.spec.ts` |
| AS-15 reply denials (other post, unknown, deleted parent, depth 8, non-UUID) | `discussions-comments.e2e-spec.ts` | — | `paths.spec.ts` (depth table) |
| AS-16 comment denials (post gone, closed board, body, key) | `discussions-comments.e2e-spec.ts` | — | — |
| AS-17 comment idempotency, concurrent identical creates | `discussions-comments.e2e-spec.ts` | — | — |
| AS-18 partition spill, replies stay with their root, bounded rows per page | `discussions-comments.e2e-spec.ts` (partition size 5) | — | `paths.spec.ts` (bucket assignment) |
| AS-19 concurrent comments, frozen clock, unique ordered IDs | `discussions-comments.e2e-spec.ts` | — | `ids.spec.ts` (same-millisecond uniqueness) |
| AS-20 replies embedded and "load more", cursor tampering | `discussions-comments.e2e-spec.ts` | — | `cursor.spec.ts` |
| AS-21 author deletes → tombstone, idempotent | `discussions-comments.e2e-spec.ts` | — | — |
| AS-22 delete authorization (other user, moderator, seller, unknown) | `discussions-comments.e2e-spec.ts` | — | — |
| AS-23 reply racing with parent delete | `discussions-comments.e2e-spec.ts` | — | — |
| AS-24 vote, flip, retract (post and comment) | `discussions-votes.e2e-spec.ts` | W02 journey (upvote) | `vote-transition.spec.ts` (delta table, property test) |
| AS-25 vote replay and no-op retract | `discussions-votes.e2e-spec.ts` | — | — |
| AS-26 vote validation, unknown target, client `targetType` refused | `discussions-votes.e2e-spec.ts` | — | — |
| AS-27 self-vote refused | `discussions-votes.e2e-spec.ts` | — | — |
| AS-28 vote on deleted targets | `discussions-votes.e2e-spec.ts` | — | — |
| AS-29 100 concurrent voters count exactly 100 | `discussions-votes.e2e-spec.ts` | — | — |
| AS-30 same-user concurrent votes, +1 vs −1 race | `discussions-votes.e2e-spec.ts` | — | — |
| AS-31 vote rate limit → 429 | `discussions-votes.e2e-spec.ts` | — | — |
| AS-32 `myVote` for signed-in and anonymous readers | `discussions-votes.e2e-spec.ts` | — | — |
| AS-33 hot order (votes vs age), new order | `discussions-ranking.e2e-spec.ts` | W02 journey (new post appears first) | — |
| AS-34 hot formula, tiebreak | `discussions-ranking.e2e-spec.ts` (one tie, stable order) | — | `ranking.spec.ts` (formula table incl. 10× = 45,000 s, signs, rounding) |
| AS-35 paging through hot, top, new; vote moving a post across the cursor | `discussions-ranking.e2e-spec.ts` | — | `cursor.spec.ts` (keyset position) |
| AS-36 top windows, inclusive boundary, ties | `discussions-ranking.e2e-spec.ts` | — | `top-window.spec.ts` (window table) |
| AS-37 new across month boundaries and 30 months back; empty board | `discussions-ranking.e2e-spec.ts` | — | — |
| AS-38 ranking cap | `discussions-ranking.e2e-spec.ts` (cap 3) | — | — |
| AS-39 invalid sort, window, limit, cursor; defaults | `discussions-ranking.e2e-spec.ts` | — | — |
| AS-40 empty and unknown board, deleted post absent | `discussions-ranking.e2e-spec.ts` | — | — |
| AS-41 get one post | `discussions-posts.e2e-spec.ts` | — | — |
| AS-42 best order, Wilson table, ties | `discussions-ranking.e2e-spec.ts` | — | `ranking.spec.ts` (Wilson table: (0,0), (1,0), (90,10), (9,1), monotonicity) |
| AS-43 first-page cache: write invalidates, vote lag ≤ 5 s, no viewer data in cache | `discussions-ranking.e2e-spec.ts` (frozen clock +4 s / +6 s; cache key inspection) | — | — |
| AS-44 new-account weight: ranking vs display, fixed at cast time | `discussions-abuse.e2e-spec.ts` | — | `vote-weight.spec.ts` (age table: 23 h 59 m, 24 h, shadow, unresolved) |
| AS-45 account lookup failure → weight 0 | `discussions-abuse.e2e-spec.ts` (user directory faulted at the edge) | — | — |
| AS-46 shadow ban set, lift, visibility, authorization, unknown user | `discussions-abuse.e2e-spec.ts` | — | — |
| AS-47 delete post (author, moderator, others), idempotent, comments unreachable | `discussions-posts.e2e-spec.ts` | — | — |
| AS-48 vote anomaly signal, once per hour | `discussions-abuse.e2e-spec.ts` | — | `anomaly.spec.ts` (threshold, window, dedupe table) |
| AS-49 ranking cache emptied → counts and orders recover, every key has a TTL | `discussions-resilience.e2e-spec.ts` | — | — |
| AS-50 drift repaired by reconciliation | `discussions-resilience.e2e-spec.ts` (job handler run through the jobs service) | — | — |
| AS-51 cache down: degraded reads, votes 503, creates continue | `discussions-resilience.e2e-spec.ts` | — | — |
| AS-52 store timeout, retry with the same key, generic 5xx | `discussions-resilience.e2e-spec.ts` | — | — |
| AS-53 problem+json on every error class | `discussions-resilience.e2e-spec.ts` (the problem+json shape of 5xx, 401 and unknown-route responses; the 4xx bodies of each scenario are shape-checked in the file that owns that scenario) | — | — |
| AS-54 logs: requestId, no bodies, metrics | `discussions-resilience.e2e-spec.ts` (captured log stream scan) | — | — |
| AS-55 ID order equals creation order; GET never changes state | `discussions-resilience.e2e-spec.ts` | — | `ids.spec.ts` (sort by ID = sort by time) |
