# Tasks: S16 — Seller statements (domain `statements`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md`, `research.md`, `data-model.md`, `contracts/*`, `quickstart.md`. Constitution `.specify/memory/constitution.md`.

**Conventions**
- `D` = `packages/backend/libs/domains/statements`, `C` = `packages/contracts/src/statements`, `F` = `packages/backend/test/fixtures/statements`, `M` = `packages/backend/migrations`. Backend commands run from `packages/backend`.
- Test specs run with `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; narrowest spec per change, whole `libs/domains/statements` once at the end. Same test failing after 5 fixes → write the blocker in `questions.md` and stop.
- Test-first: inside each story the failing test task precedes the code tasks that make it pass. Tests create their own shops/orders/facts through the real consumers (L-005, L-006); every assertion can fail (L-003); a scenario is never dropped when a test file is split or renamed (L-017).
- Money is `BIGINT`/`…Minor`; clock is the injected `CLOCK` (no `new Date()`/`now()`); transactions only via `TransactionRunner.run`/`@Transactional` (rule 4); never `git checkout/restore/reset/stash/clean`; never touch `*.reviewed.json`.
- Format: `- [ ] Txxx [P] [USn] Description with path`. `[P]` = different files, no dependency on an unfinished task.

## Phase 1: Setup

- [X] T001 Run `pnpm --dir packages/backend check:table-ownership` and record its `statements` rows (note at top of section C) in `specs/domains/S16-seller-statements/gaps.md` §C; add any row not already listed.
- [X] T002 Create the living page `docs/spec/capabilities/S16-seller-statements.md` (rules + behaviors for rates, statements, close, adjustments, ingestion, CSV, reconciliation, retention 10 y/no buyer id, `payouts.read`, the breaking API changes of `contracts/http.md` "Compatibility", known limit: refunds ignored). Fill each `[proof: …]`/`[code: …]` as tasks land; run `python3 scripts/livespec/check.py` from repo root (rule 0). No `*.reviewed.json`.
- [X] T003 [P] Create `C/{index,rates,statements,periods,findings,events}.ts` zod schemas for every body in `contracts/http.md` and the two events in `contracts/events.md` (money `…Minor` integers; `source: 'as_known_at'`; `own/adjustmentsBooked/adjustmentsReferencing/total/corrected/unpricedLineCount/knownAt/dataAsOf/currency`); export from `packages/contracts/src/index.ts` (FR-052, A5).
- [X] T004 [P] Create `D/domain/config.ts` (zod; keys, defaults and ranges exactly as `contracts/config.md`; an invalid value fails startup naming the key) and `D/domain/errors.ts` (problem codes of `contracts/http.md`) (A25, FR-049).
- [X] T005 [P] Create `D/domain/ports.ts` with tokens `RATE_REPOSITORY, FACT_REPOSITORY, PERIOD_REPOSITORY, SNAPSHOT_REPOSITORY, ADJUSTMENT_REPOSITORY, FINDING_REPOSITORY, STATEMENT_READER, SHOP_DIRECTORY` and their interfaces (B1, B2).

## Phase 2: Foundational (blocks all stories)

- [X] T006 Write `M/<ts>-statements-s16-expand.js` per `data-model.md`, idempotent (`IF NOT EXISTS`), `lock_timeout` set: `CommissionRate` (+`changeId UUID NOT NULL` backfill `id`, +`recordedBy UUID NULL`, check `char_length(reason) BETWEEN 1 AND 200`, category `lower(btrim())` backfill, history keyset index); `AccountingPeriod` (status check `OPEN|CLOSING|CLOSED`, +`knowledgeCutoff`, +`shopCount`, +`runId`); `StatementSnapshot` (+`knowledgeCutoff NOT NULL` backfill `computedAt`, +`payoutsPaidMinor BIGINT NOT NULL DEFAULT 0`, +`adjGrossMinor, adjCommissionMinor, adjLineCount, adjPayoutsMinor`, +`runId`); `StatementAdjustment` (+`causeKind NOT NULL` in `rate_change|late_sale|late_payout`, +`causeRef TEXT NOT NULL`, +`grossDeltaMinor, lineCountDelta, payoutsPaidDeltaMinor` default 0, new unique `(shopId, refersToMonth, causeKind, causeRef)`); new tables `StatementSaleFact` (PK `(orderId, lineId, orderVersion)`, check `lineTotalMinor = quantity*unitPriceMinor - discountMinor` and `0 ≤ lineTotalMinor ≤ 1000000000000`, no buyer column, index `(shopId, paidAt, orderId, lineId)`), `StatementPayoutFact` (PK `payoutId`), `StatementLedgerFact` (PK `journalId`, `orderId NULL`), `StatementLedgerCredit` (PK `(journalId, accountId)`), `StatementStreamWatermark` (PK `stream` in `orders|payouts|ledger`), `StatementPeriodRun` (partial unique `(month) WHERE status='RUNNING'`), `StatementPeriodHistory`, `StatementFinding` (unique `(month, kind, coalesce(shopId,'00000000-…'))`, keyset index `(month, openedAt desc, id desc)`); triggers `statements_period_guard` (only OPEN→CLOSING, CLOSING→CLOSED, CLOSING→OPEN; no DELETE), `statements_snapshot_guard` (UPDATE rejected; DELETE rejected when month CLOSED), `statements_adjustment_guard` (no UPDATE/DELETE). Legacy columns stay; migrating twice changes nothing (A11, A12, A29).
- [X] T007 Update `packages/backend/db/ownership.ts` with rows for all new tables, functions and triggers (owner `domain:statements`, no FK to other domains); run `pnpm check:table-ownership --strict` and `pnpm check:model-registry` (AS-77).
- [X] T008 [P] Create sequelize models in `D/infra/models/*.model.ts` for the owned tables only (existing and new) and register them in the module model lists / registry.
- [X] T009 [P] Build fixtures in `F/`: shop double over `ShopQueryService`/`ShopScoped` (members per role, non-members, unknown shop), `orderPaid()/payoutPaid()/ledgerJournal()` message builders, in-memory consumer delivery harness (duplicate, reorder, replay, hold back, expose watermarks), frozen/advancing clock helper, privileged tamper helper (test code only, `ALTER TABLE … DISABLE TRIGGER` in one session), DS-1 and RC1 builders.
- [X] T010 [P] Build the golden dataset builder and checked-in `F/golden.expected.json` (used by AS-71).
- [X] T011 Register topic `statements.events` in `packages/backend/libs/infrastructure/events/topic-registry.ts`; define every queue/topic/table the code names in the test stack (`elasticmq.conf`, Kafka topics; L-002, L-011, L-020) and confirm with the doctor.
- [X] T012 Create module skeletons: `D/statements.module.ts` (core: HTTP + use cases + repositories + `CommissionRateQueryService`), `D/statements-worker.module.ts` (own providers; boots standalone, L-018), `D/statements-projector.module.ts`; wire into `apps/core`, `apps/worker`, `apps/projector`; stop using the private `infra/reporting-pool.ts` in favour of `READ_REPLICA_CONNECTION` (A27, B6). Start each app alone to prove the skeleton boots (L-004, L-015).
- [X] T013 Update `D/index.ts` exports: the three modules, `CommissionRateQueryService` + DTO types, event contracts, policies (A32).
- [X] T014 [P] Create `D/domain/metrics.ts` with all FR-054 metrics (`statements_events_applied_total{stream,outcome}`, `statements_events_rejected_total{stream,reason}`, `statements_ingestion_lag_seconds{stream}`, replica fallback, export outcomes) (A24).
- [X] T015 [P] Rewrite `D/rate-limit-policies.ts`: declare `statements.read` (120/min/user, fail open), `statements.export.concurrent` (2/shop, fail closed), `statements.admin.read` (120/min, open), `statements.admin.write` (30/min, closed); keep `exports.concurrent` declared until T074 (A8, D5, S50 G-35).
- [X] T016 Create `D/domain/period.ts` skeleton (types only; functions are written test-first in T030, T046 and T055).

**Checkpoint**: migration applies twice on a fresh stack; `tsc`, `check:table-ownership` and the three apps (each alone) boot.

## Phase 3: US1 — Commission rates keep every belief ever held (P1, MVP)

**Independent test**: `commission-rates.e2e-spec.ts` + `domain/commission-rate.spec.ts`, `recorded-instant.spec.ts`, `commission.spec.ts`.

- [X] T017 [P] [US1] Unit `D/domain/commission-rate.spec.ts`: AS-04 table over four rows × four lookups incl. boundary instants. Must fail first.
- [X] T018 [P] [US1] Unit `D/domain/recorded-instant.spec.ts`: AS-07 strictly increasing record instants (same instant never yields an empty recorded period).
- [X] T019 [P] [US1] Unit `D/domain/commission.spec.ts`: `fast-check` FR-011 (`0 ≤ commission ≤ lineTotal`, rate 0→0, rate 10000→lineTotal, monotone in rate), the `2745`/`360` examples (AS-43), half-up per line, summed.
- [X] T020 [US1] E2E `D/commission-rates.e2e-spec.ts`, describe "Statements: bitemporal commission rates": AS-01 (201, body, history row, `changeId`, `recordedBy`), AS-02 (as-of on both axes, 3 beliefs), AS-03 (history never rewritten), AS-05 (privileged insert refused by the exclusion constraint), AS-06 (`Promise.all` writers: no overlapping current beliefs, non-empty periods), AS-08 (no-op → 200, no row, no job), AS-09 (one case per failure class), AS-10 (`422 default_rate_gap`), AS-11 (admin only; 403, 401), AS-12 (replay, in-flight 409, different body, missing key 422), AS-13 (keyset history, `invalid_cursor`, as-of route, `known_at_in_future`). Assert persisted rows, outbox and job table; parse bodies with `C` schemas.
- [X] T021 [P] [US1] Implement `D/domain/commission.ts` (half-up per line, integer only), `D/domain/rate-lookup.ts` (precedence, validAt/knownAt), `D/domain/recorded-instant.ts` (A15, B2).
- [X] T022 [P] [US1] Implement `D/infra/commission-rate.repository.ts` (SQL with bound params, history keyset `(lower("recordedPeriod") desc, id desc)`, as-of lookup) and `D/domain/cursor.ts` (opaque base64url, `invalid_cursor`) (A17).
- [X] T023 [P] [US1] Implement `D/infra/shop-directory.adapter.ts` over `ShopQueryService.getShopsByIds` (C5); remove any `ShopModel`/`ShopMembershipModel`/`MembershipService`/raw tenancy SQL from the domain (S03 follow-up).
- [X] T024 [US1] Rewrite `D/application/commission-rate.service.ts` `setRate` through `TransactionRunner.run` (delete its `// S54 T037 audit` comment), advisory lock, injected `CLOCK`, change ID, no-op detection, `default_rate_gap` guard, shop existence, `recordedBy`; enqueue `statements.reconcile-month` keyed by change ID inside the transaction; history and as-of use cases (A15, A16, A17, C5).
- [X] T025 [US1] Implement `D/application/commission-rate-query.service.ts` (`getRatesAsOf`, R1 batch export) and export it from `index.ts` (A32, D8).
- [X] T026 [US1] Implement `D/api/commission-rates.controller.ts` (`POST` 201/200 with `@Idempotent()`, `GET` history, `GET /as-of`), `Firewall({roles:[ADMIN]})`, policies `statements.admin.write/read`, zod pipes in `D/api/statements.dto.ts` (A15, A17, II.1).
- [X] T027 [US1] Run `test-spec.sh libs/domains/statements/domain` and `…/commission-rates.e2e-spec.ts` until green; update living-page proofs.

## Phase 4: US5 — Facts arrive once, in any order, and can be replayed (P2; built before reads because reads depend on facts)

**Independent test**: `fact-ingestion.e2e-spec.ts`, `domain/period.spec.ts` (AS-55).

- [X] T028 [P] [US5] Unit `D/domain/period.spec.ts` (part 1): AS-55 UTC month assignment table over instants and offsets (A3).
- [X] T029 [US5] E2E `D/fact-ingestion.e2e-spec.ts`, describe "Statements: fact ingestion (R3 consumers)": AS-51 (sale facts applied, `recordedAt = occurredAt`, no buyer column), AS-52 (duplicate delivery, and `Promise.all`: one effect), AS-53 (out of order and replays; versions by `orderVersion`), AS-54 (one message per failure class → dead-letter reasons of `contracts/events.md`, no side effects, next message processed, v1 ledger payload skipped and counted), AS-56 (`payout.paid` from `payouts.events`, `amountMinor`, `paidAt`, `payoutVersion` discard, other payout types ignored), AS-57 (`ledger.journal_posted` v2 only; `SALE` kept; `SHOP_<id>`/`PLATFORM_FEES` credits), AS-58 (lag forced > 60 s → `dataAsOf`, metric; Gate 9), AS-59 (rebuild by replay reproduces answers), AS-60 (no cross-aggregate ordering assumed).
- [X] T030 [US5] Implement month/UTC functions in `D/domain/period.ts` (T028 green).
- [X] T031 [P] [US5] Implement `D/infra/fact.repository.ts` (append-only sale facts with `appliedAt`; payout upsert `WHERE payoutVersion < EXCLUDED.payoutVersion`; `ON CONFLICT DO NOTHING` ledger facts/credits) and `D/infra/watermark.repository.ts` (idle-topic rule `clock.now() − 5 s`).
- [X] T032 [P] [US5] Implement `D/infra/order-paid.projector.ts` (`statements-sales`; `orderPaidFactSchema` picking fields explicitly; reasons `invalid_payload, missing_line_id, missing_shop, currency_not_eur, line_total_mismatch, amount_too_large, unknown_version`; category trim/lower 1–64; inbox claim + `versionGuard` in one transaction) (A1, A20, C1, S05/S10 follow-ups).
- [X] T033 [P] [US5] Implement `D/infra/payout-paid.projector.ts` (`statements-payouts`; import `payoutPaidSchema` from `packages/contracts/src/payments/payout-events.ts`) (C4, S15 follow-up).
- [X] T034 [P] [US5] Implement `D/infra/ledger-journal.projector.ts` (`statements-ledger`; `journalPostedV2Schema`; kind `SALE` only; never read `LedgerEntry`/`LedgerJournal`) (S14 follow-up).
- [X] T035 [US5] Implement `D/application/fact-ingestion.service.ts`: apply validated facts, update watermarks in the batch transaction, enqueue `statements.reconcile-month` (`late_sale:<orderId>`/`late_payout:<payoutId>`) when a fact with event time ≤ a closed month's cutoff is applied (A13); wire the projectors into `statements-projector.module.ts`.
- [X] T036 [US5] Run `fact-ingestion.e2e-spec.ts` and `domain/period.spec.ts` until green.

## Phase 5: US2 — A seller reads any month, as it is now or as it was known (P1)

**Independent test**: `statement-read.e2e-spec.ts`.

- [X] T037 [US2] E2E `D/statement-read.e2e-spec.ts`, describe "Statements: seller statement reads and as-known-at": AS-14 (open month live, `dataAsOf`), AS-15 (closed month from snapshot; zero reads of facts and rates asserted), AS-16 (closed month with a correction), AS-17 (open month carries the adjustment), AS-18 (as known at an instant, both axes), AS-19 (facts have a recorded time), AS-20 (`knownAt` validation, future → `422 known_at_in_future`), AS-21 (`2026-13` → 400, future/pre-2020 → `422 month_not_available`), AS-22 (months list, keyset, `invalid_cursor`), AS-23 (three routes × non-member `404 shop_not_found` identical to unknown shop; four roles: VIEWER and STAFF `403`, OWNER/ADMIN `200`), AS-24 (401), AS-25 (121st read 429; limiter store down; Gate 9), AS-26 (reads never change rows, cache, outbox, jobs), AS-27 (unpriced lines visible; Gate 9). Also a parity case: SQL aggregate equals `domain/commission.ts`.
- [X] T038 [P] [US2] Implement `D/domain/statement-view.ts` (own/total/corrected composition).
- [X] T039 [P] [US2] Implement `D/infra/statement.reader.ts`: UTC month bounds as bound `timestamptz`, `LEFT JOIN LATERAL` best rate (never drops unpriced lines), as-known-at on both axes, replica handle with one primary fallback + metric, explicit `statement_timeout` (A1–A4, A27).
- [X] T040 [P] [US2] Implement `D/infra/snapshot.repository.ts` read side (closed month with adjustments, months list).
- [X] T041 [US2] Rewrite `D/application/statement.service.ts` as read use cases (live/snapshot/as-known-at/list), clock-bound validation, no SQL and no `@nestjs/sequelize` import; remove the old `closeMonth`/`retroAdjust` bodies (B1, A31).
- [X] T042 [US2] Implement `D/api/statements.controller.ts` seller routes (`GET /shops/:shopId/statements`, `/:month`) with `ShopScoped('payouts.read')`, `@RateLimit('statements.read')`, zod pipes (A6, A7, A8, II.1).
- [X] T043 [US2] Run `statement-read.e2e-spec.ts` until green.

## Phase 6: US3 — Closing a month freezes it, exactly once, in order (P1)

**Independent test**: `period-close.e2e-spec.ts`, `domain/period.spec.ts` (AS-34).

- [X] T044 [P] [US3] Unit `D/domain/period.spec.ts` (part 2): AS-34 transition table (allowed OPEN→CLOSING, CLOSING→CLOSED, CLOSING→OPEN; all others forbidden).
- [X] T045 [US3] E2E `D/period-close.e2e-spec.ts`, describe "Statements: period close and accounting periods": AS-28 (snapshots, `period_closed` outbox row, history row, follow-up jobs), AS-29 (scheduled close once via `Promise.all` on the handler; malformed payload rejected without effects), AS-30 (re-delivery idempotent), AS-31 (`409 period_not_ended`), AS-32 (`period_not_ready` with `details {stream, watermark}`), AS-33 (`previous_period_open`), AS-34 (HTTP 409s, missing reopen route 404, privileged write rejected), AS-35 (`Promise.all`: one 202, one 409), AS-36 (fault after batch 2; resume equals an uninterrupted twin; Gate 9), AS-37 (privileged `UPDATE`/`DELETE` rejected), AS-38 (unpriced lines → failed close, nothing visible, back to `OPEN`; Gate 9), AS-39 (25 shops, batch 10).
- [X] T046 [P] [US3] Implement `D/domain/period.ts` `transition` (T044 green) and `D/infra/period.repository.ts` (conditional `UPDATE … WHERE status = :from` + history row, run record), plus the batch snapshot writer in `D/infra/snapshot.repository.ts` (batches ≤ `STATEMENTS_SNAPSHOT_BATCH`, one `knowledgeCutoff`, visible only when `CLOSED`).
- [X] T047 [US3] Implement `D/application/period-close.service.ts` (request, run, resume, finalise; `TransactionRunner` only; `period_closed` outbox in the finalising transaction; cooperative stop; margin `STATEMENTS_CLOSE_MARGIN_MIN`; watermark completeness) and delete the remaining `// S54 T037 audit` site (A9, B4).
- [X] T048 [US3] Implement `D/application/events/statements-events.ts` (`defineEvent` for `statements.period_closed` and `statements.adjustment_booked`, schemas from `C/events.ts`).
- [X] T049 [US3] Implement `D/infra/statements.jobs.ts`: `declareJobType` with zod payloads, `@JobHandler` `statements.close-month` (concurrency 1, 3 attempts, `period_not_ready` re-enqueue with backoff), schedule `0 2 2 * *` zone `UTC` via `upsertSchedule`, timeout `STATEMENTS_JOB_TIMEOUT_MS`; register in `statements-worker.module.ts` (A23).
- [X] T050 [US3] Implement `D/api/accounting-periods.controller.ts` (`GET` list, `GET :month`, `POST :month/close` 202 with `@Idempotent()`, admin `Firewall`, `statements.admin.*`) (A10).
- [X] T051 [US3] Run `period-close.e2e-spec.ts` and `domain/period.spec.ts` until green.

## Phase 7: US4 — Late knowledge becomes an adjustment, never an edit (P1)

**Independent test**: `adjustments.e2e-spec.ts`, `domain/period.spec.ts` (AS-49), `domain/reconciliation.spec.ts` (AS-47).

- [X] T052 [P] [US4] Unit `D/domain/period.spec.ts` (part 3): AS-49 booking month (earliest open month after it) over instants and period states.
- [X] T053 [P] [US4] Unit `D/domain/reconciliation.spec.ts`: AS-47 `fast-check` completeness (frozen + adjustments = fresh recomputation) over generated sequences of rate changes and late facts.
- [X] T054 [US4] E2E `D/adjustments.e2e-spec.ts`, describe "Statements: adjustments and corrections": AS-40 (retroactive rate change → one adjustment per affected closed month/shop, `adjustment_booked` outbox), AS-41 (replay and `Promise.all`: exactly one), AS-42 (second change with the same reason text → second adjustment), AS-43 (default-rate change reaches every shop; one shop fails once and is isolated; batch ≤ 1,000), AS-44 (touches nothing closed → none), AS-45 (late sale), AS-46 (late payout), AS-47 (explicit sequence end to end), AS-48 (race with the close, both orders; Gate 9), AS-50 (adjustments ride the next close).
- [X] T055 [P] [US4] Implement `D/domain/residual.ts` (fresh recomputation − snapshot − earlier adjustments; four deltas) and the booking rule in `D/domain/period.ts` (T052 green).
- [X] T056 [P] [US4] Implement `D/infra/adjustment.repository.ts` (unique `(shop, month, causeKind, causeRef)`, per shop-month advisory lock, keyset shop batches).
- [X] T057 [US4] Implement `D/application/adjustment.service.ts` (`reconcile-month`; one shop's failure isolated and re-enqueued; `adjustment_booked` outbox row in the same transaction; cooperative stop) and register `statements.reconcile-month` (concurrency 4, enqueue key `<cause>:<month>[:<shopId>]`) and the legacy `statements.retro-adjust` mapping to `rate_change:legacy:<reason>` in `statements.jobs.ts` (A12, A13, A14, A16).
- [X] T058 [US4] Trigger reconcile from close completion (`close:<runId>`) in `period-close.service.ts`; run `adjustments.e2e-spec.ts`, `domain/reconciliation.spec.ts`, `domain/period.spec.ts` until green.

## Phase 8: US6 — A seller downloads a statement as CSV (P2)

**Independent test**: `statement-export.e2e-spec.ts`, `domain/csv.spec.ts`.

- [X] T059 [P] [US6] Unit `D/domain/csv.spec.ts`: AS-64 cell table (leading `=`, `+`, `-`, `@`, tab, CR, embedded quotes, null); numbers never neutralised.
- [X] T060 [US6] E2E `D/statement-export.e2e-spec.ts`, describe "Statements: streamed CSV export": AS-61 (headers and first line per `contracts/http.md`, row order `paidAt, orderId, lineId`), AS-62 (closed month byte-identical after a rate change), AS-63 (`knownAt`), AS-64 (negative adjustment column stays `-900`), AS-65 (slow reader: rows fetched ahead ≤ batch), AS-66 (disconnect frees the connection ≤ 5 s), AS-67 (fault after first chunk and statement timeout abort the response; Gate 9), AS-68 (third concurrent export 429; limiter down 503; Gate 9), AS-69 (empty month), AS-70 (line identity `lineId`).
- [X] T061 [P] [US6] Implement `D/domain/csv.ts` (text cells neutralised, integer columns numeric) (T059 green).
- [X] T062 [P] [US6] Implement `D/infra/streaming-response.ts` (filter in charge until the first byte, abort afterwards) (B5, A19).
- [X] T063 [US6] Rewrite `D/infra/statement-export.ts`: cursor stream over owned facts/rates/snapshots only, batch `STATEMENTS_EXPORT_BATCH`, read-only replica transaction with `SET LOCAL statement_timeout`, closed months priced at the snapshot cutoff, adjustment rows, `rateBps`/`commissionMinor` columns (A18, C2).
- [X] T064 [US6] Wire the CSV route into the seller controller with `statements.read` + `statements.export.concurrent` and drain `STATEMENTS_DRAIN_MS` through the shutdown registry; run `statement-export.e2e-spec.ts` and `domain/csv.spec.ts` until green.

## Phase 9: US7 — Closed numbers are proven against the ledger and themselves (P2)

**Independent test**: `statement-reconciliation.e2e-spec.ts`.

- [X] T065 [US7] E2E `D/statement-reconciliation.e2e-spec.ts`, describe "Statements: reconciliation and golden dataset": AS-71 (golden dataset equals `golden.expected.json`, repeated after a replay), AS-72 (clean month yields none), AS-73 (net/fee differences → findings, twice, then agreement clears), AS-74 (missing on either side; `missing_in_ledger` grace 24 h), AS-75 (privileged tamper detected; findings route paged, `invalid_cursor`, admin only).
- [X] T066 [P] [US7] Implement `D/domain/reconciliation.ts` (expected vs actual, finding kinds, grace) and `D/infra/finding.repository.ts` (upsert per `(month, kind, shop)`, auto-clear, keyset).
- [X] T067 [US7] Implement `D/application/verification.service.ts` and handlers `statements.verify-period` / `statements.verify-periods` (daily 04:00 UTC) in `statements.jobs.ts`; unlinked journals skipped and counted; add `GET /admin/accounting-periods/:month/findings` to the periods controller; run the spec until green.

## Phase 10: US8 — The domain is safe to run, move and keep (P3)

**Independent test**: `statements-ops.e2e-spec.ts`; AS-77 by static gates.

- [X] T068 [US8] E2E `D/statements-ops.e2e-spec.ts`, describe "Statements: retention, boundaries, migration, configuration and shutdown": AS-76 (shop offboarding via S03 fixture, reads still work for admins; no delete route), AS-78 (old-shape seed, migrate twice, compare bodies), AS-79 (one invalid setting per case, startup fails naming the key), AS-80 (graceful shutdown: close left `CLOSING` and resumable; export drain; Gate 9), AS-81 (statement timeout forced; generic `detail`), AS-82 (each outcome of AS-01–AS-75 moves its metric; logs hold no CSV content or buyer id), AS-83 (replica forced down: one fallback, metric; Gate 9).
- [X] T069 [US8] Wire `domain/config.ts` into module init, metrics into every use case/projector/job, stop signal and shutdown registry into close/reconcile/export, generic problem `detail` for timeouts (A24–A26, FR-049, FR-054).
- [X] T070 [US8] State retention (10 years, never deleted on shop/user deletion) in the living page and add a check that no buyer column/identifier exists in owned tables or the export; no purge is built (A28).
- [X] T071 [US8] Run `statements-ops.e2e-spec.ts` until green; run `pnpm check:boundaries` and `pnpm check:table-ownership --strict` for AS-77.

## Phase 11: Polish & cross-cutting

- [X] T072 Write `M/<ts>-statements-s16-contract.js` (drop `UNIQUE(shopId, refersToMonth, reason)`, `causeKind/causeRef` become the identity, drop the legacy job type); a separate deploy step, not run until the legacy reader and queue are gone (A12, A29).
- [X] T073 Delete the old `D/statements.e2e-spec.ts` once every scenario lives in the eight new specs (record the mapping, L-017); delete `D/infra/reporting-pool.ts`; remove leftover `@InjectConnection`/`sequelize` imports from `application/`; confirm direct `sequelize.transaction` count in the domain is 0 and both `// S54 T037 audit` comments are gone (C3).
- [X] T074 Policies: confirm statements uses only its own declared names; keep `exports.concurrent` declared (other domains borrow it) and note in `gaps.md` § Sibling-spec follow-ups that S50 may delete it later (S50 G-35 follow-up).
- [X] T075 Update `docs/work/architecture/domain-map.md` (§statements, ~lines 215-216 and 388) and `debt-register.md` (D-12 closed) to "R3 events into a statements-owned store; ClickHouse optional for heavy analytics" (C6).
- [X] T076 Add `scripts/bench/statements-close-100k.ts` (SC-004) and the k6 read script notes (SC-005); keep `Ops artifacts` in `quickstart.md` (SC-004, SC-005, SC-007, D7) and the three existing S16 rows in `specs/UNVERIFIED.md` as `not run`; add a row for the W04/J01 UI journeys (D7) if absent. Never describe them as verified.
- [X] T077 Update `gaps.md`: `## Spec changes` (None unless a signed page changed) and `## Sibling-spec follow-ups` (S10 `lineId`/`category`/history re-emit and drop S16 from `getOrderLines` consumers C7; S14 SALE journal shape and `getRatesAsOf` adoption; S50 policy names; S53 topic; W04/J01 UI) up to date with what landed; record the status of D1–D8.
- [X] T078 Static gates: `pnpm tsc --noEmit`, `pnpm lint` (backend and contracts), `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, `pnpm check:model-registry`, `pnpm check:no-wallclock`, the S54 transaction gate, and `python3 scripts/livespec/check.py` (repo root).
- [X] T079 Run the whole capability once: `test-spec.sh libs/domains/statements`, in batches of fresh processes (L-008).
- [X] T080 Runtime proofs by script (L-004, L-012, L-015, L-018, L-019): start `apps/core`, `apps/worker`, `apps/projector` each on its own and reach ready (worker registers schedules; projector joins the three groups); run the statements suite on an empty stack with `scripts/qa/fresh-run.sh`. _Done so far: `scripts/infra/boot-app.sh` brought `core`, `worker` (registers the four statements job types) and `projector` (declares the three statements consumers, proven by `apps/projector/src/statements-wiring.e2e-spec.ts`) UP on their own. `scripts/qa/fresh-run.sh --here` (the mode for a machine whose dev stack is already up; a throwaway stack cannot start beside `payment_system_*`) passed: monolith ready, live doctor clean. Limit: a true throwaway empty-volume run of the statements suite was not possible on this machine; it stays for the final checkpoint runner (L-019)._

## Dependencies & order

- Phase 1 → Phase 2 (blocks everything). T006 → T007 → T008; T012 needs T008 and T013.
- US1 is independent after Phase 2 (MVP). US5 next, since US2/US3/US4/US6/US7 tests deliver facts through its consumers. US2 needs US1+US5; US3 needs US2+US5; US4 needs US1+US3+US5; US6 needs US2+US3; US7 needs US3+US5; US8 needs all.
- Inside a story: test tasks → pure domain code → repositories → services → controllers/jobs → run the spec.
- Phase 11 after all stories; T072 is a separate deploy step.

## Parallel examples

- Phase 1: T003, T004, T005. Phase 2: T008, T009, T010, T014, T015.
- US1: T017, T018, T019, then T021, T022, T023. US5: T031–T034. US6: T059 with T061, T062.

## Implementation strategy

MVP = Phases 1–2 + US1. Then US5 → US2 → US3 → US4 (the P1 money-correctness chain), then US6, US7, US8, then Polish. Each story ends with its spec green before the next starts; whole suite, static gates and runtime proofs run once at the end (T078–T080).

## Coverage check

- Scenarios: AS-01–13 → T017–T020; AS-14–27 → T037; AS-28–39 → T044–T045; AS-40–50 → T052–T054; AS-51–60 → T028–T029; AS-61–70 → T059–T060; AS-71–75 → T065; AS-76–83 → T068 (AS-77 via T071).
- Gaps: A1–A32, B1–B6, C1–C7 map to T001–T077 as tagged; D1–D8 are tracked in T077 (owners outside this spec).
- Follow-ups from built specs: S03 (T023, T037, T068), S05/S10 (T032), S14 (T025, T034), S15 (T033), S50 (T015, T074).
