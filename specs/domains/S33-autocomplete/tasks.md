# Tasks: S33 — Search Autocomplete

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md` (A1–A23, D-6/D-8/D-15/D-16), `data-model.md`, `contracts/suggest-api.md`, `research.md`, `questions.md` (defaults accepted).
**Tests**: required (test-plan.md, constitution VII). Within each story every failing test task precedes the code task that turns it green.

**Path shorthand**: `DISC` = `packages/backend/libs/domains/discovery`; `CONTRACTS` = `packages/contracts/src/search`. Run backend commands from `packages/backend`; e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>`; unit specs through `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/discovery/domain`. After 5 failed fixes of the same test, stop and write the blocker into `questions.md`.

**Rules for every task**: no `git checkout/restore/reset/stash/clean` (undo by hand-editing only the named lines); no new `sequelize.transaction` (none exist in the touched files, R-9); no query text in logs or metric labels; `domain/` never uses `new Date()` (inject `Clock`).

E2E keys: K=`autocomplete-suggest`, D=`autocomplete-sources`, B=`autocomplete-snapshot`, P=`autocomplete-platform` (`DISC/<key>.e2e-spec.ts`).

## Phase 1: Setup

- [X] T001 Confirm `fast-check` is a dev dependency of `packages/backend` (add it to `packages/backend/package.json` if absent) for AS-53
- [X] T002 [P] Create `CONTRACTS/suggest.ts`: `suggestQuerySchema` (`.strict()`; `q` string required, ≤ 100 chars after reduction; `limit` integer 1–10 default 8), `suggestResponseSchema` (`{prefix, suggestions:[{text, source:'query'|'catalog'|'typo'}], degraded: ('catalog_timeout'|'catalog_unavailable'|'typo_fallback_timeout'|'typo_fallback_unavailable'|'query_index_unavailable')[]}`), problem codes `validation_failed`, `rate_limited`; export from `CONTRACTS/index.ts` (A19)
- [X] T003 [P] Create `DISC/domain/autocomplete-ports.ts` with `QueryIndexSnapshotStore{put,get,list,delete}`, `SnapshotPointer{read,compareAndSet,forceSet}`, `SearchLogReader{eligibleQueries(params, signal)}`, `CatalogTitleSource{suggestTitles,suggestTitlesFuzzy}(prefix,size,signal)` with a typed timeout error, `Clock{now}`, plus injection tokens (D-6, A16)
- [X] T004 [P] Create `DISC/infra/system-clock.ts` implementing `Clock`
- [X] T005 Create `DISC/infra/autocomplete-config.ts`: validated settings (catalog budget 40 ms, typo budget 40 ms, K=10, depth 20, floor 5, window 30 days, cap 200,000, poll 30 s, retention 5 snapshots / 1 h, blocklist `fake, counterfeit, stolen, hack, hacked` whole-word), startup failure naming the offending key (A18, FR-039)
- [X] T006 [P] Add policy `discovery.suggest` (sliding window, 600/min, key `ip`, `failMode: 'open'`) to `DISC/rate-limit-policies.ts` (A4, R-3)

## Phase 2: Foundational (blocks all stories)

- [X] T007 Write unit spec `DISC/domain/query-eligibility.spec.ts` (`it.each`: whole-word blocklist, email, nine-digit run, card-like number, `[redacted]`, length < 2, non-normalised) — AS-38; must fail first
- [X] T008 Implement `DISC/domain/query-eligibility.ts` (reuses `domain/query-text.ts` reducer/redactor, R-2) until T007 passes
- [X] T009 [P] Write unit spec `DISC/domain/suggestion-blend.spec.ts` (de-duplication on normalised text, first wins — AS-14; slot allocation `⌈0.6×limit⌉` queries, catalog cap 5, rest to the other, `it.each` over seven cases — AS-15)
- [X] T010 Implement `DISC/domain/suggestion-blend.ts` until T009 passes
- [X] T011 [P] Write unit spec `DISC/domain/catalog-circuit.spec.ts` (5 consecutive failures → open 10 s → one half-open probe → closed on success; injected clock) — AS-21
- [X] T012 Implement `DISC/domain/catalog-circuit.ts` until T011 passes
- [X] T013 [P] Extend `DISC/domain/top-k-trie.spec.ts`: `it.each` behaviour table incl. ties, multi-byte, prefix longer than depth (AS-52); `fast-check` property against brute force (AS-53); scaled memory-bound test (AS-54, A21)
- [X] T014 Adapt `DISC/domain/top-k-trie.ts` until T013 passes: delete local `normalizeQuery` (A3), keep precomputed top-K, ties by text
- [X] T015 [P] Write unit spec `DISC/domain/snapshot-codec.spec.ts` (round trip; flipped byte → checksum; truncated; unknown format; invalid entry; duplicate entry) — AS-40
- [X] T016 Implement `DISC/domain/snapshot-codec.ts` until T015 passes: envelope `{format: 1, version, createdAt, params{window,floor,cap,k,depth}, checksum, entries[]}`, gzip JSON, entries sorted `searchers DESC, query ASC`, only `{query, searchers}` (no user ids, SC-009)
- [X] T017 [P] Write unit spec `DISC/domain/snapshot-pointer.spec.ts` (forward-only: `V_m > V_n`; equal/older rejected; forceSet path allowed) — AS-39
- [X] T018 Implement `DISC/domain/snapshot-pointer.ts` until T017 passes
- [X] T019 [P] Implement `DISC/infra/snapshot-store.adapter.ts` (`ObjectStorage`, key `autocomplete/<version>.json.gz`)
- [X] T020 [P] Implement `DISC/infra/snapshot-pointer.adapter.ts` (Redis `autocomplete:current`; Lua compare-and-set on sortable UTC versions; explicit `forceSet` for operators — R-6)
- [X] T021 [P] Implement `DISC/infra/search-log-reader.adapter.ts` (ClickHouse `search_queries`, read-only; columns `event_id, query, results, user_hash, surface, ts`; missing `surface` ⇒ `'http'`; `FINAL`, distinct `event_id`, `uniqExact(user_hash)`, window, floor, cap, `ORDER BY searchers DESC, query ASC`, own timeout below `maxRuntimeMs` — R-7)
- [X] T022 [P] Implement `DISC/infra/catalog-title-source.adapter.ts` implementing `CatalogTitleSource`: wrap S32 `ProductTitleSuggester` (replaces `ElasticsearchService.suggestTitles`); while it is not exported, sit over `ProductIndexPort` (`PRODUCT_INDEX`) with the visibility filter, and make `suggestTitlesFuzzy` reject as unavailable until S32 lands (R-1)
- [X] T023 [P] Implement `DISC/infra/autocomplete-metrics.ts` registering `autocomplete_requests_total{status}`, `autocomplete_degraded_total{reason}`, `autocomplete_source_duration_seconds{source}`, `autocomplete_circuit_state`, `autocomplete_builds_total{outcome}`, `autocomplete_snapshot_age_seconds`, `autocomplete_snapshot_version`, `autocomplete_snapshot_load_failures_total{reason}` (A18, bounded labels)
- [X] T024 Rework `DISC/autocomplete.module.ts` and `DISC/autocomplete-worker.module.ts`: remove `@Global()`, export nothing, bind port tokens to adapters (A17, A16)

**Checkpoint**: unit specs green via `test-spec.sh libs/domains/discovery/domain`.

## Phase 3: User Story 1 — Suggestions as I type (P1) 🎯 MVP

**Goal**: validated public `GET /suggest` returning blended, cacheable answers. **Independent test**: K file green with a built snapshot.

- [X] T025 [US1] Create `DISC/autocomplete-suggest.e2e-spec.ts` (describe `Search autocomplete API`) with real `AutocompleteModule` + production pipe/filter/interceptors, state reset, and every 200/error body parsed by `suggestResponseSchema`/problem schema; rows AS-01 (exact body, `Cache-Control`, no `Set-Cookie`, snapshot/pointer unchanged), AS-02 (tie order, byte-identical replay), AS-03 (default 8, `limit=3`, invalid limits → 400), AS-04 (four inputs reduce to same prefix), AS-05 (empty/space/control chars → 200 empty, engine and index spies 0), AS-06 (missing `q`, 101 chars, unknown param → problem+json with `errors[]`), AS-07 (seven hostile payloads), AS-08 (no/valid/invalid token identical 200), AS-09 (601st → 429 `rate_limited` + `Retry-After`; limiter store down → 200), AS-10 (400/429 `no-store`), AS-11 (24- and 35-char prefixes return the 46-char query), AS-12 (blocklist changed + restart, no build → no `cheap` from any source), AS-48 (two users + anonymous identical, no cookie, no credential `Vary`, logs hold no raw `q`). Run; must fail
- [X] T026 [US1] Create `DISC/application/query-index.service.ts` skeleton exposing `lookup(prefix, limit)` and readiness over a loaded `TopKTrie` (full behaviour in US5, T041)
- [X] T027 [US1] Create `DISC/application/suggest.service.ts`: reduce prefix (empty ⇒ 200 empty without touching sources), query-index lookup, blend through `suggestion-blend`, apply serve-time blocklist to every source, request log with prefix length and degraded reasons only (A1, A9, A20), metrics
- [X] T028 [US1] Create `DISC/api/suggest.controller.ts` replacing `api/autocomplete.controller.ts`: `GET /suggest`, `@RateLimit('discovery.suggest')`, no `skipThrottle`, parse `Record<string, unknown>` with `suggestQuerySchema` (R-4), one call to `SuggestService`, `Cache-Control: public, max-age=60, s-maxage=60` only when `degraded` is empty else `no-store`, errors `no-store`, anonymous (A2, A4, A5)
- [X] T029 [US1] Delete `DISC/api/autocomplete.controller.ts` and the old `DISC/autocomplete.e2e-spec.ts`; update module wiring; run `test-spec.sh autocomplete-suggest` until green

## Phase 4: User Story 2 — Catalog completions within budget (P1)

**Goal**: visible-product titles through the port, per-prefix cache, breaker, 40 ms budget. **Independent test**: D rows AS-13, AS-16–AS-20.

- [X] T030 [US2] Create `DISC/autocomplete-sources.e2e-spec.ts` (describe `Autocomplete source budgets and typo fallback`; engine client faked at the edge, frozen clock) with AS-13 (visible vs archived/sandbox/suspended; `q=i` → engine spy 0), AS-16 (hang → ≤ 250 ms, `catalog_timeout`, `no-store`, abort fired, metric +1), AS-17 (reject, 5xx, typed timeout → `catalog_unavailable`/`catalog_timeout`; no error text in body/log), AS-18 (no snapshot + failing engine → 200 empty, two reasons), AS-19 (five failures, sixth skipped, probe after 10 s, concurrent skip, recovery), AS-20 (three calls plus `IPH` → one engine call; second after 60 s; failures not cached). Run; must fail
- [X] T031 [US2] In `DISC/application/suggest.service.ts` add a bounded in-process 60 s per-prefix cache (failures never stored, R-8) and the catalog call with 40 ms budget, `AbortSignal`, breaker wiring, `degraded` reasons, `query_index_unavailable` when no index (A6, A7)
- [X] T032 [US2] Use `CatalogTitleSource` only (no `libs/infrastructure/elasticsearch` import in `DISC/application/` or `DISC/api/`; D-16, S32 follow-up); run `test-spec.sh autocomplete-sources` until AS-13/16–20 green

## Phase 5: User Story 3 — Typo tolerance (P2)

**Independent test**: D rows AS-22–AS-27.

- [ ] T033 [US3] Extend `DISC/autocomplete-sources.e2e-spec.ts` with AS-22 (`iphnoe` on double miss → one `typo` entry), AS-23 (`iph` → fuzzy spy 0), AS-24 (catalog prefix wins, fuzzy discarded), AS-25 (`zz` → fuzzy spy 0), AS-26 (timeout → `typo_fallback_timeout`; reject → `typo_fallback_unavailable`; unused failing source changes nothing), AS-27 (`zzzzqq` → 200 empty, cacheable). Run; must fail
- [ ] T034 [US3] In `DISC/application/suggest.service.ts` start the fuzzy call speculatively in parallel with the catalog call (prefix ≥ 3 chars, 40 ms budget, ≤ 5 entries, `source: 'typo'`), use it only when query index and catalog prefix both return nothing, record typo degraded reasons; run until AS-22–AS-27 green (A8)

## Phase 6: User Story 4 — Hourly safe build (P1)

**Independent test**: B rows AS-28–AS-37.

- [X] T035 [US4] Create `DISC/autocomplete-snapshot.e2e-spec.ts` (describe `Autocomplete snapshot build and hot swap`) driven through the real handler `search.build-autocomplete` and real job table, with build rows AS-28 (all listed eligibility rows incl. legacy PII and duplicate `event_id` → exactly seven queries), AS-29 (object exists, checksum verifies, only `{query, searchers}`, pointer == version, build metric), AS-30 (second run `unchanged`, no new object, pointer untouched), AS-31 (truncated table → `skipped_empty`, pointer unchanged), AS-32 (log timeout → retriable failure, nothing pointed), AS-33 (`Promise.all` two builds → newer pointed, older `superseded` and object removed), AS-34 (reversed/late batches identical to in-order), AS-35 (cap 3 → three most popular, ties by text), AS-36 (sixth publish leaves five; pointed and young unreferenced kept), AS-37 (two worker modules, one build per trigger, duplicate trigger no-op). Run; must fail
- [X] T036 [US4] Create `DISC/application/autocomplete-build.service.ts`: read through `SearchLogReader`, apply `query-eligibility`, encode via `snapshot-codec`, outcomes `published | unchanged | skipped_empty | superseded`, compare-and-set pointer, delete own object when superseded, retention (five newest + pointed, unreferenced < 1 h kept), version from `Clock`, metrics (A10–A13)
- [X] T037 [US4] Rewrite `DISC/infra/autocomplete-builder.jobs.ts` as a thin `@JobHandler` calling the build service; keep `declareJobType` with payload contract next to the `JobPayloads` augmentation (S49 follow-up); set `leaseMs: 600_000` and `maxRuntimeMs: 600_000` explicitly (valid: ≥ lease); cron `7 * * * *`, concurrency 1; catch `InvalidScheduleError` (not generic `Error`) around `upsertSchedule`; grep that no `JobsService.cancel` caller exists in discovery autocomplete files
- [X] T038 [US4] Add the S49 option check to the B file (handler options validate; `maxRuntimeMs ≥ leaseMs`; the log-query timeout is below `maxRuntimeMs`); run `test-spec.sh autocomplete-snapshot` build rows until green
- [X] T039 [US4] Confirm the build never assumes per-query ordering in `search.performed` (S32 keys by `searchId`; AS-34) and note it in the B file header

## Phase 7: User Story 5 — Hot swap on every node (P1)

**Independent test**: B rows AS-41–AS-47.

- [X] T040 [US5] Extend `DISC/autocomplete-snapshot.e2e-spec.ts` with AS-41 (200 concurrent calls while pointer moves; each answer entirely V1 or V2; version metric), AS-42 (flipped byte / bad compression / unknown format → keeps V2, failure metric per reason, one retry per poll, recovery on V4), AS-43 (missing object → `reason="missing"`, still serving), AS-44 (no pointer → ready, catalog only, `query_index_unavailable`, `no-store`; pointer appears → loaded), AS-45 (pointer store down during poll → keeps serving, metric, recovers), AS-46 (overlapping refreshes → one download via storage spy), AS-47 (pointer set back to V2 via `forceSet` → nodes load V2). Run; must fail
- [X] T041 [US5] Complete `DISC/application/query-index.service.ts`: 30 s poll, verify checksum/format/entries via codec, failure reasons `missing|checksum|corrupt|format|invalid_entry|pointer_unreachable` (no raw error text in logs), retry a bad version at most once per poll, single-flight refresh, build trie off to the side then swap by reference, follow pointer in either direction, ready when no snapshot, snapshot age/version gauges (A14, A15)
- [X] T042 [US5] Delete `DISC/application/autocomplete.service.ts` including the `useTrie` hook and its direct `RedisService`/`ObjectStorage`/`ElasticsearchService` imports; run `test-spec.sh autocomplete-snapshot` fully until green

## Phase 8: User Story 6 — Operators can trust the platform (P2)

**Independent test**: P rows AS-49–AS-51 (unit AS-52–54 done in Phase 2).

- [ ] T043 [US6] Create `DISC/autocomplete-platform.e2e-spec.ts` (describe `Autocomplete module boundary, metrics and configuration`): AS-49 (runs `pnpm check:boundaries` and `pnpm check:table-ownership --strict`; imports `@app/domains/discovery` and asserts the barrel exports `AutocompleteModule` and `AutocompleteWorkerModule` only), AS-50 (after each traffic kind the listed series and labels exist; no label holds query text), AS-51 (each invalid config value fails startup naming the key; valid values start). Run; must fail
- [ ] T044 [US6] Update `DISC/index.ts`: drop `SearchQueryLogger` and projector exports as S32 permits, export only the two autocomplete modules (D-8, D-15)
- [ ] T045 [US6] Run `pnpm --dir packages/backend check:boundaries` and `check:table-ownership --strict`; fix any additional `discovery` autocomplete lines (A16, A17); run `test-spec.sh autocomplete-platform` until green

## Phase 9: User Story 7 — Search page typing (P2, owned by W02)

- [ ] T046 [US7] Do not edit `packages/web`. Confirm W02's obligations (A23, AS-55, AS-56, FR-042) are recorded under "Sibling-spec follow-ups" in `specs/domains/S33-autocomplete/gaps.md` (W02, S32, S50, S05 bullets exist); add a W02 note that `suggestions` no longer exists in the search response if missing

## Phase 10: Polish and cross-cutting

- [ ] T047 Keep the **S32** bullet in `specs/domains/S33-autocomplete/gaps.md` current (`suggestTitlesFuzzy`, `surface` column) once T022/T032 settle what S32 still owes
- [ ] T048 Verify `quickstart.md` "Ops artifacts" lists SC-001, SC-003, SC-007, SC-008 and the edge-cache item, and that `specs/UNVERIFIED.md` rows 70–73 read "not run" (already present); never describe them as verified
- [ ] T049 Final gates from `packages/backend`: `pnpm exec tsc --noEmit`, ESLint for `packages/backend` and `packages/contracts`; run all four e2e files plus the domain unit specs once (fallback paths AS-16, 17, 19, 26, 31, 42, 44 forced, VII.9); confirm no `sequelize.transaction` was added in the discovery domain
- [ ] T050 Report the follow-ups with their satisfying tasks: S32 `ProductTitleSuggester` / `searchId` keying / `suggestions` removal (T022, T032, T039, T046); S49 `declareJobType`, `InvalidScheduleError`, `JobsService.cancel` (T037); S33 `maxRuntimeMs` (T037, T038)

## Dependencies and order

- Setup (T001–T006) → Foundational (T007–T024) → stories. US1 (MVP) first; US2 depends on US1's service; US3 depends on US2; US4 and US5 depend only on Foundational and can run alongside US1–US3 (T041 completes the T026 skeleton); US6 after the others; Polish last.
- Test-first pairs: T007→T008, T009→T010, T011→T012, T013→T014, T015→T016, T017→T018, T025→T027–T029, T030→T031–T032, T033→T034, T035→T036–T038, T040→T041–T042, T043→T044–T045.

## Parallel examples

- Foundational: T009, T011, T013, T015, T017 (specs) together; then T019–T023 (adapters, metrics) together.
- After Foundational: US4 (T035–T039) alongside US1 (T025–T029).

## Coverage

- Gaps: A1 T027; A2 T028; A3 T014; A4 T006/T028; A5 T028; A6 T031/T032; A7 T031; A8 T034; A9 T027/T008; A10–A13 T036/T037; A14–A15 T041/T042; A16 T003/T024; A17 T024/T044; A18 T005/T023/T043; A19 T002; A20 T027; A21 T013; A22 T025/T030/T035/T040/T043; A23 T046. D-6 T003; D-8 T044; D-15 T044; D-16 T022/T032.
- AS-01…AS-56 all mapped (AS-55/56 to W02 via T046).
