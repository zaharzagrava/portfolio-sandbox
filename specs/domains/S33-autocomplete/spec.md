# Feature Specification: S33 — Search Autocomplete (Query-Log Top-K Index, Catalog Completions, Per-Source Budgets, Typo Fallback) (domain `discovery`)

**Feature Branch**: `S33-autocomplete` (spec directory `specs/domains/S33-autocomplete`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S33 of `scripts/sdd/capabilities.tsv`. Sources: `docs/showcase/sections/SD-12-autocomplete.md`, note `10-System-Design/05-social-and-content.md` (design 12, search autocomplete / typeahead), `04/01` §2.1 (blend with per-source timeouts), `10/09` #37 (typo tolerance), `11/03` (trie). Pattern map row **P1101** (trie with per-node top-K). Contracts honoured from `specs/domains/S32-product-search/spec.md` (Provides: `ProductTitleSuggester`, `search.performed`, index guarantees) and the W02 / S05 / S19 scope notes.

## Scope

Everything a **buyer** sees in the drop-down while typing in the search box, and the machinery that keeps those suggestions fast, safe and fresh:

- **Suggest endpoint** (`GET /suggest`): per-keystroke, anonymous, CDN-cacheable, one blended list of query suggestions, catalog completions and typo-corrected completions.
- **Query-log top-K index**: a prefix → top-K completions index built offline from what people actually searched, held in memory on every serving node, hot-swapped when a new version is published.
- **Offline build**: hourly aggregation of the search log into a versioned, integrity-checked snapshot (popularity floor, privacy and blocklist filters, caps), with safe publication and retention.
- **Catalog completions**: product-title completions for the same prefix, read only through S32's `ProductTitleSuggester` (visible products only).
- **Per-source budgets and degradation**: each source has its own time budget, its own failure isolation, a circuit breaker for the catalog source and a short per-prefix cache; a slow or dead source never fails the request.
- **Typo fallback**: when nothing matches the prefix, fuzzy title completions are offered.
- **Safety**: blocklist applied at build and at serve time to every source; no personal data in the index or in logs; identical answers for every caller.
- **Platform**: rate limit, cache headers, problem+json errors, metrics, configuration validation, module boundary.

Out of scope (owners named):

- Search results, ranking, typo-tolerant result matching, the search log's capture (`search.performed`), query redaction, the title-completion index and its visibility rules → **S32** (same domain; this capability only reads the log and calls `ProductTitleSuggester`).
- Trending terms from a streaming top-K, "bought together" → **S35**, **S34**. A trending blend is not built here; the response shape leaves room (see Assumptions and `questions.md`).
- Personalised suggestions (user history), spelling correction of the search box itself ("did you mean"), suggestions of users, shops or categories. Not built.
- The search page, debounce, request cancellation and the rendering of the drop-down → **W02**. This spec states what W02 must do to use the endpoint correctly (Provides) and has one happy-path UI scenario (AS-55) and one client-race scenario (AS-56).
- CDN configuration (edge cache rules honouring the headers below) → operations artifact. Rate-limit policy registry → **S50**. Scheduled-job engine → **S49**. Problem+json filter, metrics registry, request context, config validation → **S54**.
- Postgres tables: `discovery` owns none for this capability (domain-map). The snapshot objects, the version pointer and the in-memory index are this capability's own stores.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See helpful suggestions as I type (Priority: P1)

A buyer types `iph` in the search box and, within a blink, sees what other people search for (`iphone 17`, `iphone charger`, …) followed by matching products (`Apple iPhone 17 Pro 256GB`). Popular searches come first. The list never contains offensive terms, personal data or products that are not for sale.

**Why this priority**: this is the capability; without it the drop-down is empty.

**Independent Test**: seed searches and products, run the build, call `GET /suggest?q=iph`.

**Acceptance Scenarios**:

1. **AS-01** (blended answer) — **Given** the search log of dataset S (below) has been built and published, and the product index holds the visible products `Apple iPhone 17 Pro 256GB` and `iPhone 17 Silicone Case`, **When** an anonymous client calls `GET /api/suggest?q=IPH`, **Then** `200` with `{prefix: "iph", suggestions: [{text: "iphone 17", source: "query"}, {text: "iphone charger", source: "query"}, {text: "iphone 17 pro max case", source: "query"}, {text: "Apple iPhone 17 Pro 256GB", source: "catalog"}, {text: "iPhone 17 Silicone Case", source: "catalog"}], degraded: []}`, header `Cache-Control: public, max-age=60, s-maxage=60`, no `Set-Cookie`, and the body parses with `suggestResponseSchema`. The index is unchanged by the call.
2. **AS-02** (order and replay) — **Given** `iphone 17` (50 searchers) and `iphone charger` (20) and two queries `iphone case` and `iphone cable` both with 20 searchers, **When** `q=iph` is called twice, **Then** both answers are byte-identical: queries by distinct searchers descending, equal counts ordered by text ascending (`iphone cable` before `iphone case`), catalog entries in the engine's order.
3. **AS-03** (limit) — **When** `limit` is omitted, **Then** at most 8 suggestions; `limit=3` returns at most 3 following the allocation of FR-007; `limit=0`, `limit=11`, `limit=abc`, `limit=2.5` each answer `400` (AS-06 shape).
4. **AS-04** (normalisation) — **When** `q` is `%20IPh%20%20one`, `ＩＰＨＯＮＥ` (fullwidth), `iPh\u0000one` (control character) or `IPH` with a trailing tab, **Then** each is reduced as S32 does (Unicode compatibility folding, control characters removed, whitespace collapsed, trimmed, lower-cased), the response `prefix` shows the reduced form (`iph one`, `iphone`, `iphone`, `iph`) and the suggestions equal those of the same reduced prefix typed plainly.
5. **AS-05** (nothing typed) — **When** `q` is the empty string, a single space or only control characters, **Then** `200 {prefix: "", suggestions: [], degraded: []}` with `Cache-Control: public, max-age=60, s-maxage=60`, and neither the query index nor any engine is consulted (spy counts 0).
6. **AS-06** (validation) — **When** `q` is missing, longer than 100 characters after normalisation, an unknown query parameter `foo=1` is sent, or `limit` is invalid (AS-03), **Then** `400` `application/problem+json` with `type`, `title`, `status: 400`, `detail`, `instance`, `requestId`, `code: "validation_failed"` and `errors: [{field, message}]` naming the offending parameter; nothing is truncated silently and nothing is consulted.
7. **AS-07** (hostile text) — **When** `q` is `iph*`, `iph?`, `" OR 1=1 --`, `<script>alert(1)</script>`, `{"$ne":1}`, a 100-character string of `(`, or an emoji-only string, **Then** every call answers `200`, wildcard and operator characters are plain text (`iph*` does not match `iphone 17`; it returns no query suggestions), the body is JSON that echoes only the reduced prefix, and the response never contains an engine error, stack trace or index name.
8. **AS-08** (anonymous access) — **When** the call is made without credentials, with a valid access token, or with an invalid or expired bearer token, **Then** all three answer `200` with identical bodies (an invalid token is ignored, not a `401`).
9. **AS-09** (rate limit) — **Given** policy `discovery.suggest` allows 600 requests per minute per address, **When** one address sends 601 requests in one minute, **Then** the 601st answers `429` problem+json `code: "rate_limited"` with `Retry-After` (whole seconds, ≥ 1) and `Cache-Control: no-store`; **When** the rate-limit store is unavailable, **Then** every request answers `200` (fail open).
10. **AS-10** (errors are never cached) — **When** any `400` or `429` response is produced, **Then** it carries `Cache-Control: no-store` and the problem+json body of AS-06.
11. **AS-11** (long prefixes and long queries) — **Given** a published query `waterproof bluetooth speaker with 20 hour battery` (46 characters, 40 searchers), **When** `q=waterproof bluetooth s` (24 characters) and `q=waterproof bluetooth speaker with` (35 characters) are called, **Then** both return it (prefix lookups deeper than 20 characters are filtered exactly against the stored list of the 20-character prefix, so they are best-effort: a query that was not among the top K of its 20-character prefix is not returned) and the suggestion text is the full 46-character query.
12. **AS-12** (blocklist is applied when serving) — **Given** a published snapshot that contains `cheap iphone` (30 searchers) and a visible product titled `Cheap iPhone Stand`, **When** the blocklist configuration is changed to include the term `cheap` and the service picks it up (restart or reload) without a new build, **Then** `q=cheap` returns no suggestion from any source whose text contains the whole word `cheap` (case-insensitive after normalisation), and `q=iph` still returns the other suggestions; the same blocklist is applied by the next build (AS-38).
13. **AS-48** (same answer for every caller, nothing personal) — **When** two different signed-in users and an anonymous caller request the same `q`, **Then** the three bodies are identical, no `Set-Cookie` or `Vary: Cookie/Authorization` is sent, and neither the request log lines nor the metrics labels contain the raw `q` (only its length and the `requestId`).

---

### User Story 2 - Product titles complete my search, and a slow product index never slows me down (Priority: P1)

Beside popular searches, the buyer sees matching product titles. When the product index is slow or down, the list still appears at once with just the popular searches, and is not stored by the edge cache.

**Why this priority**: the blend is the point of the capability and the budget is what keeps typing fluid.

**Independent Test**: call `GET /suggest` while the product engine is made slow, failing, and healthy.

**Acceptance Scenarios**:

1. **AS-13** (catalog completions) — **Given** visible products `Apple iPhone 17 Pro 256GB`, `iPhone 17 Silicone Case`, `iPad Air`, and non-visible ones (archived `iPhone 12 Mini`, a sandbox shop's `iPhone Test Unit`, a suspended shop's `iPhone Clone`), **When** `q=ip` is called, **Then** the catalog entries are only visible titles (never the three non-visible ones) and at most 5; **When** `q=i` (one character) is called, **Then** the catalog is not consulted (spy count 0) and only query suggestions are returned.
2. **AS-16** (catalog slower than its budget) — **Given** the engine call never completes, **When** `q=iph` is called, **Then** within 250 ms (budget 40 ms) the answer is `200` with the query suggestions only, `degraded: ["catalog_timeout"]`, `Cache-Control: no-store`; the engine call's abort signal was fired; metric `autocomplete_degraded_total{reason="catalog_timeout"}` increased by 1.
3. **AS-17** (catalog failing) — **Given** the engine call rejects immediately (connection refused, 5xx, typed timeout from the port), **When** `q=iph` is called, **Then** `200` with query suggestions only, `degraded: ["catalog_unavailable"]` (a timeout of the port itself counts as `catalog_timeout`), `no-store`; the error text never reaches the client or the log with the query text.
4. **AS-18** (nothing available) — **Given** no snapshot has ever been loaded and the engine fails, **When** `q=iph` is called, **Then** `200 {prefix: "iph", suggestions: [], degraded: ["query_index_unavailable", "catalog_unavailable"]}` with `no-store`; never a `5xx`.
5. **AS-19** (circuit breaker, integration) — **Given** the engine call fails five times in a row, **When** the sixth request arrives (clock frozen), **Then** the engine is not called (spy count unchanged), the answer arrives in under 50 ms with `degraded: ["catalog_unavailable"]`; **When** the clock advances 10 seconds, **Then** exactly one probe request calls the engine, concurrent requests during the probe still skip it, and a successful probe makes the next request call the engine normally.
6. **AS-20** (per-prefix cache) — **Given** a healthy engine, **When** `q=iph` is called three times within 60 seconds (and once as `q=IPH`), **Then** the engine is called once; **When** the clock advances past 60 seconds and `q=iph` is called, **Then** it is called a second time; a timed-out or failed engine call is never cached (the next request calls the engine again, unless the breaker is open).

(The pure rules of the blend, AS-14 and AS-15, and of the breaker, AS-21, are in the unit table below.)

---

### User Story 3 - A typo still gets me somewhere (Priority: P2)

A buyer types `iphnoe`. No popular search and no product title starts with that, but the box offers `Apple iPhone 17 Pro 256GB` as a typo-corrected completion.

**Why this priority**: improves recovery for the long tail; the rest works without it.

**Independent Test**: call `GET /suggest?q=iphnoe` on seeded data.

**Acceptance Scenarios**:

1. **AS-22** (fuzzy fallback) — **Given** the query index has nothing for `iphnoe` and the catalog prefix call returns nothing, and a visible product `Apple iPhone 17 Pro 256GB` is within the allowed edit distance, **When** `q=iphnoe` is called, **Then** `suggestions` is `[{text: "Apple iPhone 17 Pro 256GB", source: "typo"}]` (at most 5, visible titles only), `degraded: []`.
2. **AS-23** (only when nothing matches) — **Given** the query index has matches for `iph`, **When** `q=iph` is called, **Then** the fuzzy source is not called (spy count 0) and no entry has `source: "typo"`.
3. **AS-24** (catalog prefix wins) — **Given** the query index has no match for `ipho 1` but the catalog prefix call returns `iPhone 17 Silicone Case`, **When** called, **Then** only `source: "catalog"` entries are returned, no `typo` entry, even though the fuzzy source had been started in parallel and answered.
4. **AS-25** (minimum length) — **When** `q=zz` (two characters) has no match anywhere, **Then** the fuzzy source is not called and the answer is `200` with an empty list.
5. **AS-26** (fuzzy source failure) — **Given** `q=iphnoe` and the fuzzy call exceeds its 40 ms budget, **Then** `200`, `suggestions: []`, `degraded: ["typo_fallback_timeout"]`, `no-store`; **Given** the fuzzy call rejects, **Then** `degraded: ["typo_fallback_unavailable"]`; **Given** the query index has matches and the fuzzy source is never needed, a failing fuzzy source changes nothing.
6. **AS-27** (nothing at all is not an error) — **When** `q=zzzzqq` has no match in any source, **Then** `200 {prefix: "zzzzqq", suggestions: [], degraded: []}` and `Cache-Control: public, max-age=60, s-maxage=60`.

---

### User Story 4 - Fresh, safe, popular suggestions every hour (Priority: P1)

Every hour the system turns what people searched into the new suggestion index. A query appears only if enough different people searched it, it found results, it is not offensive, and it holds no personal data. A broken or empty build never makes suggestions worse.

**Why this priority**: the quality and safety of the whole feature is decided here.

**Independent Test**: seed `search_queries` rows, run the build, read the published snapshot and the pointer.

**Dataset S** (used above): searches within the last 30 days from distinct searchers on `surface: "http"` — `iphone 17` 50 searchers, `iphone charger` 20, `iphone 17 pro max case` 8, `ipad air` 12, `airpods pro` 30; and these that must be dropped: `iphne 17` 2 searchers, `iphone xyz9000` 30 searchers with 0 results, `iphone hacked` 40 searchers (blocklisted).

**Acceptance Scenarios**:

1. **AS-28** (eligibility) — **Given** dataset S plus: `usb cable` searched 100 times by one searcher (`user_hash` identical), `phone case` with 4 searchers, `phone stand` with 5 searchers, `old gadget` with 9 searchers whose newest search is 31 days old, `assistant only query` with 20 searchers all on `surface: "internal"`, `jane.doe@example.com` and `4111 1111 1111 1111` and `[redacted]` each with 20 searchers (legacy rows logged before redaction), and `charger` whose 6 searcher rows are each inserted twice with the same `event_id`, **When** the build runs, **Then** the published snapshot holds exactly `iphone 17` (50), `airpods pro` (30), `iphone charger` (20), `ipad air` (12), `iphone 17 pro max case` (8), `charger` (6), `phone stand` (5); it does not hold the others; `usb cable` counts as 1 searcher; duplicate rows count once; the job reports 7 queries.
2. **AS-29** (publication) — **When** the build succeeds, **Then** a new snapshot object `autocomplete/<version>` exists in object storage, the version pointer equals `<version>`, the snapshot's integrity checksum verifies, it contains only `{query, searchers}` pairs and the build parameters (no user hash, no event id, no timestamp of a search), `autocomplete_build_total{outcome="published"}` is 1, and serving nodes are not contacted by the builder.
3. **AS-30** (rebuild is idempotent) — **Given** a published snapshot, **When** the build runs again over unchanged data, **Then** the outcome is `unchanged`: no new object, the pointer is untouched, `autocomplete_build_total{outcome="unchanged"}` increased by 1.
4. **AS-31** (an empty build is never published) — **Given** a published snapshot and an aggregation that returns zero eligible queries (for example, the log table was truncated), **When** the build runs, **Then** the outcome is `skipped_empty`, the pointer and the serving nodes' index are unchanged, and a warning metric `autocomplete_build_total{outcome="skipped_empty"}` is raised.
5. **AS-32** (aggregation failure) — **Given** the log store times out (query timeout 60 s) or errors, **When** the build runs, **Then** the job fails with a retriable error, no pointer changes, no partially written object is ever referenced by the pointer, and the next scheduled run starts clean.
6. **AS-33** (concurrent builds never move the pointer backwards) — **Given** two build runs overlapping because a lease expired, run A started first (version `V1`) and run B second (version `V2 > V1`), and run A finishes last, **When** both complete (`Promise.all`), **Then** the pointer equals `V2`, run A's outcome is `superseded` and its own object is removed, and both snapshots verified valid while they existed.
7. **AS-34** (late and out-of-order log rows) — **Given** the rows of dataset S inserted in reverse timestamp order, in two batches with the second batch carrying older timestamps (late events), **When** the build runs, **Then** the snapshot is identical (same content and same checksum of entries) to the one built from the same rows inserted in order.
8. **AS-35** (cap) — **Given** the maximum number of queries is configured to 3 and dataset S qualifies 5, **When** the build runs, **Then** the snapshot holds the 3 with the most searchers, ties by text ascending, and `iphone 17` (50), `airpods pro` (30), `iphone charger` (20) are the ones kept.
9. **AS-36** (retention) — **When** a sixth version is published, **Then** only the latest five versions remain in object storage; the version the pointer names is never deleted; objects younger than one hour that no pointer names are kept (they may belong to a build in flight).
10. **AS-37** (schedule) — **Given** two worker instances, **When** the hourly schedule fires, **Then** exactly one build runs (`autocomplete_build_total` increases by 1 across both) and a duplicate trigger in the same minute is a no-op.
11. **AS-38** (eligibility rules, pure) — **Given** the rule functions, **Then**, table-driven: whole-word blocklist matching (`fake` blocks `fake watch` and `FAKE`, not `fakery`), personal-data detection (email, nine or more digits in a row, card-like groups), `[redacted]`, queries shorter than two characters, queries not equal to their own normalised form, and surrounding whitespace each yield the expected accept or reject.
12. **AS-39** (pointer rule, pure) — **Given** `(currentVersion, candidateVersion)`, **Then**, table-driven: candidate greater than current → move; equal → unchanged; lower → ignore; no current → move; an unparsable version → reject.
13. **AS-40** (snapshot format, pure) — **Given** a list of `{query, searchers}`, **Then** encode → decode returns the same list; a flipped byte, a truncated payload, a wrong format version, a negative or non-integer count, or a duplicated query each fail decoding with a typed error naming the reason (`checksum`, `truncated`, `format`, `invalid_entry`).

---

### User Story 5 - Every serving node switches to the new index without a hiccup (Priority: P1)

Serving nodes notice the new version, load it off to the side and switch in one step. A damaged, missing or unreachable snapshot leaves the current suggestions in place.

**Why this priority**: a bad swap would blank the drop-down for everyone.

**Independent Test**: publish versions, point the pointer, and call the endpoint in a loop.

**Acceptance Scenarios**:

1. **AS-41** (hot swap under load) — **Given** a node serving version `V1` and a loop of 200 concurrent `GET /suggest?q=iph` calls, **When** the pointer moves to `V2` (which adds `iphone 17 case`) and the node's refresh runs, **Then** every call answers `200`; each answer is entirely consistent with `V1` or entirely with `V2` (never empty, never a mix); calls after the swap completes show `V2`; `autocomplete_snapshot_version_info{version="V2"}` is 1.
2. **AS-42** (damaged snapshot) — **Given** version `V3` whose object has a flipped byte (or invalid compression, or an unknown format version), **When** the pointer moves to `V3`, **Then** the node keeps serving `V2`, `autocomplete_snapshot_load_failed_total{reason="checksum"}` (respectively `corrupt`, `format`) increases, a warning is logged without query text, and the next poll retries the same pointer without re-downloading more often than once per poll interval; **When** the pointer then moves to a valid `V4`, **Then** the node loads `V4`.
3. **AS-43** (missing object) — **Given** the pointer names a version whose object does not exist, **Then** as AS-42 with `reason="missing"`.
4. **AS-44** (cold start) — **Given** no pointer exists, **When** a node starts, **Then** it becomes ready (readiness does not depend on the index), `GET /suggest?q=iph` answers `200` with catalog completions only and `degraded: ["query_index_unavailable"]`, `no-store`; **When** a pointer then appears, **Then** the next poll loads it and `degraded` disappears.
5. **AS-45** (pointer store outage) — **Given** a loaded snapshot, **When** the pointer store is unreachable during a poll, **Then** the node keeps serving the loaded snapshot with `degraded: []`, a poll failure is counted (`autocomplete_snapshot_load_failed_total{reason="pointer_unreachable"}`), and recovery is automatic on a later poll.
6. **AS-46** (single flight) — **When** two refreshes overlap on one node (the poll fires while a refresh is loading), **Then** the object is downloaded and decoded once and both callers observe the same result.
7. **AS-47** (rollback) — **Given** the pointer was set back by an operator from `V4` to `V2`, **When** nodes poll, **Then** they load `V2` (a node trusts the pointer, not the ordering of versions; the ordering rule of AS-39 binds only the builder).

---

### User Story 6 - Operators can trust the platform (Priority: P2)

Reviewers and operators can see that the capability respects boundaries, reports what it is doing and refuses wrong configuration.

**Acceptance Scenarios**:

1. **AS-49** (boundary) — **Then** the static checks are green: `pnpm check:boundaries`, `pnpm check:table-ownership --strict` shows zero findings for the autocomplete files, nothing under `discovery/` that serves or builds suggestions imports another domain except `identity` (anonymous marker) and no autocomplete provider is exported from `@app/domains/discovery` other than `AutocompleteModule` and `AutocompleteWorkerModule`; `SearchQueryLogger`, `AutocompleteService` and the trie are not exported.
2. **AS-50** (metrics) — **Given** traffic of each kind in this spec, **When** the metrics endpoint is read, **Then** these series exist with these labels: `autocomplete_requests_total{outcome="ok"|"degraded"|"invalid"|"rate_limited"}`, `autocomplete_duration_seconds`, `autocomplete_source_duration_seconds{source="query"|"catalog"|"typo"}`, `autocomplete_degraded_total{reason}`, `autocomplete_catalog_cache_total{result="hit"|"miss"}`, `autocomplete_circuit_state{source="catalog"}` (0 closed, 1 open), `autocomplete_build_total{outcome}`, `autocomplete_build_duration_seconds`, `autocomplete_snapshot_queries`, `autocomplete_snapshot_age_seconds`, `autocomplete_snapshot_version_info{version}`, `autocomplete_snapshot_load_failed_total{reason}`; no label holds query text.
3. **AS-51** (configuration) — **When** the service starts with a catalog budget of 0 or above 500 ms, a typo budget outside 1–500 ms, a poll interval below 100 ms, K outside 1–50, maximum prefix depth outside 5–50, minimum searchers below 1, window outside 1–90 days, maximum queries below 1, or a blocklist that is not a list of non-empty strings, **Then** startup fails and the message names the offending key; with all values valid it starts.

---

### User Story 7 - Typing in the search page feels right (Priority: P2, owned by W02)

**Acceptance Scenarios**:

1. **AS-55** (UI happy path) — **Given** the published index of dataset S and visible products, **When** a visitor opens the search page and types `iph`, **Then** a list shows `iphone 17`, `iphone charger`, `iphone 17 pro max case`, `Apple iPhone 17 Pro 256GB`, `iPhone 17 Silicone Case`; choosing `iphone 17` runs a search for it and the URL carries `q=iphone 17`.
2. **AS-56** (stale responses, client logic) — **Given** the visitor types `iph` then `ipho`, and the response for `iph` arrives after the response for `ipho`, **Then** the list shows the suggestions for `ipho`; superseded requests are cancelled; at most one request is sent per 150 ms of typing; a previously seen prefix is shown from the client cache without a request within 60 seconds.

### Unit-tested pure rules (listed for traceability, VII.5)

1. **AS-14** (de-duplication, pure) — **Given** query suggestions `[iphone 17, iphone charger]` and catalog entries `[iPhone 17, iPhone Charger Cable, iPhone 17]`, **Then** the blend keeps `iphone 17` (source `query`), `iphone charger` (`query`) and `iPhone Charger Cable` (`catalog`); comparison is on the normalised text; the first occurrence (query before catalog before typo) wins; order within a source is kept.
2. **AS-15** (slot allocation, pure) — **Then**, table-driven with `limit` 8: 8 queries and 5 catalog → 5 queries + 3 catalog; 2 queries and 5 catalog → 2 + 5; 8 queries and 0 catalog → 8 + 0; 0 queries and 5 catalog → 0 + 5; `limit` 3 with 3 queries and 5 catalog → 2 + 1; `limit` 1 with 1 query and 1 catalog → 1 + 0; `limit` 10 with 10 queries and 5 catalog → 6 + 4. Typo entries use catalog slots.
3. **AS-21** (breaker transitions, pure, clock injected) — **Then**, table-driven: closed → open after 5 consecutive failures (a success resets the count); open rejects until 10 seconds passed; after that exactly one caller is admitted (half-open) and others are rejected; probe success → closed; probe failure → open for another 10 seconds; the count of failures is not affected by timeouts of a single caller after the half-open state is left.
4. **AS-52** (index behaviour, pure) — **Then**, table-driven: top-K per prefix with K = 3 over a fixed vocabulary at every prefix length; ties by text ascending; the empty prefix; a prefix with no node; surrogate pairs and combining marks treated as single code points; a prefix longer than the maximum depth filtered exactly (AS-11); the build input is not modified.
5. **AS-53** (index against brute force, property) — **Then** for random vocabularies and random prefixes up to the maximum depth, the index answer equals "filter all queries by prefix, sort by searchers descending then text ascending, take K" (`fast-check`).
6. **AS-54** (memory bound, pure) — **Then** for a vocabulary of N queries, the node count is at most `1 + N × maxDepth`, every node holds at most K entries, and no stored query is truncated.

### Edge Cases

Every edge case maps to a scenario (and to one row of `test-plan.md`):

- Rapid typing and stale responses → AS-56 (client), AS-20 (server cache), AS-41 (swap under load).
- Slow or dead catalog source → AS-16, AS-17, AS-18, AS-19; slow typo source → AS-26.
- Nothing typed, whitespace, control characters, over-long text, unknown parameters, invalid limit → AS-04, AS-05, AS-06, AS-03.
- Hostile text (wildcards, injection, markup) → AS-07.
- Privacy: personal data in old log rows, internal surface, redacted queries, one searcher repeating → AS-28, AS-38, AS-48.
- Duplicate and out-of-order or late log rows → AS-28 (duplicates), AS-34 (late).
- Concurrent builds, repeated builds, empty builds, failing builds → AS-33, AS-30, AS-31, AS-32.
- Damaged, missing or unreachable snapshot; cold start; rollback → AS-42, AS-43, AS-45, AS-44, AS-47.
- Overlapping refreshes → AS-46.
- Limits: depth, K, maximum queries, retention of versions, rate limit → AS-11, AS-52, AS-35, AS-36, AS-09.
- Cross-tenant and illegal state transitions: the endpoint is anonymous and global, returns nothing owned by a tenant or user, and has no state machine; the equivalent risks (non-visible products, other users' queries) → AS-13, AS-28, AS-48. There is no `401`: AS-08 proves anonymous access and that bad tokens do not break it.
- Idempotent replay: a `GET` is replayable → AS-02; a repeated build → AS-30.

## Requirements *(mandatory)*

### Functional Requirements

**Suggest endpoint**

- **FR-001**: `GET /suggest` is public (anonymous), takes `q` (required) and `limit` (optional, integer 1–10, default 8), and rejects every other parameter with `400` (AS-03, AS-06, AS-08).
- **FR-002**: `q` is reduced exactly as S32 reduces search text (Unicode compatibility folding, control characters removed, whitespace collapsed, trimmed) and lower-cased; more than 100 characters after reduction is `400`, never truncated; an empty reduced prefix answers `200` with an empty list and consults no source (AS-04, AS-05, AS-06, AS-07).
- **FR-003**: The response is `{prefix, suggestions: {text, source: "query" | "catalog" | "typo"}[], degraded: string[]}`, defined by `suggestResponseSchema` in `packages/contracts`; `prefix` is the reduced prefix; `text` of a query suggestion is the stored normalised query, of a catalog or typo suggestion the product title as stored; `degraded` holds zero or more of `catalog_timeout`, `catalog_unavailable`, `typo_fallback_timeout`, `typo_fallback_unavailable`, `query_index_unavailable`, in that order (AS-01, AS-16, AS-17, AS-18, AS-26, AS-44).
- **FR-004**: Query suggestions come from the in-memory top-K index, from one character upward, ordered by distinct searchers descending then text ascending, deterministically (AS-02, AS-52).
- **FR-005**: A lookup costs time proportional to the prefix length, not to the vocabulary: every prefix holds its own precomputed top K (K = 10); depth is capped at 20 characters; a prefix deeper than the cap is answered from the 20-character list filtered exactly, best-effort (AS-11, AS-52, AS-53, AS-54).
- **FR-006**: Catalog completions are read only through S32's `ProductTitleSuggester.suggestTitles(prefix, size ≤ 10, signal?)`, only for prefixes of two or more characters, at most 5, visible products only (AS-13).
- **FR-007**: The blend removes duplicates on normalised text (first occurrence wins: query, then catalog, then typo) and fills `limit` slots as follows: `Q = min(queries, ⌈0.6 × limit⌉)`, `C = min(catalog-or-typo entries, 5, limit − Q)`, then `Q' = min(queries, limit − C)`; the answer is the first `Q'` queries followed by the first `C` catalog or typo entries (AS-14, AS-15).
- **FR-008**: Each external source has its own budget, started in parallel and cancelled when exceeded: catalog 40 ms and typo fallback 40 ms; the in-memory index has none. The request therefore never waits longer than the largest budget plus processing (AS-16, AS-26).
- **FR-009**: A source failure never fails the request: a valid request always answers `200`; each missing source is named in `degraded` (AS-16, AS-17, AS-18, AS-26, AS-44).
- **FR-010**: Responses with a non-empty `degraded` and all `400`/`429` responses carry `Cache-Control: no-store`; every other `200` carries `public, max-age=60, s-maxage=60` (AS-01, AS-05, AS-10, AS-16, AS-27).
- **FR-011**: The catalog source is protected by a circuit breaker: five consecutive failures or timeouts open it for 10 seconds, during which requests skip the source immediately and report `catalog_unavailable`; then one probe is admitted; success closes it (AS-19, AS-21).
- **FR-012**: Catalog results are cached per normalised prefix for 60 seconds; failures and timeouts are never cached; the cache is a pure optimisation and never the source of truth (AS-20).
- **FR-013**: The typo fallback runs only when the query index has no match for the prefix, the prefix has three or more characters, and it is started in parallel with the catalog prefix call; its entries are used only when the catalog prefix call also returned nothing; it reads only through S32's `ProductTitleSuggester.suggestTitlesFuzzy(prefix, size ≤ 10, signal?)`, at most 5 entries, visible products only (AS-22, AS-23, AS-24, AS-25, AS-27).
- **FR-014**: A fuzzy-source failure changes only `degraded` and the typo entries (AS-26).
- **FR-015**: Rate limit policy `discovery.suggest`: 600 requests per minute per address, fail open; `429` is problem+json `rate_limited` with `Retry-After` (AS-09, AS-10).
- **FR-016**: Every error is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and `code` (`validation_failed`, `rate_limited`); for a `5xx` the detail is generic (AS-06, AS-09, AS-10).
- **FR-017**: The answer depends only on the reduced prefix, `limit`, the loaded snapshot, the blocklist and the catalog: it is identical for every caller, uses no cookie or identity header, sets no cookie and never varies on credentials (AS-08, AS-48).
- **FR-018**: The blocklist (whole words, case-insensitive after normalisation; default terms `fake`, `counterfeit`, `stolen`, `hack`, `hacked`) is applied to every suggestion of every source at serve time and to the build input; changing it takes effect on serving nodes without a new build (AS-38, AS-12).
- **FR-019**: Logs and metrics never contain the raw prefix; a request log line carries `requestId`, the prefix length, the outcome and the degraded reasons only (AS-48, AS-50).

**Offline build**

- **FR-020**: Once per hour a single-run job aggregates the search log (S32's query table) over the last 30 days and keeps a query only if at least 5 distinct searchers searched it with at least one result; popularity is the number of distinct searchers, not of searches (AS-28, AS-37).
- **FR-021**: Rows from the internal surface (non-typed, in-process searches), rows whose query is `[redacted]` or matches a personal-data pattern (email, nine or more digits in a row, card-like number), queries shorter than two characters, queries not in normalised form, and blocklisted queries are excluded, even if present in old rows (AS-28, AS-38).
- **FR-022**: Duplicate log rows (same event id) count once, and the result does not depend on the arrival or timestamp order of rows (AS-28, AS-34).
- **FR-023**: At most 200,000 queries are kept, chosen by searchers descending then text ascending (AS-35).
- **FR-024**: A build publishes a snapshot that is versioned, integrity-checked (checksum) and carries only `{query, searchers}` pairs and the build parameters, to durable object storage, and then advances a single version pointer; the pointer is the only thing nodes follow (AS-29, AS-40).
- **FR-025**: A build whose entries equal the current snapshot's is not published (outcome `unchanged`) (AS-30).
- **FR-026**: A build with zero eligible queries is never published (outcome `skipped_empty`) (AS-31).
- **FR-027**: A failed or timed-out aggregation fails the job (retriable) and changes nothing visible (AS-32).
- **FR-028**: The pointer moves only forward: a build whose version is not greater than the current pointer's does not move it and deletes its own object (outcome `superseded`); an operator may set the pointer back explicitly (AS-33, AS-39, AS-47).
- **FR-029**: The latest five versions are retained, never the pointed one deleted, and unreferenced objects younger than one hour are kept (AS-36).
- **FR-030**: The job is registered as `search.build-autocomplete`, runs hourly, once across replicas, with a lease of ten minutes, and is idempotent (AS-37, AS-30).

**Serving nodes**

- **FR-031**: Every serving node polls the pointer every 30 seconds; on a new value it downloads, verifies and builds the index off to the side and then replaces the live index in one step; a request sees one index entirely (AS-41).
- **FR-032**: A download, decoding, integrity or build failure keeps the current index serving and increments `autocomplete_snapshot_load_failed_total{reason}` with reason `missing`, `checksum`, `corrupt`, `format`, `invalid_entry` or `pointer_unreachable`; the same failing version is retried at most once per poll interval (AS-42, AS-43, AS-45).
- **FR-033**: Concurrent refreshes on one node are collapsed into one (AS-46).
- **FR-034**: Building the index never blocks request handling for longer than one slice of work; a 200,000-query rebuild does not stall in-flight requests (AS-41).
- **FR-035**: With no snapshot a node is ready and serves the other sources with `query_index_unavailable` (AS-44).
- **FR-036**: A node follows the pointer even backwards (AS-47).
- **FR-037**: Index memory is bounded by depth, K and the maximum number of queries (AS-54).

**Platform**

- **FR-038**: Metrics of AS-50 are exposed; `autocomplete_snapshot_age_seconds` rises while no new snapshot is loaded (AS-50).
- **FR-039**: Configuration of budgets, poll interval, K, depth, floor, window, cap and blocklist is validated at startup (AS-51).
- **FR-040**: The capability reads only the search log store, the snapshot store, the pointer store and S32's `ProductTitleSuggester`; it owns no Postgres table; no other domain's data is read except through that exported port (AS-49).
- **FR-041**: The module exposes nothing but its two deployable modules (`AutocompleteModule`, `AutocompleteWorkerModule`); the API schemas live in `packages/contracts` (AS-01, AS-49).
- **FR-042**: The consumer (W02) debounces to at most one request per 150 ms, cancels superseded requests, ignores answers of superseded prefixes, shows at most the first `limit` entries in the given order, and caches a prefix for 60 seconds (AS-55, AS-56).

### Key Entities *(include if feature involves data)*

- **Search log row** (owned by S32 in the discovery analytics store): `{eventId, query (normalised, redacted), results, userHash, surface, occurredAt}`; retained 90 days; read here only by the build.
- **Query candidate**: a normalised query with its count of distinct searchers inside the window.
- **Snapshot**: a versioned, integrity-checked list of `{query, searchers}` plus build parameters. Immutable once published.
- **Version pointer**: the one value that names the snapshot nodes serve.
- **Suggestion index**: the in-memory prefix → top-K structure derived from one snapshot on each node.
- **Suggestion**: `{text, source}`; `source` is `query` (from the index), `catalog` (title completion) or `typo` (fuzzy title completion).
- **Blocklist**: a set of whole-word terms never suggested.
- **Catalog circuit and prefix cache**: per-node, in-memory, never authoritative.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 99% of keystrokes, buyers see suggestions within 100 ms of the request leaving their browser at 50,000 requests per second, with popular prefixes answered by the edge cache (operations artifact: load proof with a realistic prefix distribution).
- **SC-002**: When the product source is slow or down, 100% of valid requests still return the popular-search suggestions within 100 ms, with zero error responses caused by that outage.
- **SC-003**: A query that reaches 5 distinct searchers appears in suggestions within 65 minutes.
- **SC-004**: 0 suggestions in the verified corpus contain a blocklisted term, an email address, a long digit run, a card-like number, or the title of a non-visible product.
- **SC-005**: A damaged, missing, empty or out-of-order build changes what buyers see in 0 cases (previous suggestions keep serving).
- **SC-006**: Switching to a new snapshot under sustained load causes 0 failed requests and 0 mixed answers.
- **SC-007**: In a fixture set of 20 single-typo searches of at least 3 characters (first character correct) against visible titles, at least 18 show at least one correct suggestion.
- **SC-008**: The suggestion index for 200,000 queries stays within 400 MB per serving node.
- **SC-009**: The published snapshot contains 0 user identifiers.

## Assumptions

- The query log (S32's `search.performed`, projected into the discovery analytics store) is the only popularity source; no personalisation. The log already contains normalised and redacted text; this capability re-applies the redaction rules on read because older rows predate them.
- A trending-terms blend (streaming top-K, S35) is deferred: it would add a source value and a budget. The response shape is already a list of `{text, source}` so adding a source later is additive, but a client with a strict schema must be upgraded first (`[CONTRACT]` question).
- The popularity floor (5 distinct searchers) is a spam and privacy floor, not a quality score; a coordinated group of five hashed callers could inject a term. The blocklist and the verification of results greater than zero limit the damage. Stronger anti-abuse is not built.
- Words of the default blocklist are kept from the current code; they hide legitimately named products (for example "fake plant") from the drop-down only, not from search.
- Typo fallback and catalog prefix calls run in parallel on a trie miss, accepting one wasted engine call on rare prefixes in exchange for a response bounded by one budget.
- The 60% share of slots for query suggestions and the cap of 5 catalog entries are product choices that can be tuned without changing the contract.
- `limit` caps the whole list; clients show the list as given.
- The snapshot format and storage layout are internal; only the pointer semantics are a contract between builder and nodes.
- The edge cache honours `Cache-Control` and keys on the full URL; it does not forward credentials for this route.
- Prefix lookups deeper than 20 characters are best-effort by design (the notes bound memory by prefix length).
- No new Postgres tables, no migrations. Data stores: object storage (snapshots), the key-value store (pointer), the analytics store (log, owned by S32), the search engine (through S32's port).
- Defaults chosen are listed, one per line and tagged, in [`questions.md`](questions.md).

## Cross-capability contracts

Honoured from existing specs: **S32** requires nothing further of S33 beyond using `ProductTitleSuggester` and not assuming per-query ordering of `search.performed` (honoured: FR-006, FR-020, FR-022); **S19**, **S05** only delegate autocomplete here; **W02** (not yet specified) consumes `/suggest`.

**Provides** (exact names):

- HTTP `GET /api/suggest` (anonymous), schemas in `packages/contracts`: request `suggestQuerySchema` = `{q: string (reduced length ≤ 100), limit?: integer 1–10 (default 8)}`; response `suggestResponseSchema` = `{prefix: string, suggestions: {text: string, source: 'query' | 'catalog' | 'typo'}[], degraded: ('catalog_timeout' | 'catalog_unavailable' | 'typo_fallback_timeout' | 'typo_fallback_unavailable' | 'query_index_unavailable')[]}`; errors problem+json with `code` `validation_failed` | `rate_limited`. Guarantees: `200` for every valid request, even when sources fail; at most `limit` suggestions; no duplicates on normalised text; deterministic order; `Cache-Control: public, max-age=60, s-maxage=60` when `degraded` is empty and `no-store` otherwise. **Consumer: W02 (search page, through the Next.js server).**
- Consumer obligations on W02 (FR-042): debounce ≥ 150 ms, abort superseded requests, discard stale answers, client cache 60 s per prefix, no suggestions request for an empty or whitespace-only box, render `text` as text.
- Rate-limit policy (declared in S50's registry): `discovery.suggest` 600/minute per address, fail open.
- Scheduled job (registered with S49, single-run, lease 10 minutes): `search.build-autocomplete`, hourly, idempotent.
- Modules for the apps: `AutocompleteModule` (core: HTTP, serving index, poller) and `AutocompleteWorkerModule` (worker: build job). Nothing else is exported. `SearchQueryLogger` and the query projector are S32's.
- Metrics of AS-50.
- Events: none emitted.

**Requires**:

- **S32** (same domain, exported inside the domain):
  - `ProductTitleSuggester.suggestTitles(prefix: string, size: number (≤ 10), signal?: AbortSignal): Promise<string[]>` — visible products only; abort honoured; typed timeout error. As specified by S32 AS-79.
  - **New, `[CONTRACT]`:** `ProductTitleSuggester.suggestTitlesFuzzy(prefix: string, size: number (≤ 10), signal?: AbortSignal): Promise<string[]>` — fuzzy title completion (edit distance up to 2 for terms of 5 or more characters, 1 for shorter, first character fixed), visible products only, abort honoured, typed timeout error.
  - The log table of S32's query projector with columns `event_id`, `query` (normalised lower-case, redacted as `[redacted]`), `results`, `user_hash` (stable per caller, dedicated secret), `ts`, and **new, `[CONTRACT]`:** `surface` (`'http' | 'internal'`, rows before this change read as `'http'`); duplicates of one `event_id` collapse; 90-day expiry; no ordering assumption between rows.
  - The query-text reducer and the redaction rules (S32 AS-85): the same functions serve search, the log and autocomplete.
  - The engine guarantees of S32 (live name, `title.autocomplete` sub-field) are used only through the port.
- **S49**: single-run scheduled job with a lease and a retriable failure state. **S50**: the policy `discovery.suggest` (fail open). **S54**: problem+json filter with `code`, request context with `requestId`, metrics registry, configuration validation, graceful shutdown. **S01**: the anonymous route marker that ignores bad tokens.
- Infrastructure (no domain names in their APIs): analytics-store client with a query timeout; object storage port (put, get, list, delete); key-value store client (get, atomic compare-and-set for the pointer).
- **Ownership** (IX.3): no Postgres object; the pointer key and the object prefix `autocomplete/` belong to this module (I.4).

## Review & Acceptance Checklist reference

The spec quality checklist is `checklists/requirements.md`; the test plan is `test-plan.md`; the implementation to-do list is `gaps.md`; every default chosen is in `questions.md`.
