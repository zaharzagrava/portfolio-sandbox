# Gaps: S16 — Seller statements (domain `statements`)

What the current code gets wrong or lacks against [`spec.md`](spec.md). This is the implementation agent's to-do list. References are `file:line` under `packages/backend/libs/domains/statements/` unless stated. Decisions behind each item are in [`questions.md`](questions.md).

**Note on the ownership check.** `pnpm --dir packages/backend check:table-ownership` could not be run in the spec session (the command needed an approval that an unattended run cannot give). The findings in section C were therefore derived by reading the domain's code, module wiring, barrel and spec; the implementation agent MUST run the check first, record its output for the `statements` rows, and add any row not listed here.

## A. Behaviour gaps

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Sales are read from orders and catalog tables, not from facts; the month, the paid statuses and the category come from `BisOrder`, `BisOrderItem`, `Product` | `application/statement.service.ts:21, 44-57` | FR-011, FR-012, FR-033, AS-51 |
| A2 | A sale line with no resolving rate disappears (inner `CROSS JOIN LATERAL`); `rateAsOf` answers `0` when nothing matches; the default rate may be given a gap | `application/statement.service.ts:48-57`, `application/commission-rate.service.ts:84` | FR-005, FR-014, AS-10, AS-27, AS-38 |
| A3 | Month boundaries depend on the database session time zone: `CAST(:month AS date)` compared to `timestamptz`, `tstzrange(month, month + interval '1 month')` | `application/statement.service.ts:55, 137` | FR-012, AS-55 |
| A4 | `knownAt` re-prices current facts only: facts have no recorded time, adjustments are not returned, the future and non-instants (`new Date('2026')`) are accepted | `application/statement.service.ts:71-74`, `api/statements.controller.ts:30-31` | FR-015, FR-016, AS-18–AS-20 |
| A5 | The statement body is untyped numbers named `gross/commission/net/lines`; no `currency`, `status`, `knownAt`, `dataAsOf`, `own/total/corrected`, no contracts schema; the open month ignores adjustments booked in it | `application/statement.service.ts:6-19, 63-92` | FR-013, FR-052, AS-14–AS-17 |
| A6 | `month` regex accepts `2026-13` and `2026-00`, which then fail in SQL with a `500`; no future or pre-2020 check | `api/statements.controller.ts:11, 27, 39` | FR-016, AS-21 |
| A7 | No months list route | (absent) | FR-018, AS-22 |
| A8 | No `@RateLimit` on statement reads; the export policy is the generic `exports.concurrent` | `api/statements.controller.ts:23-24, 34` | FR-019, FR-042, AS-25, AS-68 |
| A9 | `closeMonth` accepts any month (current and future too), ignores order and fact completeness, uses `new Date()` as the implicit cutoff, has no `CLOSING` state, no run record, no persisted cutoff, one transaction for all shops, no resume; the snapshot has no `knowledgeCutoff` or payouts | `application/statement.service.ts:94-130`, `infra/statements.jobs.ts:25-29`, migration `20261001200000-statements-bitemporal.js:34-49` | FR-020–FR-025, AS-28–AS-39 |
| A10 | No admin route to request a close, read a period, list periods or findings | (absent) | FR-026, AS-28, AS-34, AS-75 |
| A11 | Snapshots, adjustments and closed periods are mutable by anyone with write access (no store guard) | migration `…:34-60` | FR-024, AS-37 |
| A12 | Adjustments are unique per `(shopId, refersToMonth, reason)` with `ON CONFLICT DO NOTHING`, so a second change with the same reason text is silently lost; only commission is adjusted (no gross, lines, payouts); no cause kind or reference | migration `…:51-60`, `application/statement.service.ts:154-160` | FR-027, FR-028, AS-42 |
| A13 | Booking month is `new Date()` of the job run, not the booking rule; no check that the target month is open; no late-fact trigger; no trigger from the close; no completeness verification | `application/statement.service.ts:141` | FR-029–FR-031, AS-45–AS-49 |
| A14 | The retro-adjust job recomputes every closed month in the range for the shop or all shops in one unbatched pass with no per-shop isolation and no keyset batches | `application/statement.service.ts:134-163`, `infra/statements.jobs.ts:32-34` | FR-031, AS-43 |
| A15 | `setRate` records history with the database's `now()`, not the injected clock, so the same-instant case yields an empty recorded period; no no-op detection, no change ID, no `recordedBy`, no result body, no `default_rate_gap` guard, no shop existence check, no idempotency key | `application/commission-rate.service.ts:40-73`, `api/statements.controller.ts:43-48` | FR-006–FR-009, AS-01, AS-07, AS-08, AS-10, AS-12 |
| A16 | The retro-adjust job payload carries `reason` but not a change ID; `category` is carried and unused | `application/commission-rate.service.ts:10, 72` | FR-028, AS-40 |
| A17 | `history()` returns an unpaged array filtered to one category (default `*`), ordered without a tiebreaker; no as-of route | `application/commission-rate.service.ts:87-94`, `api/statements.controller.ts:50-53` | FR-010, AS-13 |
| A18 | CSV: every cell is neutralised, so negative numbers become `'-900`; no `rateBps` or `commissionMinor`, no adjustment rows, no `lineId`, order by `createdAt` without a tiebreaker, always live (a closed month's CSV changes after a rate change), no `knownAt` | `infra/statement-export.ts:11-15, 24-44` | FR-038, FR-039, FR-041, AS-61–AS-64, AS-70 |
| A19 | CSV failure semantics: headers are already sent when `pipeline` rejects, so a failed download can look complete; no abort, no metric, no timeout reason | `api/statements.controller.ts:36-44`, `infra/statement-export.ts:46-49` | FR-040, AS-67 |
| A20 | No fact consumers (`order.paid`, `payout.paid`, `ledger.journal_posted`), no inbox, no dead-letter, no watermark or lag; no projector module | (absent) | FR-033–FR-037, AS-51–AS-60 |
| A21 | No reconciliation against ledger facts, no completeness verification job, no findings, no golden dataset | (absent) | FR-043–FR-045, AS-71–AS-75 |
| A22 | No events (`statements.period_closed`, `statements.adjustment_booked`) and no outbox write | (absent) | FR-022, FR-032, AS-28, AS-40 |
| A23 | The close schedule `0 2 2 * *` has no explicit time zone | `infra/statements.jobs.ts:19` | FR-050, AS-29 |
| A24 | No metrics; the only signal is `logger.log` with the free-text reason | `application/statement.service.ts:162` | FR-054, AS-82 |
| A25 | No configuration (batch sizes, margin, concurrency, timeouts, retention) and no startup validation; pool and timeouts are literals | `infra/reporting-pool.ts:21-22` | FR-049, AS-79 |
| A26 | No cooperative stop of the close or the adjustment work on shutdown; export has no 30 s drain | `infra/statements.jobs.ts:25-34` | FR-049, AS-80 |
| A27 | Reporting reads use a private `pg` pool, `ssl: { rejectUnauthorized: false }` in production, 5 connections, 300 s timeout, with no pool arithmetic and no fallback metric | `infra/reporting-pool.ts:17-27` | FR-053, AS-83 |
| A28 | Retention rules are not stated or enforced; no check that buyer identity is absent | (absent) | FR-046, AS-76 |
| A29 | No migration for the new shapes (period `CLOSING`, `knowledgeCutoff`, adjustment cause and deltas, fact tables, inbox, findings) | `migrations/20261001200000-statements-bitemporal.js` | FR-048, AS-78 |
| A30 | The only spec calls services directly (no HTTP, no `supertest`, no problem+json, no `401`, no cross-tenant, no idempotency, no consumers), uses real sleeps instead of a frozen clock, calls `retroAdjust` by hand, and seeds orders and `Shop` through other domains' models | `statements.e2e-spec.ts:10, 43-61, 68-75, 108-122` | VII.2, VII.3; rewrite as the eight e2e files of `test-plan.md` |
| A31 | Layering: there is no `domain/` folder; use cases build SQL; controller does input checks and `new Date()` parsing (II.1 allows only DTO validation and one service call) | `application/*.ts`, `api/statements.controller.ts:28-33, 38-39` | I.1, I.2, II.1 |
| A32 | `index.ts` exports only the two modules; no `CommissionRateQueryService`, no DTO types, no event contracts | `index.ts:6-7` | Provides |

## B. Boundary and structure gaps (constitution I, IV, IX, X)

| # | Gap | Where | Replaced by |
|---|---|---|---|
| B1 | `application/` imports `@nestjs/sequelize`, `sequelize` and runs SQL directly (I.2, III.1) | `application/statement.service.ts:2-3`, `application/commission-rate.service.ts:2-3` | Ports in `domain/`, repositories in `infra/`, use cases only orchestrate and open transactions |
| B2 | `domain/` does not exist; rate resolution, range split, rounding, month assignment, booking rule, state machine are inline SQL | whole domain | Pure `domain/` modules with injected clock (I.3) |
| B3 | Time comes from `new Date()` and the database `now()` (I.3, VII.2 frozen time) | `application/statement.service.ts:89, 103, 141, 146`; `commission-rate.service.ts:62, 76` | Injected clock (S54) |
| B4 | The transaction writes snapshots, period state and no outbox row; the jobs `enqueue` is inside the rate transaction (allowed technical table, IX.6) but the cut between "rate recorded" and "adjustment queued" is the only link | `application/commission-rate.service.ts:72` | `outbox.append` in the same transaction for `statements.adjustment_booked` and `statements.period_closed`; job enqueue keyed by change ID |
| B5 | `StatementsController` pulls `ShopScoped` from `@app/domains/tenancy` and `Firewall`/`Role` from `@app/domains/identity` through entry points (allowed), but the export route takes `@Res()` and writes headers by hand, bypassing the interceptor and filter stages (II.2) | `api/statements.controller.ts:3-4, 36-44` | A streaming response helper in the export lib of this domain that keeps the filter in charge until the first byte and aborts afterwards |
| B6 | `StatementsModule` imports `AuthModule` and exports the services; `StatementsWorkerModule` provides `StatementService` without the module's other providers | `statements.module.ts:9, 12-15`, `statements-worker.module.ts:8-10` | Three modules per Provides (`StatementsModule`, `StatementsWorkerModule`, `StatementsProjectorModule`), exporting only `CommissionRateQueryService` through the entry point |

## C. Cross-domain access and debt rows

**`check:table-ownership` output (run 2026-10-15, T001)**: `statements (6)`: SQL `Product` (catalog), `BisOrder` (orders) and `BisOrderItem` (orders), each in `application/statement.service.ts` and `infra/statement-export.ts`. These are exactly C1 and C2; no row beyond those listed below was found.

`docs/work/architecture/debt-register.md` rows naming `statements` or `S16`: **D-12** (open): "statements reads orders and catalog tables … Reports → ClickHouse via CDC (statements)". D-7 (model imports) names no `statements` file; the only model import in this domain is in its test (see C3). The `check:table-ownership` output could not be produced here (see the note above); the rows below are derived by reading.

| # | Finding (debt) | Where | Mechanism that replaces it |
|---|---|---|---|
| C1 | **D-12, SQL.** `statements` reads `BisOrderItem`, `BisOrder` and `Product` (JOIN) to build every statement and closed-month snapshot | `application/statement.service.ts:44-57` | **R3**: sale facts copied from `order.paid` (S10, with `lineId` and `category` added) into a statements-owned store by a consumer in `StatementsProjectorModule`; pricing joins only owned tables |
| C2 | **D-12, SQL.** The CSV export runs the same three-table join through its own pool | `infra/statement-export.ts:36-44` | **R3**: the export reads the owned fact store and rate tables only |
| C3 | **D-7, MODEL.** The domain's spec imports `ShopModel` from tenancy and creates shops through it; seeds `BisOrder` and inserts `BisOrderItem` by SQL | `statements.e2e-spec.ts:10, 45, 47-60` | Test fixtures: shops from the S03 R1 test double; facts by delivering events to the consumers (no model, no SQL on other domains' tables) |
| C4 | Payout and ledger facts have no path at all (no consumer) although S15 and S14 name this capability as a consumer | (absent) | **R3**: consumers for `payout.paid` and `ledger.journal_posted`; no R1 call to `LedgerService` for monthly sums (per-call, unbatched, and not a point-in-time view) |
| C5 | Shop existence for shop-specific rates is not checked; a typo creates an orphan rate | `application/commission-rate.service.ts:40-73` | **R1** `ShopQueryService.getShopsByIds` (S03), batch of one per request |
| C6 | `docs/work/architecture/domain-map.md` §statements and the S10/S14 contracts still say "ClickHouse via CDC" | `docs/work/architecture/domain-map.md:215-216, 388`; `debt-register.md:25` | Update to "R3 events into a statements-owned store; ClickHouse optional for heavy analytics" in the same PR |
| C7 | S10's `OrderQueryService.getOrderLines` consumer list names S16 | `specs/domains/S10-cart-checkout/spec.md` (Provides, `OrderQueryService`) | Remove S16 from that list (R1 per-order calls cannot price a month) |

## D. Contract dependencies the implementation must see land first

| # | Dependency | Owner | Needed for |
|---|---|---|---|
| D1 | `order.paid` lines gain `lineId` and `category`; a history re-emit command | S10 | AS-51, AS-59 |
| D2 | `ledger.journal_posted` `SALE` journals carry `orderId`, `SHOP_<id>` credits, `PLATFORM_FEES` credit | S14 | AS-57, AS-72–AS-74 |
| D3 | `payout.paid` on `payouts.events` | S15 | AS-56 |
| D4 | Job schedule with a UTC zone and single-run lease; enqueue inside a transaction; consumer harness with inbox, DLQ, watermark/lag read, replay | S49, S53 | AS-29, AS-52–AS-59 |
| D5 | Policies `statements.read`, `statements.export.concurrent`, `statements.admin.read`, `statements.admin.write` in the registry | S50 | AS-25, AS-68 |
| D6 | `ShopScoped`, `ShopQueryService.getShopsByIds`, admin `Firewall` | S03, S01 | AS-09, AS-23 |
| D7 | Web statement tab and its Playwright happy paths | W04 (decision in `questions.md`) | AS-14, AS-18, AS-61 |
| D8 | S14 adoption of `CommissionRateQueryService.getRatesAsOf` for its fee (when it chooses) | S14 | closes expected `fee_mismatch` findings |

## Spec changes

None. No living-spec page for S16 existed when this plan was written (`docs/spec/capabilities/` holds no `S16-*.md`), so nothing a human signed is changed; the first behaviour task creates `docs/spec/capabilities/S16-seller-statements.md` and no `*.reviewed.json` is created or edited.

## Sibling-spec follow-ups

- **S10**: `order.paid` lines must carry `lineId` (stable per order line) and `category` (copied at purchase time), and `shopId` must be non-null for paid lines; add a history re-emit command (D1). Until then statements dead-letters real `order.paid` events as `missing_line_id` (see `research.md` R-1). Also remove S16 from the consumer list of `OrderQueryService.getOrderLines` (C7).
- **S14**: `SALE` journals must carry `orderId`, per-shop `SHOP_<id>` credits and a `PLATFORM_FEES` credit (D2); until they do, reconciliation skips unlinked journals and counts them. Adopt `CommissionRateQueryService.getRatesAsOf` for the fee when ready (D8); `fee_mismatch` findings are expected until then. `ledger.journal_posted` v1 is not consumed.
- **S15**: no change needed: `payout.paid` is consumed as published.
- **S50**: the policy names `statements.read`, `statements.export.concurrent`, `statements.admin.read`, `statements.admin.write` are declared by this domain; once the call sites of other domains stop using `exports.concurrent`, S50 may delete the old name (T048).
- **S53**: the topic `statements.events` is registered in the topic registry by this capability; consumers S28 and J01 adopt `statements.period_closed` and `statements.adjustment_booked`.
- **W04 / J01**: the statements tab, the "as known on" picker and the CSV download journeys (D7) are theirs; the API contract is `contracts/http.md`.

## Plan coverage

Every item above (A1–A32, B1–B6, C1–C7, D1–D8) is mapped to a file or decision in `plan.md` ("Gap-to-plan map") and `research.md`. The implementation must still run `pnpm --dir packages/backend check:table-ownership` first, record its `statements` rows here, and add any row not derived by reading (note at the top of section C).

## Implementation status (2026-10-15)

- **Spec changes (update)**: the living page `docs/spec/capabilities/S16-seller-statements.md` was created by this work (status `draft`); no `*.reviewed.json` exists for S16, so no human sign-off changed. One rule differs from `spec.md`: AS-81's `500 internal_error` is `503 database_timeout` (the platform mapping of SQLSTATE 57014), recorded in `questions.md`. One setting was added: `STATEMENTS_READ_TIMEOUT_MS` (`contracts/config.md`).
- **C (ownership)**: `pnpm check:table-ownership --strict` lists no `statements` row (the rows it prints belong to other domains); `domain/boundaries.spec.ts` pins AS-77 in the suite.
- **Real-application wiring (L-015, L-018)**: `apps/projector` did not load `StatementsProjectorModule` (the domain specs deliver through an in-memory harness and could not see it). It is now exported from `index.ts`, loaded by `apps/projector/src/projector.module.ts` and proven by `apps/projector/src/statements-wiring.e2e-spec.ts`. `core`, `worker` and `projector` each booted alone with `scripts/infra/boot-app.sh`; the worker registers the four statements job types.
- **Policies (T074)**: statements declares only `statements.read`, `statements.export.concurrent`, `statements.admin.read`, `statements.admin.write` in `rate-limit-policies.ts`; `exports.concurrent` stays declared for the other domains that borrow it.
- **Contract migration (T072)**: `migrations/contract/20261016000300-statements-s16-contract.js`, not run (a later deploy step; it refuses while any adjustment lacks a cause identity or a `statements.retro-adjust` job waits). The legacy snapshot/adjustment columns stay because the writers still fill them.
- **D1–D8**: D1/D2 (S10 `lineId`/`category`, S14 `SALE` journal shape) are exercised through the fixtures of `test/fixtures/statements`; the producers' side stays theirs (see the follow-ups above). D3–D6 are used as published. D7 (W04/J01 screens) is in `specs/UNVERIFIED.md`. D8 is S14's choice.
- **Known limits**: AS-78 re-runs the expand migration on a migrated database; it does not seed the pre-S16 table shape. The request-path timeout (`STATEMENTS_READ_TIMEOUT_MS`) covers the live statement query; reads on the replica rely on the platform's replica `statement_timeout`, and close/reconcile/verify rely on the job lease. AS-80's "consumers stop after the current message" is the projection framework's behavior and is not re-proven here.
- **Old spec replaced (T073, L-017)**: `libs/domains/statements/statements.e2e-spec.ts` (SD-41, four tests, no scenario ids) used `StatementService.closeMonth/retroAdjust`, `ReportingPool` and `streamStatementCsv`, which no longer exist. Deleting it failed `check-tests.py integrity` (no ids, and no `statements.ts` subject to delete with it), so the file is rewritten as a two-test journey spec: `S16 AS-16 AS-17 AS-18 AS-40` (closed month never changes, adjustment booked, `knownAt` answers the old truth) and `S16 AS-61 AS-64` (CSV and formula neutralising). Bitemporal history and the exclusion constraint are in `commission-rates.e2e-spec.ts` (AS-02, AS-03, AS-05).

## Gate repairs

- `statements.e2e-spec.ts` was deleted without a scenario id to carry; recreated as a real journey spec with ids. It passes, and `tsc --noEmit` and `check-tests.py integrity` are clean. No product code changed.
