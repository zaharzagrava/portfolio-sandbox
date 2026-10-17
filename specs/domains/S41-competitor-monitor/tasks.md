---

description: "Task list for S41 — Competitor Price Monitor (domain seller-insights)"
---

# Tasks: S41 — Competitor Price Monitor

**Input**: `plan.md`, `spec.md` (6 stories, 57 scenarios AS-01–AS-57, FR-001–FR-035, SC-001–SC-008), `test-plan.md`, `gaps.md` (A1–A34, B, C, D, Spec changes, Sibling follow-ups), `research.md` (D-01–D-16), `data-model.md`, `contracts/api.md`, `contracts/events.md`, `quickstart.md`, `questions.md` (defaults accepted).

**Tests**: REQUESTED (test-plan.md, constitution VII). Within each story every test task comes **before** the code task it proves; run it, see it fail, then implement.

**Path shorthand** (all under `/opt/sdd/repo`): `SI` = `packages/backend/libs/domains/seller-insights`; `BE` = `packages/backend`; `CT` = `packages/contracts/src/seller-insights`. Backend commands run from `packages/backend`; e2e specs through `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern> [-t "AS-nn"]`.

**Rules for every task**: no `git checkout/restore/reset/stash/clean`; no new direct `sequelize.transaction` (use `TransactionRunner.run` / `@Transactional`; delete any `// S54 T037 audit` comment in a touched file); no foreign `*Model`, no `JOIN "Product"`/`"Shop"`/`"ShopMembership"`; never edit `*.reviewed.json`; never add a task that runs a runtime proof (fresh stack, standalone boots, journey/browser suite, test_doctor) — those are deferred to the final checkpoint. After 5 failed fixes of one test, write the blocker in `questions.md` and stop.

## Format: `- [ ] [ID] [P?] [Story] Description with file path`

Implementation notes (deviations from the text below are recorded in `gaps.md` "Spec changes"): the ClickHouse file is `BE/clickhouse/131_competitor_prices_v2.sql`; the seen-set reuses the cache library's `RedisBloomFilter`; `SI/competitor-evaluation.module.ts` was added next to the three modules; the load scripts are Node scripts (`competitor-crawl.ts`, `competitor-api.ts`) not run in CI; billing gained the `maxCompetitorWatches` key and a migration for its database check.

---

## Phase 1: Setup (living spec first, rule 0)

- [X] T001 Write the living specification page `docs/spec/capabilities/S41-competitor-monitor.md`
- [X] T002 [P] Add `SI/testing/competitor-fixtures.ts` (and `competitor-site.ts`): fixture competitor sites, resolver double, fault switches, frozen clock
- [X] T003 [P] Create `SI/competitor-stores.module.ts` (`CompetitorStoresModule`, D-01)

---

## Phase 2: Foundational (blocks every story)

### Contracts (gaps D.1, A33, FR-034)

- [X] T004 [P] Write contract unit tests in `CT/competitors.spec.ts`
- [X] T005 Create `CT/competitors.ts` (export from the contracts barrel)
- [X] T006 [P] Create `CT/competitor-events.ts`

### Schema (gaps D.2, A34, section C row 4, A25)

- [X] T007 Write the expand migration `BE/migrations/20261017400000-competitor-s41-expand.js`
- [X] T008 [P] Write `BE/clickhouse/131_competitor_prices_v2.sql`
- [X] T009 Register `CompetitorShop` as `domain:seller-insights` in `BE/db/ownership.ts`
- [X] T010 [P] Add Sequelize models `competitor-watch.model.ts`, `crawl-target.model.ts`, `competitor-shop.model.ts`

### Domain scaffolding and config

- [X] T011 [P] Create `SI/domain/crawler-ports.ts`
- [X] T012 [P] Create `SI/domain/competitor-errors.ts`
- [X] T013 [P] Write failing unit test `SI/application/crawler.config.spec.ts` for AS-56
- [X] T014 Create `SI/application/crawler.config.ts` (and the joi keys and production rule in `BE/libs/common/config/competitor-config.ts`)
- [X] T015 [P] Create `SI/application/crawler.metrics.ts`

**Checkpoint**: contracts, schema, ports, config exist; stories can start.

---

## Phase 3: User Story 1 — A seller registers a competitor URL (P1) 🎯 MVP

### Tests (write first, must fail)

- [X] T016 [P] [US1] `SI/domain/url.spec.ts` (AS-40)
- [X] T017 [US1] `SI/competitor-watches.e2e-spec.ts` — AS-01 to AS-04
- [X] T018 [US1] same file: AS-05 to AS-07
- [X] T019 [US1] same file: AS-08 to AS-11 (AS-10 limiter-down in its own describe with a fault proxy)

### Implementation

- [X] T020 [US1] Rewrite `SI/domain/url.ts`
- [X] T021 [P] [US1] Create `SI/infra/pg-watch.repository.ts` and `SI/infra/pg-target.repository.ts`
- [X] T022 [P] [US1] Create `SI/infra/redis-seen-set.ts`
- [X] T023 [P] [US1] Create `SI/infra/safe-fetcher.ts` (additive `strictRedirects` option in `libs/infrastructure/net`)
- [X] T024 [US1] Create `SI/application/competitor-watch.service.ts` `register()`
- [X] T025 [US1] Create `SI/api/competitors.controller.ts` and the rate-limit policy
- [X] T026 [US1] Create `SI/competitors.module.ts`, export it from `SI/index.ts`, wire into the core app
- [X] T027 [US1] Run T016–T019 until green

**Checkpoint**: registration works end-to-end and is independently testable (MVP).

---

## Phase 4: User Story 2 — Manage watches and read price history (P2)

- [X] T028 [US2] In `SI/competitor-watches.e2e-spec.ts` add AS-12 to AS-15
- [X] T029 [P] [US2] Create `SI/infra/clickhouse-observation-history.ts`
- [X] T030 [US2] Extend `competitor-watch.service.ts` with `list()`, `remove()` and `prices()`
- [X] T031 [US2] Add the list, delete and prices routes to the controller
- [X] T032 [US2] Run T028 green

**Checkpoint**: US1 + US2 work.

---

## Phase 5: User Story 3 — Pages are fetched politely and safely (P1)

- [X] T033 [P] [US3] `SI/domain/robots.spec.ts` (AS-19)
- [X] T034 [P] [US3] `SI/domain/schedule.spec.ts`
- [X] T035 [US3] `SI/competitor-crawl.e2e-spec.ts` — AS-16 to AS-18
- [X] T036 [US3] same file: AS-20 to AS-22
- [X] T037 [US3] same file: AS-23 to AS-25
- [X] T038 [US3] same file: AS-26 to AS-28
- [X] T039 [US3] same file: AS-29 to AS-31
- [X] T040 [US3] Rewrite `SI/domain/robots.ts`
- [X] T041 [US3] Create `SI/domain/schedule.ts`
- [X] T042 [P] [US3] Create `SI/infra/redis-robots-cache.ts`
- [X] T043 [P] [US3] Create `SI/infra/redis-frontier.ts`
- [X] T044 [US3] Create `SI/application/crawl.service.ts`
- [X] T045 [US3] Create `SI/application/crawl-scheduler.service.ts`
- [X] T046 [US3] Create `SI/crawler-worker.module.ts` and `SI/infra/crawler.worker.ts`; wire into the worker app
- [X] T047 [US3] Run T033–T039 green

**Checkpoint**: crawling is polite, safe and observable at the crawl level.

---

## Phase 6: User Story 4 — Prices are read reliably, changes never missed (P1)

- [X] T048 [P] [US4] `SI/domain/extract-price.spec.ts` (AS-33)
- [X] T049 [P] [US4] `SI/domain/simhash.spec.ts` (AS-36)
- [X] T050 [P] [US4] `SI/domain/alert-rule.spec.ts`
- [X] T051 [US4] `SI/competitor-pricing.e2e-spec.ts` — AS-32, AS-34, AS-35, AS-37
- [X] T052 [US4] same file: AS-38, AS-39, AS-41, AS-42
- [X] T053 [US4] Rewrite `SI/domain/extract-price.ts`
- [X] T054 [US4] Fix `SI/domain/simhash.ts`
- [X] T055 [US4] Create `SI/domain/alert-rule.ts`
- [X] T056 [P] [US4] Create `SI/infra/s3-page-archive.ts`
- [X] T057 [US4] Implement the observation step in `crawl.service.ts`
- [X] T058 [US4] Run T048–T052 green

**Checkpoint**: US4 independent of alerts.

---

## Phase 7: User Story 5 — Owners are alerted when a competitor undercuts them (P1)

- [X] T059 [US5] `SI/competitor-alerts.e2e-spec.ts` — AS-43 to AS-45
- [X] T060 [US5] same file: AS-46 to AS-50
- [X] T061 [US5] Update `SI/application/events/seller-insights-events.ts` (`priceVersion`, deterministic event id in `alert-rule.ts`)
- [X] T062 [US5] Create `SI/application/competitor-evaluation.service.ts`
- [X] T063 [US5] Call evaluation from `crawl.service.ts` and from `CompetitorWatchService.register()`
- [X] T064 [US5] Run T059–T060 green

**Checkpoint**: alerts correct and replay-safe.

---

## Phase 8: User Story 6 — The monitor follows its sources and stays operable (P2)

- [X] T065 [US6] `SI/competitor-reactions.e2e-spec.ts` — AS-51 to AS-53
- [X] T066 [US6] same file: AS-54 to AS-56
- [X] T067 [P] [US6] Create `SI/application/competitor-shop.service.ts` (and `pg-competitor-shop.repository.ts`)
- [X] T068 [P] [US6] Create `SI/infra/projectors/competitor.projectors.ts`
- [X] T069 [US6] Create `SI/competitor-projector.module.ts`, export it and wire it into the projector app
- [X] T070 [US6] Create `SI/application/crawl-retention.service.ts` and the job `crawler.purge-targets`
- [X] T071 [US6] Bucket lifecycle at bootstrap (`s3-page-archive.ts#ensureLifecycle`), metrics and log wiring, `CrawlerConfig` validated at start
- [X] T072 [US6] Run T065–T066 green

**Checkpoint**: all six stories functional.

---

## Phase 9: Table ownership, cleanup and gap closure

- [X] T073 Delete the old crawler module, service, frontier, unit spec and e2e spec (their scenarios live in AS-43, AS-35, AS-26)
- [X] T074 Update `SI/index.ts` to export `CompetitorsModule`, `CrawlerWorkerModule`, `CompetitorProjectorModule` (and the pinned list in `index.e2e-spec.ts`)
- [X] T075 Audit for direct `sequelize.transaction`: none in the domain
- [X] T076 S03 follow-up: no foreign model or tenancy/catalog SQL in the capability's code or testing kit
- [X] T077 S54 follow-up: `SafeRequestErrorKind` strings used verbatim; registration maps `invalid_url`/`blocked_address` → `422 url_not_allowed`, `unresolvable` → `422 url_unresolvable`
- [X] T078 AS-57 static conditions: `check:table-ownership --strict` and `check:boundaries` pass, `CompetitorShop` registered, no FK in the migrations
- [X] T079 [P] SC-007 load script `BE/scripts/load-tests/competitor-crawl.ts` (not run in CI)
- [X] T080 [P] SC-006 load script `BE/scripts/load-tests/competitor-api.ts` (not run in CI)

## Phase 10: Documentation, Ops artifacts, sibling follow-ups

- [X] T081 `quickstart.md` "Ops artifacts" lists SC-005, SC-006, SC-007 as "not run" and `specs/UNVERIFIED.md` has exactly one row each
- [X] T082 `gaps.md` "Spec changes" matches what was implemented
- [X] T083 `gaps.md` "Sibling-spec follow-ups" lists S18, S28, S53, S54, S50, S49, S40, S03
- [X] T084 Finish the living page against the implemented behaviour (code references and proofs verified by hand; `scripts/livespec/check.py` itself needs an approval this unattended run cannot get)
- [X] T085 Run the whole capability suite once: the five e2e files (160 tests), the domain and application unit specs, `tsc --noEmit`, ESLint

---

## Coverage map (gaps.md and follow-ups → tasks)

A1 T025,T030,T031 · A2 T021 · A3 T024 · A4 T021 · A5 T020,T024 · A6 T024 · A7 T025,T031 · A8 T014 · A9 T023 · A10 T045 · A11 T044 · A12 T043 · A13 T041,T044 · A14 T040,T042 · A15 T040,T041 · A16 T040 · A17 T053 · A18 T020 · A19 T054 · A20 T041,T057 · A21 T029,T057 · A22 T057,T062 · A23 T061–T063 · A24 T063 · A25 T067,T068 · A26 T070 · A27 T015,T044,T071 · A28 T014,T071 · A29 T022 · A30 T046 · A31 T011,T073 · A32 T002,T073 · A33 T005,T006 · A34 T008 · B (D-6/7/8/12) T011,T002,T074,T076 · C T007,T009,T063,T073,T076 · D.1 T005,T006 · D.2 T007,T008 · D.3 T023 · D.4 T022 · D.5 T026,T046,T069 · D.6 all test tasks · D.7 T014,T022,T063 · D.8 T079,T080 · D.9 T001,T084 · D.10 T023,T077 · Sibling follow-ups T083 · Spec changes T082 · Follow-ups: S03 T076, S05 T024,T062, S28 T061, S49 T046,T070, S54 T023,T077, S54 T037 T075.
