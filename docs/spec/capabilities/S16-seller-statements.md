---
id: S16
title: Seller statements - bitemporal commission rates, monthly statements, close, adjustments, CSV, reconciliation
kind: capability
status: draft
generated_at: 9fee9b69
depends_on: [S01, S03, S05, S10, S14, S15, S49, S50, S53, S54]
concepts: [outbox-task-queue, transaction-runner, idempotency-key, rate-limit-policy, job-scheduler-lease, projection-and-replay, problem-json-errors]
models: []
scope:
  - packages/backend/libs/domains/statements/**
  - packages/contracts/src/statements/**
---
# S16 - Seller statements - bitemporal commission rates, monthly statements, close, adjustments, CSV, reconciliation

## Purpose
A seller reads, for any UTC month, what they sold, what commission the platform took and what they keep, as the platform knows it now or as it knew it on any earlier instant. Commission rates keep every belief ever held (valid time and recorded time), a month is frozen exactly once and in order, and knowledge that arrives late becomes an adjustment booked in a later month, never an edit. Sales, payouts and ledger journals reach the domain as events and are copied into tables the domain owns; no query touches orders, catalog, tenancy or ledger tables. See {{concept:projection-and-replay}}, {{concept:transaction-runner}} and {{concept:outbox-task-queue}}.

## Entry points
- `GET /shops/:shopId/statements`, `GET /shops/:shopId/statements/:month`, `GET /shops/:shopId/statements/:month/lines.csv`: a member with `payouts.read` (owner and admin) reads their shop's months, one statement (live, snapshot or `knownAt`) and the CSV. [code: packages/backend/libs/domains/statements/api/statements.controller.ts#StatementsController]
- `POST /admin/commission-rates`, `GET /admin/commission-rates`, `GET /admin/commission-rates/as-of`: the platform admin records and reads rate beliefs. [code: packages/backend/libs/domains/statements/api/commission-rates.controller.ts#CommissionRatesController]
- `GET /admin/accounting-periods`, `GET /admin/accounting-periods/:month`, `POST /admin/accounting-periods/:month/close`, `GET /admin/accounting-periods/:month/findings`: the operator lists periods, requests a close and reads reconciliation findings. [code: packages/backend/libs/domains/statements/api/accounting-periods.controller.ts#AccountingPeriodsController]
- Jobs `statements.close-month` (02:00 UTC on the 2nd), `statements.reconcile-month`, `statements.verify-period`, `statements.verify-periods` (daily 04:00 UTC). [code: packages/backend/libs/domains/statements/infra/statements.jobs.ts#StatementsJobs]
- Consumers of `order.paid`, `payout.paid` (topic `payouts.events`) and `ledger.journal_posted` v2. [code: packages/backend/libs/domains/statements/infra/fact-projectors.ts#statementsProjectors]
- Topic `statements.events`: `statements.period_closed`, `statements.adjustment_booked`. [code: packages/backend/libs/domains/statements/application/period-close.service.ts#PeriodCloseService]
- `CommissionRateQueryService.getRatesAsOf`: the in-process export other domains use to price. [code: packages/backend/libs/domains/statements/application/commission-rate-query.service.ts#CommissionRateQueryService]

## Rules
- **S16.R-01** A rate belief is `(shop or default, category or *, rateBps 0 to 10000, valid period, recorded period)`; a change closes the superseded belief's recorded period and inserts a new row, never rewrites one, with strictly increasing record instants; a lookup picks shop-and-category over shop-wide over category over default, as of any `(validAt, knownAt)`. [proof: S16 AS-02, S16 AS-03, S16 AS-04, S16 AS-07] [code: packages/backend/libs/domains/statements/domain/rate-lookup.ts#lookupRate]
- **S16.R-02** The store refuses two current beliefs with overlapping validity for one shop and category, and concurrent writers cannot create them; the default rate may never develop a gap. [proof: S16 AS-05, S16 AS-06, S16 AS-10] [code: packages/backend/libs/domains/statements/application/commission-rate.service.ts#CommissionRateService]
- **S16.R-03** `POST /admin/commission-rates` is admin only, requires `Idempotency-Key`, answers `201` with the change or `200` for a no-op (no row, no job), refuses each invalid body with its own code, and enqueues one reconciliation keyed by the change; history is keyset paged and an as-of route answers on both axes. [proof: S16 AS-01, S16 AS-08, S16 AS-09, S16 AS-11, S16 AS-12, S16 AS-13]
- **S16.R-04** Commission is `half-up(lineTotalMinor x rateBps / 10000)` per line, in integers, summed; it is between 0 and the line total and monotone in the rate. [proof: S16 AS-43] [code: packages/backend/libs/domains/statements/domain/commission.ts#commissionOf]
- **S16.R-05** Each `order.paid`, `payout.paid` and `ledger.journal_posted` v2 message is validated, applied once (duplicates, replays and reordering change nothing, versions decide), stamped with its event time as `recordedAt`, and stores no buyer identifier; a message that breaks the contract is dead-lettered with a named reason and the next one is processed. [proof: S16 AS-51, S16 AS-52, S16 AS-53, S16 AS-54, S16 AS-56, S16 AS-57, S16 AS-60] [code: packages/backend/libs/domains/statements/application/fact-ingestion.service.ts#FactIngestionService]
- **S16.R-06** A sale belongs to the UTC month of its `paidAt`; the fact store can be rebuilt from the topics alone and gives the same answers; a stream lagging beyond 60 seconds is stated in `dataAsOf` and in a metric. [proof: S16 AS-55, S16 AS-58, S16 AS-59] [code: packages/backend/libs/domains/statements/domain/period.ts#monthBounds]
- **S16.R-07** A statement carries `own`, `adjustmentsBooked`, `adjustmentsReferencing`, `total` and `corrected` (money named `...Minor`), `unpricedLineCount`, `knownAt` and `dataAsOf`; an open month is priced live and states how fresh it is; a closed month is read from its snapshot without touching facts or rates. [proof: S16 AS-14, S16 AS-15, S16 AS-16, S16 AS-17, S16 AS-19] [code: packages/backend/libs/domains/statements/domain/statement-view.ts#compose]
- **S16.R-08** `knownAt` is a full instant that is not in the future and applies to both axes (rates recorded and facts known by then); a month outside `2020-01` to the current month is refused; the months list is keyset paged. [proof: S16 AS-18, S16 AS-20, S16 AS-21, S16 AS-22]
- **S16.R-09** Statement routes require `payouts.read` (viewer and staff are refused, a non-member sees exactly what an unknown shop sees), are limited to 120 reads a minute per user and fail open, and never change a row, cache entry, outbox row or job; a line no rate prices is counted and shown, never dropped. [proof: S16 AS-23, S16 AS-24, S16 AS-25, S16 AS-26, S16 AS-27]
- **S16.R-10** A month moves only `OPEN -> CLOSING -> CLOSED` (or `CLOSING -> OPEN` on failure) and only after it ended plus the margin, in order, and when every stream's watermark has passed its end; snapshots are written in bounded batches under one persisted `knowledgeCutoff`, are visible only when the period is `CLOSED`, and one `period_closed` event is appended in the finalising transaction. [proof: S16 AS-28, S16 AS-29, S16 AS-30, S16 AS-31, S16 AS-32, S16 AS-33, S16 AS-34, S16 AS-35] [code: packages/backend/libs/domains/statements/application/period-close.service.ts#PeriodCloseService]
- **S16.R-11** A close that stops between batches (crash or shutdown) leaves the month `CLOSING`; the resumed run keeps the cutoff and gives the figures of an uninterrupted run; a month with unpriced lines fails the close, publishes nothing and returns to `OPEN`; 25 shops in batches of 10 close completely. [proof: S16 AS-36, S16 AS-38, S16 AS-39, S16 AS-80]
- **S16.R-12** Snapshots, adjustments and closed periods cannot be updated or deleted, even by a privileged session: the store rejects it. [proof: S16 AS-37]
- **S16.R-13** Knowledge that changes a closed month (a retroactive rate, a late sale, a late payout) is booked once per `(shop, month, causeKind, causeRef)` as an adjustment in the earliest open month after it, with the residual against the snapshot plus earlier adjustments; one shop's failure is isolated and retried; `frozen + adjustments` always equals a fresh recomputation. [proof: S16 AS-40, S16 AS-41, S16 AS-42, S16 AS-43, S16 AS-44, S16 AS-45, S16 AS-46, S16 AS-47, S16 AS-48, S16 AS-49, S16 AS-50] [code: packages/backend/libs/domains/statements/application/adjustment.service.ts#AdjustmentService]
- **S16.R-14** The CSV streams `rowType, orderId, lineId, paidAt, productId, category, quantity, unitPriceMinor, lineTotalMinor, rateBps, commissionMinor, refersToMonth, bookedMonth, cause` in `paidAt, orderId, lineId` order from a cursor in bounded batches, reproduces the statement (a closed month is byte-identical after a rate change), neutralises text cells that start a formula but keeps integers numeric, and aborts the response when it fails after the first byte so a truncated file cannot look complete. [proof: S16 AS-61, S16 AS-62, S16 AS-63, S16 AS-64, S16 AS-65, S16 AS-66, S16 AS-67, S16 AS-69, S16 AS-70] [code: packages/backend/libs/domains/statements/domain/csv.ts#csvText]
- **S16.R-15** At most two exports run per shop at once; the third is `429` and a limiter outage refuses the export with `503` before any byte. [proof: S16 AS-68]
- **S16.R-16** A daily verification compares each closed month with the ledger facts and with itself, upserts a finding per `(month, kind, shop)`, clears it when the figures agree, and is read by the operator keyset paged; `missing_in_ledger` waits a grace period of 24 hours. [proof: S16 AS-71, S16 AS-72, S16 AS-73, S16 AS-74, S16 AS-75] [code: packages/backend/libs/domains/statements/application/verification.service.ts#VerificationService]
- **S16.R-17** Statements are financial records: kept at least 10 years, never deleted by shop or user deletion, no deletion route, and no buyer identifier in any owned table, fact or CSV column. [proof: S16 AS-76]
- **S16.R-18** The domain reads and writes only tables it owns, holds no foreign key and no model of another domain, imports other domains only through their entry point, and reaches shops only through `ShopQueryService`. [proof: S16 AS-77] [code: packages/backend/libs/domains/statements/infra/shop-directory.adapter.ts#TenancyShopDirectoryAdapter]
- **S16.R-19** The expand migration is idempotent, keeps legacy columns and old readers working, and changes no closed month; running it again changes nothing. [proof: S16 AS-78]
- **S16.R-20** Settings are validated at startup and a bad value fails naming the setting, never its value. [proof: S16 AS-79] [code: packages/backend/libs/domains/statements/domain/config.ts#loadStatementsConfig]
- **S16.R-21** On the stop signal a close finishes the current batch and stops resumable, and an export in flight gets the drain time and is then aborted like any failed export. [proof: S16 AS-80] [code: packages/backend/libs/domains/statements/infra/statements-lifecycle.ts#StatementsLifecycle]
- **S16.R-22** A statement that outlives the database timeout fails the request as `503 database_timeout` (the platform mapping of SQLSTATE 57014) with a generic detail (no SQL) and releases its connection. [proof: S16 AS-81]
- **S16.R-23** Each outcome moves its metric by the stated amount, with closed-set labels, and logs carry ids, codes and amounts only: no CSV content, request body or buyer identifier. [proof: S16 AS-82] [code: packages/backend/libs/domains/statements/domain/metrics.ts#rateChangesCounter]
- **S16.R-24** Reads of closed months and exports run on the reporting replica; when it is unreachable a read falls back to the primary once, with a metric. [proof: S16 AS-83] [code: packages/backend/libs/domains/statements/infra/replica-reads.ts#ReplicaReads]

## Behaviors
- **S16.B-01** Given shop `a` with three March sales of 10000, 20000 and 500 at the default 10%, when the month is read, then gross is 30500, commission 3050, net 27450 over 3 lines. [proof: S16 AS-14]
- **S16.B-02** Given a closed March, when a rate cut is recorded retroactively, then the March statement keeps its frozen figures, one adjustment is booked in April, and the statement `knownAt` before the cut still answers the old truth. [proof: S16 AS-16, S16 AS-40]
- **S16.B-03** Given a close killed after two batches, when it resumes, then the month becomes `CLOSED` with the figures of an uninterrupted run. [proof: S16 AS-36]
- **S16.B-04** Given a sale that was paid in March but applied after the close, when it arrives, then an adjustment for March is booked once, in the next open month. [proof: S16 AS-45]
- **S16.B-05** Given a negative adjustment of -900, when the CSV is downloaded, then the cell reads `-900`, not `'-900`. [proof: S16 AS-64]
- **S16.B-06** Given a privileged `UPDATE` of a snapshot, then the store rejects it. [proof: S16 AS-37]

## Owns
- Tables: `CommissionRate`, `AccountingPeriod`, `StatementSnapshot`, `StatementAdjustment`, `StatementSaleFact`, `StatementPayoutFact`, `StatementLedgerFact`, `StatementLedgerCredit`, `StatementStreamWatermark`, `StatementPeriodRun`, `StatementPeriodHistory`, `StatementFinding`.
- Events: `statements.period_closed`, `statements.adjustment_booked` on topic `statements.events`.
- Jobs: `statements.close-month`, `statements.reconcile-month`, `statements.verify-period`, `statements.verify-periods`; the legacy `statements.retro-adjust` is mapped onto `statements.reconcile-month` until the contract step.
- Configuration: `STATEMENTS_SNAPSHOT_BATCH`, `STATEMENTS_ADJUSTMENT_SHOP_BATCH`, `STATEMENTS_EXPORT_BATCH`, `STATEMENTS_CLOSE_MARGIN_MIN`, `STATEMENTS_EXPORT_CONCURRENCY`, `STATEMENTS_EXPORT_TIMEOUT_MS`, `STATEMENTS_READ_TIMEOUT_MS`, `STATEMENTS_JOB_TIMEOUT_MS`, `STATEMENTS_CLOSE_SCHEDULE`, `STATEMENTS_CLOSE_SCHEDULE_TZ`, `STATEMENTS_RETENTION_YEARS`, `STATEMENTS_LEDGER_GRACE_HOURS`, `STATEMENTS_DRAIN_MS`.
- Rate-limit policies: `statements.read`, `statements.export.concurrent`, `statements.admin.read`, `statements.admin.write`.

## Decisions
- Sale lines are copied from `order.paid` into an owned fact table versioned by `orderVersion`, because a statement must give the same answer to `knownAt` after a replay and after a replaced order version; the exact figures live in one store, ClickHouse stays optional for analytics.
- Facts carry `appliedAt` besides `recordedAt`, so a snapshot excludes facts the system had not applied at its cutoff and late facts become adjustments rather than a non-deterministic resume.
- Immutability is enforced by store triggers, not only by the application, because a privileged write must be refused too.
- Refunds are not netted: `order.refunded` has no per-shop allocation yet, so a seller is charged commission on a refunded sale until S10 and S13 emit allocations.

## Retention
Records of this domain are kept for 10 years after the month closes and are never deleted when a shop or user is deleted. No purge is built; a purge would be a separate, signed decision.

## Known gaps
- Not proven by an automated test (listed in `specs/UNVERIFIED.md`, status `not run`): closing 100,000 shops in under 5 minutes (SC-004), closed-month reads p95 under 300 ms with five years of history (SC-005), a live sale visible within 60 seconds at p95 (SC-007).
- The seller statements screen and the CSV download button belong to W04 and J01; the journeys are not run.
- Refunds are ignored (see Decisions); the legacy columns and the old unique key stay until the contract migration, a separate deploy step.
- The migration test re-runs the expand step on a migrated database; the upgrade from the exact old shape is covered by the idempotent column guards, not by a seeded old-shape database.
