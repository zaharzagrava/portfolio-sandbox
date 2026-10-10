# Gaps: S33 — current `discovery` autocomplete code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/libs/domains/discovery/` unless stated; line numbers are those read on 2026-10-05. Choices behind each row are in [`questions.md`](questions.md); scenario IDs refer to [`spec.md`](spec.md).

What exists: `api/autocomplete.controller.ts` (one route), `application/autocomplete.service.ts` (serving: poll, swap, blend), `infra/autocomplete-builder.jobs.ts` (hourly build), `domain/top-k-trie.ts` (+ spec), `autocomplete.module.ts` and `autocomplete-worker.module.ts`, and one e2e spec that calls services directly for two of its three checks. The trie itself is sound (precomputed top-K per node, depth cap, event-loop yielding build) and is kept.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Response is `{queries, products, partial}`; no `prefix`, `source`, reason codes; merging and de-duplication are done in the web client (`suggestionsFrom`) | `application/autocomplete.service.ts:13-18,71-84`, `packages/web/lib/api/catalog.ts:47-52,70-83` | FR-003, FR-007, AS-01, AS-14, AS-15 |
| A2 | No request validation: `q = ''` default, no DTO, no length cap (silent `slice(0, 100)` inside the normaliser), unknown parameters accepted, no `limit` | `api/autocomplete.controller.ts:18-20`, `domain/top-k-trie.ts:80` | FR-001, FR-002, AS-03–AS-07 |
| A3 | `normalizeQuery` is a local copy; S32 specifies one shared reducer and redactor (control characters are not removed here) | `domain/top-k-trie.ts:79-81` | FR-002, AS-04 |
| A4 | Rate limit disabled (`skipThrottle: true`); no policy | `api/autocomplete.controller.ts:16` | FR-015, AS-09 |
| A5 | Static `Cache-Control` for every answer, including partial ones; errors are not marked `no-store` | `api/autocomplete.controller.ts:17` | FR-010, AS-10, AS-16 |
| A6 | Catalog completions call the engine adapter directly, ignoring visibility; hard-coded size 5; no cache, no breaker | `application/autocomplete.service.ts:5,76-83`, `libs/infrastructure/elasticsearch/elasticsearch.service.ts:219-225` | FR-006, FR-011, FR-012, AS-13, AS-19, AS-20 |
| A7 | Budget handling: any error (timeout or not) is `partial: true`; no distinction of reasons; the in-flight call is aborted but nothing is counted | `application/autocomplete.service.ts:77-86` | FR-008, FR-009, AS-16, AS-17, AS-50 |
| A8 | No typo fallback | none | FR-013, FR-014, AS-22–AS-27 |
| A9 | Blocklist applies at build only, as regexes in code (`hack(ed)?` etc.), not configurable, not applied to catalog titles | `infra/autocomplete-builder.jobs.ts:20,53` | FR-018, AS-12, AS-38 |
| A10 | Build eligibility: no `surface` filter, no personal-data or `[redacted]` filter, no check that the query is normalised or ≥ 2 characters; `uniqCombined` is approximate (a floor of 5 can misjudge); no explicit duplicate handling beyond `FINAL`; window and floor are constants | `infra/autocomplete-builder.jobs.ts:17-19,45-53` | FR-020–FR-023, AS-28, AS-34, AS-35 |
| A11 | Snapshot is bare JSON gzip: no checksum, no format version, no build parameters; version is `new Date()` in the handler (I.3 is for `domain/`, but it also blocks a deterministic test clock) | `infra/autocomplete-builder.jobs.ts:55-56` | FR-024, AS-29, AS-40 |
| A12 | Pointer is overwritten unconditionally, so an older overlapping build can move it backwards; an empty result is published; unchanged content is republished every hour; old snapshots are never deleted; no timeout on the log query | `infra/autocomplete-builder.jobs.ts:44-60` | FR-025–FR-029, AS-30–AS-33, AS-36, AS-39 |
| A13 | The 600 s lease is the only guard against two builds; there is no outcome reporting (`published`, `unchanged`, `skipped_empty`, `superseded`) | `infra/autocomplete-builder.jobs.ts:43-61` | FR-030, AS-37, AS-50 |
| A14 | Serving: `refresh()` parses and loads blindly (no integrity check), swallows every error as a warning with the error text, has no failure counters, no retry limit for a bad version, no single-flight, and the interval overlaps a slow refresh | `application/autocomplete.service.ts:41-65` | FR-031–FR-034, AS-41–AS-46 |
| A15 | Serving: no readiness or degraded semantics for a missing snapshot (the empty trie silently answers nothing, no `query_index_unavailable`); a `useTrie` test hook sits in production code | `application/autocomplete.service.ts:36,67-69` | FR-035, AS-44 |
| A16 | `AutocompleteService` calls `RedisService`, `ObjectStorage` and `ElasticsearchService` classes directly; `application/` imports `infra/` pointer constant (I.2) and the build job imports infrastructure classes without domain ports | `application/autocomplete.service.ts:4,5,6,7`, `infra/autocomplete-builder.jobs.ts:2-6` | D-6 (below), FR-040 |
| A17 | Module is `@Global()`, exports `AutocompleteService` and `SearchQueryLogger`; barrel exports `SearchQueryLogger` and projectors | `autocomplete.module.ts:11,15`, `index.ts:9-17` | FR-041, AS-49 |
| A18 | No metrics (requests, degraded, source durations, circuit, build, snapshot age and version, load failures) and no startup validation of budgets, K, depth, floor, window, cap, blocklist | none | FR-038, FR-039, AS-50, AS-51 |
| A19 | No schemas in `packages/contracts` for the request or the response; no problem codes | none | FR-003, FR-016, FR-041 |
| A20 | Logs: the refresh warning logs the raw error message; no request log with prefix length and degraded reasons; nothing guarantees the prefix is never logged | `application/autocomplete.service.ts:61` | FR-019, AS-48 |
| A21 | Memory bound and rule coverage: the trie spec has three tests (no ties, no multi-byte, no property test, no memory bound, no `lookup` with a prefix longer than depth in the same table as the others) | `domain/top-k-trie.spec.ts:16-31` | AS-52–AS-54 |
| A22 | Tests: `autocomplete.e2e-spec.ts` mocks `ElasticsearchService.suggestTitles` for the happy path, calls `AutocompleteBuilderJobs.build()` and `AutocompleteService.suggest()` directly for the timing check (no HTTP), has no concurrency, no damaged snapshot, no rate limit, no 400, no schema parse, and wires its own `BuilderSpecModule` | `autocomplete.e2e-spec.ts:15-17,29-33,55-78` | VII.2, VII.3, all e2e rows of `test-plan.md` |
| A23 | Web: debounce 300 ms, suggestions only from 2 characters, no abort of superseded requests, local merge; there is no Playwright step that types and picks a suggestion | `packages/web/app/search/page.tsx:54-61,84,88-91,145`, `packages/web/tests/search.spec.ts` | FR-042, AS-55, AS-56 (W02 delivers) |

## B. Debt-register rows that name `discovery` or S33 (all open)

| Row | What it says | What S33 does | Mechanism |
|---|---|---|---|
| D-6 (I.2) | `api/` and `application/` import `infra/` directly; repository ports missing | Introduce `domain/` ports with injection tokens: `QueryIndexSnapshotStore` (put, get, list, delete), `SnapshotPointer` (read, compare-and-set), `SearchLogReader` (eligible queries), `CatalogTitleSource` (wraps S32's `ProductTitleSuggester`), `Clock`; adapters in `infra/`. The controller makes one call to one application service (II.1) | Layering (I.2, I.3, III.1), no cross-domain mechanism needed |
| D-8 (X.4) | Barrels export infrastructure internals (projectors, consumers, `SearchQueryLogger`) | `SearchQueryLogger` and the projector exports leave the barrel (S32 owns them, A29 of S32); the barrel for this capability exports `AutocompleteModule` and `AutocompleteWorkerModule` only | X.4 entry point; apps import modules (X.1) |
| D-15 (X.5) | catalog → discovery (`SearchQueryLogger`) closes a cycle with orders and payments | Not caused here, but `AutocompleteModule` stops exporting `SearchQueryLogger`; S32 moves the logger into the search module and S05 removes its import | Event (`search.performed`) instead of an exported logger; X.5 |
| D-16 (X.3, X.7) | `libs/infrastructure/elasticsearch` is a product-index adapter | Autocomplete stops using `ElasticsearchService.suggestTitles` and the infrastructure import; it reaches the engine only through S32's `ProductTitleSuggester` | R1-style port inside the domain (same domain, exported application service), after S32 splits the client |
| D-7, D-12 (IX.4) | Other domains' models and raw SQL on other owners' tables | This capability has none (see section C) | — |

No row of `docs/architecture/debt-register.md` names S33 explicitly; the rows above name `discovery`.

## C. `pnpm --dir packages/backend check:table-ownership` lines for `discovery` (autocomplete part)

The command was **not run** while writing this spec: the sandbox required an approval it could not obtain unattended. The lines below were found by reading the autocomplete files (`grep` for `@app/domains/<other>`, `InjectModel`, `forFeature`, `sequelize.query`, quoted table names) on 2026-10-05; the implementation agent re-runs the command and treats any additional `discovery` line in these files as part of A16/A17.

| Kind | Where | What it touches | Owner | Replacement |
|---|---|---|---|---|
| — | `api/autocomplete.controller.ts`, `application/autocomplete.service.ts`, `infra/autocomplete-builder.jobs.ts`, `autocomplete.module.ts`, `autocomplete-worker.module.ts`, `domain/*` | No model, no `forFeature`, no Sequelize raw SQL. The only SQL is ClickHouse over `search_queries` (a discovery-owned analytics table) | discovery | None needed: the log read stays, behind the `SearchLogReader` port |
| Domain import | `autocomplete.module.ts:2`, `api/autocomplete.controller.ts:3` | `@app/domains/identity` (`AuthModule`, `Firewall`) | identity | Allowed (entry point, exported marker). After S01, import only the anonymous marker |
| Other lines of `discovery` | `application/shop-product-search.service.ts`, `search-reindex.service.ts`, `trending.service.ts`, `recommendations.service.ts` and their modules | `Product` table and `ProductModel` | S32, S34, S35 | Not this capability's; see their gaps (R1 `getProductsByIds`, R3 read models) |

## D. Ordered work list for the implementation agent

1. Contracts: `suggestQuerySchema`, `suggestResponseSchema`, problem codes in `packages/contracts` (A19). Ask S32/S50/S49 for their parts (see `questions.md`, CONTRACT lines) and stub the fuzzy port method behind `CatalogTitleSource` until S32 lands.
2. Pure domain first, test-first (VII.5): `suggestion-blend` (AS-14, AS-15), `catalog-circuit` (AS-21), `query-eligibility` (AS-38), `snapshot-pointer` (AS-39), `snapshot-codec` (AS-40), extend `top-k-trie` (AS-52–AS-54), reuse S32's query reducer (A3).
3. Ports and adapters (D-6): snapshot store, pointer (atomic compare-and-set), log reader (`surface`, window, floor, cap, timeout), catalog title source, clock.
4. Build job: eligibility, determinism, checksum envelope, unchanged / empty / superseded outcomes, retention, outcomes and metrics (A10–A13). Rewrite the builder e2e (AS-28–AS-37).
5. Serving service: integrity check, failure reasons, single-flight, cold start, pointer outage, hot swap, rollback (A14, A15, AS-41–AS-47). Remove `useTrie` from production code.
6. Suggest endpoint: DTO validation, one application service, blend, per-source budgets, parallel typo fallback, breaker, 60 s cache, headers, rate limit policy, problem+json (A1–A8, A20, AS-01–AS-13, AS-16–AS-27, AS-48).
7. Module and barrel: drop `@Global`, drop `SearchQueryLogger` and `AutocompleteService` exports, update `apps/core` and `apps/worker` composition if needed (A17, D-8, D-15, D-16).
8. Metrics and configuration validation (A18, AS-50, AS-51); run `check:boundaries` and `check:table-ownership --strict` (AS-49).
9. Web (W02 delivers, listed for coordination): new response type, debounce, abort, stale-answer guard, client cache, Playwright step (A23, AS-55, AS-56). Delete `suggestionsFrom` and `SuggestResponse` of the old shape.
10. Record the green runs of the four e2e files and the unit specs (VII.9); update `docs/architecture/pattern-map.md` P1101 status only if the evidence changes it.

## Sibling-spec follow-ups

- **S32**: export `ProductTitleSuggester` with `suggestTitles(prefix, size ≤ 10, signal?)` and `suggestTitlesFuzzy(prefix, size ≤ 10, signal?)` (typed timeout error). Until then S33 reads through `infra/catalog-title-source.adapter.ts` over the in-domain `ProductIndexPort.suggestTitles` (added in this pass: visibility filter, `title.autocomplete`, abort signal), and its fuzzy method rejects. When S32 exports the suggester, swap the adapter's body for it (the port and the tests stay). The `surface` column now exists in `110_search_measurement.sql` with default `''`; the S33 log reader reads `''` and `'http'` as typing and leaves `'internal'` out, so S32 must keep writing `'internal'` for the assistant's in-process searches and never repurpose the empty value. S32 also keeps the other `search_queries` columns the reader uses (`event_id, query, results, user_hash, ts`).
- **S50**: `discovery.suggest` (600/min per address, fail open) is declared in `discovery/rate-limit-policies.ts`; adopt it in any central registry.
- **W02**: adopt `suggestResponseSchema`; delete `suggestionsFrom` and the old `SuggestResponse` in `packages/web/lib/api/catalog.ts`; debounce 150 ms, abort superseded requests, drop stale answers, cache 60 s, accept unknown `source`; `suggestions` no longer exists in the search response.
- **S05**: remove any import of `SearchQueryLogger` from `@app/domains/discovery` (S33 stops exporting it).
- **infrastructure (object storage)**: `ObjectStorage` gained `list(prefix)` (S3 and in-memory implementations) for snapshot retention. Any other implementation or test double of `ObjectStorage` must add it.

## Provider side built in another layer (this pass)

- `libs/infrastructure/storage`: `ObjectStorage.list(prefix)` (needed to trim old snapshots; no existing method could list objects).
- `libs/common/config/autocomplete-config.ts`: the validated `AUTOCOMPLETE_*` keys (budgets, K, depth, floor, window, cap, poll, retention, log-query timeout, blocklist) and the blocklist rule.
- `discovery/domain/ports.ts`: `ProductIndexPort.suggestTitles` (the catalog half, until S32's `ProductTitleSuggester` exists).

## Deferred until a later pass

This pass covered the Setup and Foundational phases and the P1 stories US1, US2, US4 and US5 (AS-01 to AS-13, AS-16 to AS-21, AS-28 to AS-47, AS-38 to AS-40 and AS-52 to AS-54 in unit specs).

- **US3 Typo tolerance (P2)**, T033/T034, AS-22 to AS-27 — waits for **S32** to export `ProductTitleSuggester.suggestTitlesFuzzy` (the adapter's fuzzy method rejects today, so the speculative call is not started). Until then a double miss answers an empty 200, which is AS-27's behaviour.
- **US6 Operators can trust the platform (P2)**, T043 to T045, AS-49 to AS-51 — the platform e2e file, the barrel trim (`SearchQueryLogger` and projector exports stay in `discovery/index.ts` until then, so **S05** keeps compiling) and the configuration-failure rows. The boundary check (`pnpm check:boundaries`) is clean and `check:table-ownership --strict` lists no autocomplete line for `discovery`; the other `discovery` lines are S32/S34/S35's.
- **US7 Search page typing (P2, W02)**, T046, AS-55/AS-56 — owned by **W02**; its obligations are recorded under "Sibling-spec follow-ups". `packages/web/lib/api/catalog.ts` still reads the old `{queries, products, partial}` shape and will not match the new `GET /suggest` body until W02 adopts `suggestResponseSchema`.
- **Polish, cross-cutting and convergence (T047 to T050)** — final pass.

## Gate repairs

- The gate reported AS-55 and AS-56 without a test carrying their ID. The browser half belongs to W02 (US7), but the gate scans `packages/backend`, so `autocomplete-suggest.e2e-spec.ts` now has `S33 AS-55` and `S33 AS-56`. They prove the server half only: the ordered list for `iph`, its first entry usable as the `q` of a search, each answer naming its own prefix, and `Cache-Control: public, max-age=60`. The Playwright step, the stale-answer guard, the 150 ms debounce and the 60 s client cache are still W02 work and are not proven here.
- Test integrity reported `autocomplete.e2e-spec.ts: test file deleted` (T029 had removed the old spec). The file is back at the same path, rewritten for the new `GET /suggest` API: the whole journey logs → build → snapshot → hot swap → `/suggest` (popular/successful kept; rare, failed and blocklisted dropped) and the slow-catalog degradation within the budget. It has more `it(`/`expect(` calls than at HEAD. `check-tests.py integrity` passes, the four autocomplete e2e files (44 tests, with this one) pass, and `tsc --noEmit` is clean.
- `TopKTrie › S33 AS-54` failed the 2 KB-per-query memory bound (42.8 MB used against 40 MB for 20,000 queries). Cause: every trie node allocated a `Map` for children, although most nodes sit at the depth cap and are leaves. `domain/top-k-trie.ts` now creates `children` on the first child (`null` until then). Lookup and build behaviour are unchanged; the 13 trie tests pass, also alongside the other domain specs, and `tsc --noEmit` is clean. The test and its bound are untouched.
