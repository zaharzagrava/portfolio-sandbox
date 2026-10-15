# Research: S16 — Seller statements

No `NEEDS CLARIFICATION` remains. Each entry is Decision / Rationale / Alternatives. Findings from reading the code on 2026-10-15 are marked **(found)**.

## R-1 Fact store and ingestion

**Decision.** Statements-owned Postgres tables `StatementSaleFact`, `StatementPayoutFact`, `StatementLedgerFact`, `StatementLedgerCredit`, fed by three `Projector`s (`order-paid`, `payout-paid`, `ledger-journal`) in consumer group family `statements-facts` (S53 framework: validation, upcasting, dead letter, offsets). Each projector applies a batch in one `TransactionRunner.run`: `InboxService.claim(source, eventId)` (duplicate → counted `duplicate`), then a version-guarded write (`orderVersion` / `payoutVersion`; the ledger journal is immutable so `journalId` is unique). Rejected payloads throw `PermanentError` with a reason (`statements_events_rejected_total{stream,reason}`).

**(found) `order.paid` today has no `lineId` and no `category`** (`packages/contracts/src/orders/order-events.ts:29-53`); `shopId` is nullable. D1 has not landed. The consumer defines its own strict statements-side schema (`packages/contracts/src/statements/events.ts#orderPaidFactSchema`) that requires `lineId` and `category`, rejects `shopId: null` lines (reason `missing_shop`) and any currency other than `EUR`. Until S10 lands D1, real `order.paid` events are dead-lettered with reason `missing_line_id` rather than guessed (an index-derived `lineId` or a default category would silently misprice and could not be rebuilt). Tests deliver conforming messages through the harness; the gap is a **Sibling-spec follow-up for S10** in `gaps.md`.

**Versioned rows.** `StatementSaleFact` primary key is `(orderId, lineId, orderVersion)`; the effective line for a knowledge instant `K` is the highest `orderVersion` whose `recordedAt ≤ K` (`DISTINCT ON`). A lower version than the stored one is not inserted (AS-53); a replay with a new `eventId` and the same version conflicts on the primary key and is a `stale`/no-op. This keeps AS-18/19/59 true after a replaced version.

**Columns on facts.** `recordedAt = occurredAt` (FR-035) and `appliedAt = clock.now()` at ingestion (operational; used only for snapshot determinism and late-fact detection). No buyer identifier is read from the payload: the schema picks the listed fields explicitly (it is not passthrough), so any other field, buyer-related or not, is never stored; a test asserts the fact tables have no column that could hold one.

**Alternatives.** ClickHouse via CDC (rejected in questions.md: exact bitemporal pricing needs one store, integers); per-order R1 call to `OrderQueryService.getOrderLines` (cannot price a month, N+1); in-place upsert (loses `knownAt` history).

## R-2 Bitemporal rates

**Decision.** Keep `CommissionRate` (`shopKey` all-zero UUID = default, `validPeriod`, `recordedPeriod`, GiST exclusion `WHERE upper_inf("recordedPeriod")`). Add `changeId UUID`, `recordedBy UUID`, `shopId` semantics stay in `shopKey`. `setRate` runs in one transaction: `pg_advisory_xact_lock(hashtextextended(shopKey||category))` (FR-006); compute `recordedAt = max(clock.now(), lastRecordedFrom(shopKey, category) + 1µs)` in `domain/recorded-instant.ts` (microsecond bigint arithmetic, AS-07); close the recorded period of every overlapping current belief, re-insert the uncovered remainders (left and right) as new current beliefs recorded at `recordedAt`, insert the new belief. No-op test is performed first on the in-force coverage (AS-08): same rate over a range already fully covered by one current belief with the same rate → `200 changed:false`, nothing written, no job, no event. Default `*` guard: after the write the default coverage must still be `(-∞, ∞)`; checked inside the transaction before commit and rolled back as `422 default_rate_gap`.

**(found)** the current code writes `recordedPeriod` with the database `now()` (`commission-rate.service.ts:62`), which makes the same-instant case an empty range; the injected clock plus the +1µs rule fixes it.

**Categories** are trimmed and lower-cased on write and on ingest; `*` is reserved.

**Shop existence** is checked through a domain port `SHOP_DIRECTORY` implemented over `ShopQueryService.getShopsByIds([shopId])` (R1, batch of one); default rates skip the check.

**Idempotency.** `@Idempotent()` from `infrastructure/idempotency` on both POSTs (24 h, `Idempotency-Replayed`).

**Alternatives.** Application-level overlap checks (rejected: III.6); `SERIALIZABLE` retries instead of an advisory lock (rejected: the lock gives the exact "exactly one serial order" of AS-06 with no retries).

## R-3 Pricing query and UTC months

**Decision.** `StatementReader` (infra) builds the month window in TypeScript (`domain/period.ts#monthBounds(month): {start: Date, end: Date}` in UTC) and binds `timestamptz` parameters; no `CAST(:month AS date)` and no session time zone dependence (A3). Shape:

```text
effective facts (DISTINCT ON orderId, lineId, highest orderVersion with recordedAt <= K [and appliedAt <= K for snapshots])
  filtered by shopId, paidAt in [start, end)
LEFT JOIN LATERAL best rate:
  CommissionRate where category in (line.category, '*') and shopKey in (shop, default)
    and validPeriod @> paidAt and recordedPeriod @> K
  order by (shopKey = shop) desc, (category = line.category) desc limit 1
```

Aggregates: `grossMinor = Σ lineTotalMinor`, `commissionMinor = Σ floor((lineTotalMinor × rateBps + 5000) / 10000)` over priced lines (bigint division of non-negative numbers is floor), `lineCount`, `unpricedLineCount = count(rate is null)`. `domain/commission.ts#commissionOf` is authoritative; `commission.spec.ts` includes a fast-check parity case generated against the SQL expression through a tiny e2e probe (`statement-read.e2e-spec.ts`) so the two cannot drift. Index on facts: `(shopId, paidAt, orderId, lineId)`; `appliedAt` is not indexed (late-fact queries go through the period cutoff and `shopId` keyset).

**Alternatives.** Pricing in application code (rejected: moves millions of rows to the app for big shops; the CSV already streams priced rows with `rateBps` from this query).

## R-4 Period close, run record, visibility

**Decision.** States `OPEN`, `CLOSING`, `CLOSED` on `AccountingPeriod` plus `StatementPeriodRun` (`runId`, `month`, `status RUNNING|COMPLETED|FAILED`, `knowledgeCutoff`, `failureCode`, `details`, `batchesWritten`, `shopsWritten`, `startedAt`, `finishedAt`) and `StatementPeriodHistory` (every transition, III.7). Request path (admin or schedule): checks in order `month valid` → `period_closed`/`period_closing` → `period_not_ended` → `previous_period_open` → `period_not_ready` (each watermark ≥ month end + margin, margin default 10 min) → conditional `UPDATE AccountingPeriod SET status='CLOSING', knowledgeCutoff=:now WHERE month=:m AND status='OPEN'` (exactly one concurrent winner → AS-35), run row, `jobs.enqueue('statements.close-month', {month, runId}, {idempotencyKey: 'close:<month>:<runId>'})` in the same transaction. A scheduled run without a month closes the oldest closable month up to the previous UTC month (catch-up oldest first, AS-33).

The job reads the persisted cutoff (not the clock), pages shops with sales (keyset on `shopId`, batch ≤ 10,000, configurable) computing snapshots under `recordedAt ≤ K AND appliedAt ≤ K` and rates `recordedPeriod @> K`, inserts with `ON CONFLICT DO NOTHING`, and checks `jobs` stop signal between batches. A pre-flight count of unpriced lines fails the run `unpriced_lines` (AS-38): staged snapshot rows of this run are deleted (allowed by the trigger while the period is not `CLOSED`), the period returns `OPEN`, a metric moves. Finalisation is one transaction: count snapshots == expected, `CLOSING → CLOSED` conditional update, history row, `outbox.append(statements.period_closed)`, `jobs.enqueue('statements.reconcile-month', {month, cause:'close:<runId>'})`.

**Visibility.** Snapshot rows are read only when the month's period is `CLOSED`; a `CLOSING` month is served live with the same numbers (AS-36). **Immutability** by triggers: `StatementSnapshot` UPDATE always rejected, DELETE rejected when the period is `CLOSED`; `StatementAdjustment` UPDATE/DELETE always rejected; `AccountingPeriod` UPDATE rejected unless `(OPEN→CLOSING | CLOSING→CLOSED | CLOSING→OPEN)`, DELETE always rejected. Resume re-delivers the same job; it re-reads `knowledgeCutoff` and `ON CONFLICT DO NOTHING` makes already-written batches harmless (AS-36 identical result).

**Scheduling.** `jobs.upsertSchedule` with cron `0 2 2 * *`, `timeZone: 'UTC'`, the S14 `upsertLedgerSchedule` pattern (refused schedule logged, not fatal), `maxAttempts` 3 with backoff; a `period_not_ready` outcome re-enqueues with backoff rather than failing (AS-32). Daily `statements.verify-periods` at 04:00 UTC.

## R-5 Adjustments

**Decision.** `AdjustmentService.reconcile(month, cause, shopId?)`: in a transaction per shop, `pg_advisory_xact_lock(hashtextextended(shopId||month))`; read the snapshot, all adjustments referencing `(shop, month)`, and a fresh recomputation with `K = now` (rates by `recordedPeriod @> now`, all facts by `recordedAt ≤ now`, payouts likewise); `residual = fresh − (snapshot.own + Σ deltas)` per measure (`domain/residual.ts`, pure); zero residual books nothing; otherwise insert with unique `(shopId, refersToMonth, causeKind, causeRef)` `ON CONFLICT DO NOTHING`, booking month from `domain/period.ts#bookingMonth(now, periodStates)`, and `outbox.append(statements.adjustment_booked)` in the same transaction (FR-032). Shops: for a shop-specific rate change just that shop; for a default change and for the close follow-up, keyset batches of ≤ 1,000 over snapshot shops; one shop's failure is caught, counted and the shop's cause re-enqueued with backoff, others stay booked (AS-43). Triggers: `setRate` (affected months = months `CLOSING|CLOSED` intersecting the validity range; `affectedClosedMonths` returned), the fact-ingestion service (a fact whose UTC month is `CLOSING|CLOSED` → `reconcile-month {month, cause:'late_sale:<orderId>'|'late_payout:<payoutId>', shopId}`), and the close completion. Enqueue is inside the writer's transaction with an idempotency key `<cause>:<month>[:<shopId>]`.

**Legacy job.** `statements.retro-adjust` stays declared for in-flight rows; its handler maps `{shopKey, from, to, reason}` to `reconcile-month` with cause `rate_change:legacy:<reason>`. Removed in the contract migration task after the queue drains.

## R-6 Statement composition

`own` = live aggregate (open/`CLOSING`/as-known-at) or snapshot (closed). `adjustmentsReferencing` = adjustments with `refersToMonth = month` (filtered `createdAt ≤ K` for `knownAt`); `adjustmentsBooked` = `bookedMonth = month`. `total = own + Σ booked`, `corrected = own + Σ referencing`. For `knownAt` requests the live path is used with `K = knownAt` for closed months too (`source: as_known_at`), adjustments filtered by `createdAt ≤ K`. `dataAsOf` = min over the three watermarks for live/open; `null` for snapshots. `knownAt` response field = clock for live, cutoff for snapshot, the parameter otherwise. `knownAt` parsing: strict `z.string().datetime({offset:true})`; future → `422 known_at_in_future` (compared with the injected clock); month bounds `2020-01 ≤ month ≤ current UTC month`. The months list unions snapshot months (CLOSED) and open/closing months (rows in `AccountingPeriod` plus the current month), keyset on `month desc`.

## R-7 CSV export

`StreamingResponse` (infra) lets the exception filter handle everything before the first byte; after it, any failure calls `res.destroy(err)` so the client sees a truncated, errored transfer; metric `statements_export_aborted_total{reason}` (`db_error`, `timeout`, `shutdown`). The cursor is `pg-cursor` style via the replica handle inside a read-only transaction with `SET LOCAL statement_timeout`, 1,000 rows per fetch, `pipeline` with an async generator so back-pressure pauses the fetch; `res.on('close')` cancels the cursor and releases the connection. Closed months are priced at the snapshot cutoff (`K = knowledgeCutoff`, `appliedAt ≤ K`), so the file is byte-identical across later rate changes; adjustment rows booked in the month follow the sale rows ordered `bookedAt, id`. `domain/csv.ts`: text cells neutralised and quoted; integer columns bare; `null` empty. Policy `statements.export.concurrent` is `fail closed`. Shutdown: the lifecycle registry waits up to 30 s for active exports and then destroys them.

## R-8 Reconciliation and findings

`StatementFinding` unique `(month, kind, coalesce(shopId, zero-uuid))`; upsert opens, a later agreeing run sets `CLEARED`. Checks (all against owned tables): (a) per shop net vs Σ `StatementLedgerCredit` for `SHOP_<id>` of `SALE` journals whose `orderId` has a sale fact in the month; (b) platform-fee total vs `PLATFORM_FEES` credits (`fee_mismatch` is expected while S14 uses the flat fee); (c) `missing_in_ledger` (sale with no journal 24 h after the close) and `missing_in_statement` (journal whose order has no fact); (d) `completeness_violation` from the FR-029 recomputation over closed months of the last 90 days. No snapshot is ever written by these jobs.

## R-9 External dependencies and sequencing

| Dependency | State on 2026-10-15 | Handling |
|---|---|---|
| D1 `lineId`/`category` on `order.paid` (S10) | **Not landed (found)** | Own strict schema; dead-letter `missing_line_id`; sibling bullet for S10 |
| D2 ledger `SALE` journals carry `orderId`, `SHOP_<id>` credits, `PLATFORM_FEES` | Contract v2 has optional `orderId` (found) | Reconciliation skips journals without `orderId` (counted `unlinked`); sibling bullet for S14 |
| D3 `payout.paid` | Landed (`payout-events.ts`) | Import `payoutPaidSchema` |
| D4 jobs/outbox/inbox/projections | Landed in `infrastructure/` | Use as-is |
| D5 policies | Declared here (S50 pattern `definePolicies`) | Add four names |
| D6 `ShopScoped`, `ShopQueryService` | Landed (`@app/domains/tenancy`) | Use |
| D7 web tab + Playwright | W04 | Out of this plan; UNVERIFIED row |
| D8 S14 adoption of `getRatesAsOf` | S14's choice | Provide the service; sibling bullet |

## R-10 Living specification

No page `docs/spec/capabilities/S16-seller-statements.md` exists (**found**: only S01–S15 etc.). The first behaviour task creates it (front matter like S15, `scope` = the domain and `packages/contracts/src/statements/**`), writes the rules and behaviours, and keeps every `[proof: …]` and `[code: …]` true (`python3 scripts/livespec/check.py`). No `*.reviewed.json` is created or edited, and nothing human-signed is changed (no page existed), so `## Spec changes` records "none".

## R-11 Configuration

`domain/config.ts` zod schema read from environment (`STATEMENTS_*`), validated at module init (fails naming the key): snapshot batch size 1–10,000 (default 10,000), adjustment shop batch 1–1,000 (1,000), export batch 1–5,000 (1,000), close margin ≥ 0 min (10), export concurrency ≥ 1 (2), export timeout ≥ 1 s (120 s), close schedule cron + zone (`0 2 2 * *` UTC), retention ≥ 10 years (10), reconciliation grace hours (24), db statement timeout (30 s). See `contracts/config.md`.
