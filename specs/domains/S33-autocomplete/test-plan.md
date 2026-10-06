# Test Plan: S33 — Search Autocomplete (domain `discovery`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (56 scenarios, AS-01 to AS-56), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/discovery/`. Each file's top-level `describe` names its feature (VII.8). They boot the real feature modules (`AutocompleteModule`, `AutocompleteWorkerModule`, and for the typo and catalog scenarios the S32 search module that provides `ProductTitleSuggester`) with the production global pipe, filter, prefix and interceptors, call them through `supertest`, and run against real Redis, object storage (MinIO), ClickHouse and Elasticsearch from `docker-compose.test.yaml` (VII.2).
- Only system-edge dependencies are faked or spied: the search-engine client (to hang, reject or count calls in AS-16–AS-20, AS-22–AS-26), the access-token verifier (AS-08, AS-48), and time (frozen where a scenario needs it: breaker and cache TTLs). The snapshot store, pointer store, log store, trie, builder and serving service are real. Every test asserts the response **and** the persisted effect (snapshot objects, pointer value, metrics, spy counts) and resets state first (`clean()`, ClickHouse `TRUNCATE`, bucket prefix, Redis keys).
- Every e2e parses `200` bodies with `suggestResponseSchema` and error bodies with the problem schema from `packages/contracts` (VII.6).
- The build job is driven through the real job handler (`search.build-autocomplete`) and the real job table; "two worker instances" (AS-37) is two real worker modules in one test process. Overlapping builds (AS-33) are two real handler invocations with `Promise.all`.
- This capability has no message consumer of its own. The VII.4 pair (duplicate delivery, invalid payload) for `search.performed` belongs to S32's query projector; the duplicate-row effect on this capability is AS-28 and the late-row effect is AS-34.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5); AS-54 is also a `fast-check` property. No unit tests for controllers, repositories, the poller or glue.
- UI journeys (Playwright, owned by W02, happy path only): `packages/web/tests/search.spec.ts`. AS-56 is a Vitest component test with MSW, not Playwright (VII.7), and no edge case of the server is re-tested in the browser.
- Static gates (VII.1, AS-49): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict`.
- The load proof of SC-001 (50,000 requests per second, realistic prefix mix, edge cache in front) is an operations artifact (`loadtest:suggest`), not an e2e row.
- Fallback paths (VII.9): the catalog timeout, catalog failure, breaker-open, fuzzy failure, empty build, damaged snapshot and cold-start paths each have a test that forces them (AS-16, AS-17, AS-19, AS-26, AS-31, AS-42, AS-44).

Abbreviations for the e2e files (all under `libs/domains/discovery/`):

| Key | File | Top-level `describe` |
|---|---|---|
| K | `autocomplete-suggest.e2e-spec.ts` | `Search autocomplete API` |
| D | `autocomplete-sources.e2e-spec.ts` | `Autocomplete source budgets and typo fallback` |
| B | `autocomplete-snapshot.e2e-spec.ts` | `Autocomplete snapshot build and hot swap` |
| P | `autocomplete-platform.e2e-spec.ts` | `Autocomplete module boundary, metrics and configuration` |

Unit files (all under `libs/domains/discovery/domain/`): `top-k-trie.spec.ts`, `suggestion-blend.spec.ts`, `catalog-circuit.spec.ts`, `query-eligibility.spec.ts`, `snapshot-pointer.spec.ts`, `snapshot-codec.spec.ts`.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 blended answer, headers, schema | K: dataset S built, real engine seeded with two visible products; exact body, `Cache-Control`, no `Set-Cookie`, schema parse, snapshot and pointer unchanged | — | — |
| AS-02 order and replay | K: equal-count tie, two calls byte-identical | — | — |
| AS-03 limit | K: default 8, `limit=3`, and each invalid `limit` → 400 | — | — |
| AS-04 normalisation | K: four inputs → reduced `prefix`, same suggestions as the plain prefix | — | — |
| AS-05 nothing typed | K: empty, space, control characters → 200 empty; spy counts 0 on engine and index | — | — |
| AS-06 validation | K: missing `q`, 101 characters, unknown parameter → problem+json with `errors[]` | — | — |
| AS-07 hostile text | K: seven payloads → 200, no wildcard expansion, no engine error leaked | — | — |
| AS-08 anonymous access | K: no token, valid token, invalid token → identical 200 | — | — |
| AS-09 rate limit | K: 601st request → 429 `rate_limited` with `Retry-After`; limiter store down → 200 | — | — |
| AS-10 errors never cached | K: 400 and 429 carry `Cache-Control: no-store` and the problem body | — | — |
| AS-11 long prefixes and queries | K: 24- and 35-character prefixes return the 46-character query | — | — |
| AS-12 blocklist at serve time | K: snapshot containing `cheap iphone`, product `Cheap iPhone Stand`, blocklist changed and service restarted without a build → nothing with `cheap` from any source | — | — |
| AS-13 catalog completions, visibility | D: visible vs archived, sandbox and suspended products (seeded through S32's projection fixtures); `q=i` → engine spy 0 | — | — |
| AS-14 de-duplication | — | — | `suggestion-blend.spec.ts` |
| AS-15 slot allocation | — | — | `suggestion-blend.spec.ts` (`it.each` over the seven cases) |
| AS-16 catalog slower than budget | D: engine call hangs → ≤ 250 ms, `catalog_timeout`, `no-store`, abort signal fired, metric +1 | — | — |
| AS-17 catalog failing | D: reject, 5xx, typed timeout → `catalog_unavailable` / `catalog_timeout`; no error text in body or log | — | — |
| AS-18 nothing available | D: no snapshot and failing engine → 200, empty list, two reasons | — | — |
| AS-19 circuit breaker, integration | D: five failures, sixth skipped (spy count), 10 s later one probe, concurrent skip, recovery; frozen clock | — | — |
| AS-20 per-prefix cache | D: three calls plus `IPH` → one engine call; after 60 s a second; failures not cached | — | — |
| AS-21 breaker transitions | — | — | `catalog-circuit.spec.ts` |
| AS-22 fuzzy fallback | D: `iphnoe` on double miss → one `typo` entry | — | — |
| AS-23 only when nothing matches | D: `iph` → fuzzy spy 0, no `typo` entry | — | — |
| AS-24 catalog prefix wins | D: fuzzy answered but discarded | — | — |
| AS-25 minimum length | D: `zz` → fuzzy spy 0 | — | — |
| AS-26 fuzzy failure | D: timeout → `typo_fallback_timeout`, reject → `typo_fallback_unavailable`, unused source failing changes nothing | — | — |
| AS-27 nothing at all is not an error | D: `zzzzqq` → 200 empty, cacheable | — | — |
| AS-28 eligibility | B: all listed rows seeded in ClickHouse (including legacy PII rows and duplicate `event_id`); snapshot holds exactly the seven queries | — | — |
| AS-29 publication | B: object exists, checksum verifies, only `{query, searchers}`, pointer equals version, build metric | — | — |
| AS-30 rebuild is idempotent | B: second run `unchanged`, no new object, pointer untouched | — | — |
| AS-31 empty build never published | B: truncated log table → `skipped_empty`, pointer and nodes unchanged | — | — |
| AS-32 aggregation failure | B: log-store timeout → job fails retriable, nothing referenced by the pointer | — | — |
| AS-33 concurrent builds | B: two overlapping handler runs (`Promise.all`); pointer equals the newer version; older run `superseded`, its object removed | — | — |
| AS-34 late and out-of-order rows | B: reversed and late batches → entries identical to in-order build | — | — |
| AS-35 cap | B: cap 3 → three most popular kept, ties by text | — | — |
| AS-36 retention | B: sixth publish leaves five; pointed version kept; young unreferenced object kept | — | — |
| AS-37 schedule | B: two worker modules, one build per trigger; duplicate trigger no-op | — | — |
| AS-38 eligibility rules | — | — | `query-eligibility.spec.ts` (`it.each`: whole-word blocklist, email, nine digits, card-like, `[redacted]`, length, non-normalised) |
| AS-39 pointer rule | — | — | `snapshot-pointer.spec.ts` |
| AS-40 snapshot format | — | — | `snapshot-codec.spec.ts` (round trip; flipped byte, truncated, format, invalid entry, duplicate) |
| AS-41 hot swap under load | B: 200 concurrent calls while the pointer moves; each answer entirely `V1` or `V2`; version metric | — | — |
| AS-42 damaged snapshot | B: flipped byte, bad compression, unknown format → node keeps `V2`, failure metric per reason, retry once per poll, recovery on valid `V4` | — | — |
| AS-43 missing object | B: pointer to a missing object → `reason="missing"`, still serving | — | — |
| AS-44 cold start | B: no pointer → ready, catalog only, `query_index_unavailable`, `no-store`; pointer appears → loaded | — | — |
| AS-45 pointer store outage | B: key-value store down during a poll → keeps serving, failure metric, recovers | — | — |
| AS-46 single flight | B: overlapping refreshes → one download (storage spy), same result | — | — |
| AS-47 rollback | B: pointer set back to `V2` → nodes load `V2` | — | — |
| AS-48 same answer for everyone | K: two users and anonymous → identical bodies, no cookie, no `Vary` on credentials, log capture has no raw `q` | — | — |
| AS-49 boundary | P: runs `pnpm check:boundaries` and `check:table-ownership --strict` for the autocomplete files; barrel exports asserted by importing `@app/domains/discovery` | — | — |
| AS-50 metrics | P: after traffic of each kind, the listed series and labels exist and no label holds query text | — | — |
| AS-51 configuration | P: each invalid value fails startup naming the key; valid values start | — | — |
| AS-52 index behaviour | — | — | `top-k-trie.spec.ts` (`it.each`) |
| AS-53 index against brute force | — | — | `top-k-trie.spec.ts` (`fast-check`) |
| AS-54 memory bound | — | — | `top-k-trie.spec.ts` |
| AS-55 UI happy path | — | `packages/web/tests/search.spec.ts` (owned by W02): type `iph`, see five suggestions, choose one, URL carries `q` | — |
| AS-56 stale responses | — | (not Playwright) W02 component test with MSW: out-of-order responses, cancellation, 150 ms debounce, 60 s client cache | — |

Count check: 56 scenarios, 56 rows.
