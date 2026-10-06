# Test Plan: S16 — Seller Statements: Bitemporal Commission Rates, Monthly Statements, Period Close, Adjustments, As-Of Reports, CSV Export (domain `statements`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (83 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/statements/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `StatementsModule`, `StatementsWorkerModule` and `StatementsProjectorModule` with the production prefix, `ValidationPipe`, problem+json filter and interceptors, against real Postgres (real migrations, the exclusion constraint and range types), Redis and the job, outbox and inbox tables from `docker-compose.test.yaml`:
  - `commission-rates.e2e-spec.ts` — describe "Statements: bitemporal commission rates" (AS-01–AS-13)
  - `statement-read.e2e-spec.ts` — describe "Statements: seller statement reads and as-known-at" (AS-14–AS-27)
  - `period-close.e2e-spec.ts` — describe "Statements: period close and accounting periods" (AS-28–AS-39)
  - `adjustments.e2e-spec.ts` — describe "Statements: adjustments and corrections" (AS-40–AS-50)
  - `fact-ingestion.e2e-spec.ts` — describe "Statements: fact ingestion (R3 consumers)" (AS-51–AS-60)
  - `statement-export.e2e-spec.ts` — describe "Statements: streamed CSV export" (AS-61–AS-70)
  - `statement-reconciliation.e2e-spec.ts` — describe "Statements: reconciliation and golden dataset" (AS-71–AS-75)
  - `statements-ops.e2e-spec.ts` — describe "Statements: retention, boundaries, migration, configuration and shutdown" (AS-76–AS-83)
- Fixtures: shops are plain UUIDs registered with the S03 test double behind `ShopQueryService` and `ShopScoped` (members per role, non-members, unknown shop); admins and members come from the S01 and S03 fixtures. Facts are created only by delivering `order.paid`, `payout.paid` and `ledger.journal_posted` messages to the real consumers (never by inserting into the fact store); DS-1, RC1 and the golden dataset are fixture builders under `test/fixtures/statements/`. Privileged helpers (test code only, IX.6) are used solely where the scenario says so: tampering, removing the default rate, privileged `UPDATE`/`DELETE`.
- Only system edges are faked: identity token verification, S03's R1 answers (scriptable double), the clock (frozen, advanced by the test), the rate limiter's store (forced down in AS-25 and AS-68), the reporting replica handle (forced unreachable in AS-83), and the topic source for consumers (an in-memory delivery harness that can duplicate, reorder and replay messages and expose watermarks). No project repository, ORM or store is mocked.
- Jobs are invoked through the S49 handler registration (the same path the worker uses), delivering twice and concurrently where the scenario says so. Crashes (AS-36) are forced with a fault injected after the Nth batch.
- Consumers (VII.4): duplicate delivery gives one effect in AS-52, AS-56, AS-57; invalid payloads in AS-54.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5); money invariants also get `fast-check` properties: `commission-rate.spec.ts` (AS-04), `commission.spec.ts` (rounding properties for FR-011: `0 ≤ commission ≤ lineTotal`, `rate 0 → 0`, `rate 10000 → lineTotal`, monotone in rate; example AS-43 values), `period.spec.ts` (AS-55 month assignment, AS-49 booking month, AS-34 transition table), `recorded-instant.spec.ts` (AS-07), `reconciliation.spec.ts` (AS-47 completeness property over generated sequences of changes and late facts), `csv.spec.ts` (AS-64 cell rules).
- UI journeys (Playwright, happy path only): `packages/web/tests/seller-statements.spec.ts`, owned by the web capability that carries the statements tab (decision in `questions.md`) and by J01 (`buy-to-payout.spec.ts`, the monthly-statement step). Three happy paths only: AS-14 (open the live statement), AS-18 (pick an "as known on" date), AS-61 (download the CSV). No edge case below is re-tested in the UI.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` for the statements files (AS-77); `check:model-registry`.
- Gate 9 (VII.9): AS-25 (limiter down), AS-27 and AS-38 (unpriced lines), AS-36 (crash), AS-48 (race), AS-58 (lag), AS-67 (mid-stream failure), AS-68 (limiter down), AS-80 (shutdown), AS-83 (replica down) each force their fault.
- Concurrency rows (`Promise.all`) are repeated as stated and assert both the invariant (no overlapping current beliefs; snapshot plus adjustments equals recomputation) and the exact counts (VII.3). Every row asserts the response body **and** the persisted state (rows, outbox, inbox, job table) (VII.2); every e2e response body is parsed with its `packages/contracts` schema (VII.6).
- Benchmarks (not rows): `scripts/bench/statements-close-100k.ts` for SC-004 and the 200,000-line export for SC-006 run in the performance job, not in e2e.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 set a rate | `commission-rates.e2e-spec.ts` | — | — |
| AS-02 as-of lookup on both axes | `commission-rates.e2e-spec.ts` | — | — |
| AS-03 history is never rewritten | `commission-rates.e2e-spec.ts` | — | — |
| AS-04 precedence and boundaries | — | — | `commission-rate.spec.ts` (table over four rows × four lookups, boundary instants) |
| AS-05 the store refuses overlap | `commission-rates.e2e-spec.ts` (privileged insert) | — | — |
| AS-06 concurrent writers | `commission-rates.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-07 strictly increasing record instants | — | — | `recorded-instant.spec.ts` (table; the persisted non-empty periods are asserted inside AS-06) |
| AS-08 no-op change | `commission-rates.e2e-spec.ts` | — | — |
| AS-09 validation | `commission-rates.e2e-spec.ts` (one case per failure class) | — | — |
| AS-10 default never develops a hole | `commission-rates.e2e-spec.ts` | — | — |
| AS-11 who may write | `commission-rates.e2e-spec.ts` | — | — |
| AS-12 idempotency | `commission-rates.e2e-spec.ts` (replay, in-flight, different body, missing key) | — | — |
| AS-13 history and as-of reads | `commission-rates.e2e-spec.ts` | — | — |
| AS-14 open month, live | `statement-read.e2e-spec.ts` | `seller-statements.spec.ts` | — |
| AS-15 closed month from the snapshot | `statement-read.e2e-spec.ts` (asserts zero reads of facts and rates) | — | — |
| AS-16 closed month with a correction | `statement-read.e2e-spec.ts` | — | — |
| AS-17 the open month carries the adjustment | `statement-read.e2e-spec.ts` | — | — |
| AS-18 as known at an instant | `statement-read.e2e-spec.ts` | `seller-statements.spec.ts` (date picker) | — |
| AS-19 facts have a recorded time too | `statement-read.e2e-spec.ts` | — | — |
| AS-20 `knownAt` validation | `statement-read.e2e-spec.ts` | — | — |
| AS-21 empty, future, out-of-range months | `statement-read.e2e-spec.ts` | — | — |
| AS-22 months list | `statement-read.e2e-spec.ts` | — | — |
| AS-23 cross-tenant and permissions | `statement-read.e2e-spec.ts` (three routes × non-member, four roles) | — | — |
| AS-24 unauthenticated | `statement-read.e2e-spec.ts` | — | — |
| AS-25 rate limits and fail modes | `statement-read.e2e-spec.ts` (121st read; limiter store forced down) | — | — |
| AS-26 reads never change state | `statement-read.e2e-spec.ts` (before/after row, cache and outbox snapshot) | — | — |
| AS-27 unpriced lines are visible | `statement-read.e2e-spec.ts` | — | — |
| AS-28 close a month | `period-close.e2e-spec.ts` | J01 step (`buy-to-payout.spec.ts`) | — |
| AS-29 scheduled close, once | `period-close.e2e-spec.ts` (`Promise.all` on the handler) | — | — |
| AS-30 idempotent re-delivery | `period-close.e2e-spec.ts` | — | — |
| AS-31 a month that has not ended | `period-close.e2e-spec.ts` | — | — |
| AS-32 facts incomplete | `period-close.e2e-spec.ts` (consumer harness holds one event back) | — | — |
| AS-33 months close in order | `period-close.e2e-spec.ts` | — | — |
| AS-34 illegal transitions | `period-close.e2e-spec.ts` (HTTP `409`s, missing route `404`, privileged write rejected) | — | `period.spec.ts` (transition table: allowed `OPEN→CLOSING`, `CLOSING→CLOSED`, `CLOSING→OPEN`, all others forbidden) |
| AS-35 concurrent closes | `period-close.e2e-spec.ts` (`Promise.all`: one `202`, one `409`) | — | — |
| AS-36 a crash is resumable and deterministic | `period-close.e2e-spec.ts` (fault after batch 2; compare with an uninterrupted twin run) | — | — |
| AS-37 snapshots and adjustments are immutable | `period-close.e2e-spec.ts` (privileged `UPDATE`/`DELETE`) | — | — |
| AS-38 a failed close leaves nothing visible | `period-close.e2e-spec.ts` | — | — |
| AS-39 batched and bounded | `period-close.e2e-spec.ts` (25 shops, batch 10) | — | — |
| AS-40 retroactive rate change | `adjustments.e2e-spec.ts` | — | — |
| AS-41 replay and concurrency | `adjustments.e2e-spec.ts` (twice, and `Promise.all`) | — | — |
| AS-42 a second change, the same reason text | `adjustments.e2e-spec.ts` | — | — |
| AS-43 a change to the default rate reaches every shop | `adjustments.e2e-spec.ts` (one shop fails once; batch ≤ 1,000 asserted by config) | — | `commission.spec.ts` (the `2745`/`360` rounding examples) |
| AS-44 a change that touches nothing closed | `adjustments.e2e-spec.ts` | — | — |
| AS-45 a sale that arrives after the close | `adjustments.e2e-spec.ts` | — | — |
| AS-46 a payout that arrives after the close | `adjustments.e2e-spec.ts` | — | — |
| AS-47 completeness invariant | `adjustments.e2e-spec.ts` (one explicit sequence end to end) | — | `reconciliation.spec.ts` (`fast-check` over generated sequences) |
| AS-48 race with the close | `adjustments.e2e-spec.ts` (both orders around the cutoff) | — | — |
| AS-49 which month an adjustment lands in | — | — | `period.spec.ts` (table over instants and period states) |
| AS-50 adjustments ride the next close | `adjustments.e2e-spec.ts` | — | — |
| AS-51 sale facts applied | `fact-ingestion.e2e-spec.ts` | — | — |
| AS-52 duplicate delivery | `fact-ingestion.e2e-spec.ts` (twice, and `Promise.all`) | — | — |
| AS-53 out of order and replays | `fact-ingestion.e2e-spec.ts` | — | — |
| AS-54 invalid payloads | `fact-ingestion.e2e-spec.ts` (one message per failure class; dead-letter, no side effects, next message processed) | — | — |
| AS-55 UTC month assignment | — | — | `period.spec.ts` (table over instants and offsets) |
| AS-56 payouts | `fact-ingestion.e2e-spec.ts` | — | — |
| AS-57 ledger facts | `fact-ingestion.e2e-spec.ts` | — | — |
| AS-58 watermarks and freshness | `fact-ingestion.e2e-spec.ts` (lag forced above 60 s) | — | — |
| AS-59 rebuild by replay | `fact-ingestion.e2e-spec.ts` | — | — |
| AS-60 no cross-aggregate ordering assumed | `fact-ingestion.e2e-spec.ts` | — | — |
| AS-61 export | `statement-export.e2e-spec.ts` | `seller-statements.spec.ts` (download) | — |
| AS-62 closed months do not change | `statement-export.e2e-spec.ts` | — | — |
| AS-63 as known at | `statement-export.e2e-spec.ts` | — | — |
| AS-64 cells are safe, numbers stay numbers | `statement-export.e2e-spec.ts` (negative adjustment column stays `-900`) | — | `csv.spec.ts` (table over leading `=`, `+`, `-`, `@`, tab, CR, embedded quotes, null) |
| AS-65 constant memory, back-pressure | `statement-export.e2e-spec.ts` (slow reader; rows fetched ahead ≤ batch) | — | — |
| AS-66 client disconnects | `statement-export.e2e-spec.ts` | — | — |
| AS-67 server failure mid-stream | `statement-export.e2e-spec.ts` (fault after the first chunk; statement timeout) | — | — |
| AS-68 bounded concurrency | `statement-export.e2e-spec.ts` (third export `429`; limiter down `503`) | — | — |
| AS-69 empty month | `statement-export.e2e-spec.ts` | — | — |
| AS-70 identity of lines | `statement-export.e2e-spec.ts` | — | — |
| AS-71 golden dataset | `statement-reconciliation.e2e-spec.ts` (compares to the checked-in expected JSON; repeated after a replay) | — | — |
| AS-72 clean reconciliation | `statement-reconciliation.e2e-spec.ts` | — | — |
| AS-73 differences become findings | `statement-reconciliation.e2e-spec.ts` (twice; then agreement clears) | — | — |
| AS-74 missing on one side | `statement-reconciliation.e2e-spec.ts` | — | — |
| AS-75 tampering is detected | `statement-reconciliation.e2e-spec.ts` (privileged tamper; findings route paged, `invalid_cursor`, admin only) | — | — |
| AS-76 retention | `statements-ops.e2e-spec.ts` (shop offboarding via S03's fixture, then reads) | — | — |
| AS-77 boundaries | — (static gates: `check:table-ownership --strict`, `check:boundaries`) | — | — |
| AS-78 migration keeps closed months | `statements-ops.e2e-spec.ts` (old-shape seed, migrate twice, compare bodies) | — | — |
| AS-79 configuration | `statements-ops.e2e-spec.ts` (one invalid setting per case, startup fails with the key) | — | — |
| AS-80 graceful shutdown | `statements-ops.e2e-spec.ts` | — | — |
| AS-81 timeouts | `statements-ops.e2e-spec.ts` (statement timeout forced; generic `detail`) | — | — |
| AS-82 metrics and logs | `statements-ops.e2e-spec.ts` (each outcome of AS-01–AS-75 moves its metric; log capture has no CSV content or buyer ID) | — | — |
| AS-83 replica reads | `statements-ops.e2e-spec.ts` (replica forced down: one fallback, metric) | — | — |
