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
