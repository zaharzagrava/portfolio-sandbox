# Questions and decisions: S16 — Seller statements

Decisions taken unattended under the decision policy (production-grade, notes and constitution first). BREAKING first, then CONTRACT, then LOCAL. Format: `question → default → why`.

## BREAKING

- [BREAKING] Statement computed from `BisOrder`/`BisOrderItem`/`Product` by raw SQL (`statement.service.ts:46-64`, `statement-export.ts:36-44`) → sale lines are copied from `order.paid` events into a statements-owned store and priced there; no query touches orders or catalog → IX.4 / debt D-12, IX.7 R3.
- [BREAKING] Statement month assigned by `BisOrder.createdAt` and status list `PAID/FULFILLING/SHIPPED/DELIVERED` → month of the event's `paidAt` (UTC), every `order.paid` line counts → a sale is a commission event when it is paid, not when the cart was created; the status list is S10's concern.
- [BREAKING] Response fields `gross/commission/net/lines`, `source: 'as-known-at'`, `adjustments[]` with `commissionDelta` → `grossMinor/commissionMinor/netMinor/lineCount`, `source: 'as_known_at'`, `own/adjustmentsBooked/adjustmentsReferencing/total/corrected`, `currency`, `knownAt`, `dataAsOf`, `unpricedLineCount`; contracts schemas → III.8 money naming, V.2 schemas, and the open month today ignores adjustments booked in it (`statement.service.ts:70-92`).
- [BREAKING] `knownAt` today only re-prices current facts and returns no adjustments (`statement.service.ts:77-80`) → it applies to both axes (rates recorded ≤ K and facts whose event time ≤ K), must be a full ISO instant, never in the future (`422 known_at_in_future`) → 03/03 §7 "as we knew it on April 1".
- [BREAKING] Lines with no resolving rate vanish from the statement (inner `CROSS JOIN LATERAL`, `statement.service.ts:50-57`) → counted, shown as `unpricedLineCount`, and they block the close (`unpriced_lines`); the default rate may never develop a gap (`422 default_rate_gap`) → a money statement must never silently drop a sale.
- [BREAKING] Month path accepts `2026-13` (regex `^\d{4}-\d{2}$`) and then fails in SQL with a 500 (`statements.controller.ts:11, 27`) → strict `YYYY-MM`, `2020-01` to current month, `400 validation_failed` / `422 month_not_available`.
- [BREAKING] `closeMonth` accepts any month, including current and future (`statements.jobs.ts:25-29`, `statement.service.ts:105-134`) → only ended months, in order, with complete facts (watermarks), as `OPEN → CLOSING → CLOSED`, with a persisted `knowledgeCutoff`, batches of at most 10,000, a resumable run → closed numbers must be provably complete; today a crash or an early run freezes a wrong month.
- [BREAKING] Adjustments unique per `(shopId, refersToMonth, reason)` with `ON CONFLICT DO NOTHING` (`20261001200000…js:59`, `statement.service.ts:156-160`): a second change with the same reason text is silently dropped → unique per `(shop, month, causeKind, causeRef)` with the change ID as the cause; the amount is the residual against snapshot plus earlier adjustments; deltas for gross, commission, lines and payouts → AS-42, completeness invariant.
- [BREAKING] `POST /admin/commission-rates` answers `204`, takes no idempotency key, accepts any `shopId` → `201`/`200` with a result body, `Idempotency-Key` required, shop existence checked through S03 R1, `default_rate_gap` guard, no-op detection → V.6 for a financial write, auditability.
- [BREAKING] `GET /admin/commission-rates` defaults `category='*'` and returns an unpaged array (`statements.controller.ts:50-53`) → keyset-paged, optional filters, adds `changeId`, `recordedBy`, plus new `as-of` route → III.10.
- [BREAKING] CSV cells all go through the formula neutraliser, so negative numbers become `'-900` (`statement-export.ts:11-15`) and rows carry no rate or commission → integer columns stay numeric, text cells neutralised, rows carry `rateBps` and `commissionMinor`, adjustments appear as rows, closed months are priced at the snapshot cutoff, order is deterministic (`paidAt, orderId, lineId`) → the export must reproduce the statement.
- [BREAKING] Export failure handling: headers are sent and `pipeline` errors end the response as if complete → abort the response so a truncated file cannot look complete; `exports.concurrent` becomes `statements.export.concurrent` 2 per shop, fail closed → protects the database.
- [BREAKING] `ReportingPool` opens its own `pg` pool with `ssl: { rejectUnauthorized: false }` in production (`reporting-pool.ts:23-25`) → reads use the platform's replica handle (S54) with verified TLS; no private pool → security, III.12 pool arithmetic.
- [BREAKING] `StatementService` (application) and `CommissionRateService` run SQL through `@InjectConnection()`; `domain/` and `infra/` do not exist → ports and repositories in `infra/`, pure rate/month/rounding/state logic in `domain/` → I.1, I.2, III.1.
- [BREAKING] Closed-month snapshots hold `gross/commission/net/lines/computedAt` only and the period has `OPEN|CLOSED` → add `knowledgeCutoff`, `ownTotals` and adjustment totals, `payoutsPaidMinor`, `CLOSING` state, run record, `runId`; store-level immutability for snapshots, adjustments and closed periods → expand/contract migration (III.11), AS-37, AS-78.
- [BREAKING] The close job's schedule is `0 2 2 * *` in the server's zone (`statements.jobs.ts:19`) → 02:00 UTC explicitly → VIII.6 determinism.

## CONTRACT

- [CONTRACT] `order.paid` lines lack `lineId` and `category` → S10 adds both (category copied at purchase time, stable `lineId` per order line) and provides a history re-emit for first load and rebuild → rates are per category and the line is the unit of pricing; IX.8 copies, not references; the alternative (a catalog read model keyed by product) would re-price old orders when a product is recategorised. Affects S10 (S10's contract lists `lines` without these fields).
- [CONTRACT] S10's contract also lists S16 as a consumer of `OrderQueryService.getOrderLines` (R1) → not used: the domain map says order facts arrive by R3 and R1 per-order calls cannot price a month; S10 should drop S16 from that consumer list.
- [CONTRACT] The domain map and S10/S14 say statements read "via ClickHouse (CDC)" → this capability consumes the Kafka events (R3 projector) into a statements-owned store, not CDC and not ClickHouse for the exact figures; ClickHouse stays optional for heavy analytics (S40) → as-of pricing joins each line with a bitemporal rate table, which needs one store and exact integers; IX.7 R3 allows "a table owned by A". `domain-map.md` §statements and `check` docs must be updated.
- [CONTRACT] S14 charges a flat 50 minor units per payment "until S16 introduces commission rates" → S16 provides `CommissionRateQueryService.getRatesAsOf` (R1); S14 decides when to adopt it; until then `fee_mismatch` findings are expected and informational → keeps S14's journals authoritative while making the gap visible.
- [CONTRACT] `ledger.journal_posted` for sales must carry `orderId`, per-shop `SHOP_<id>` credits and a `PLATFORM_FEES` credit, kind `SALE` → needed for reconciliation findings; if S14 changes the kind name, S16's consumer must follow.
- [CONTRACT] Refunds: `order.refunded` has no per-shop allocation, so statements ignore refunds in this version → a refund line type needs S10/S13 to emit `{shopId, lineId, amountMinor}` allocations; until then sellers are charged commission on refunded sales, documented as a known limit.
- [CONTRACT] Statement permission: `payouts.read` (owner and admin) for statement, list and CSV, not `shop.export` → statements are finance data; S03's `shop.export` is for catalog/order exports. S03 keeps its matrix.
- [CONTRACT] The seller screen (statement page with an "as known on" date picker and CSV download) is in no W spec → default: web capability W04 (seller dashboard) adds a "Statements" tab; the UI journey in `test-plan.md` is owned there and by J01 → one surface per capability.
- [CONTRACT] Finance retention rules that S10, S14 and S15 defer to S16: 10 years after the month closes, never deleted on shop or user deletion, no buyer identifier stored → single rule stated in Provides.
- [CONTRACT] Events `statements.period_closed` and `statements.adjustment_booked` on `statements.events` (S28 optional consumer) → sellers learn of corrections without polling; no per-shop "statement ready" event (1M shops) — S28 derives it from `adjustment_booked` and `period_closed`.

## LOCAL

- [LOCAL] Commission rounding → half up per line, summed (not per order) → rates differ per category, lines are the unit; matches today's `round()`.
- [LOCAL] Where the booking month falls when the calendar month is not open → earliest open month after it → deterministic, no lost adjustment.
- [LOCAL] Adjustment amount for overlapping causes → residual against snapshot plus all earlier adjustments, attributed to the triggering cause → keeps the completeness invariant without per-cause bookkeeping.
- [LOCAL] Fact recorded time → the event's `occurredAt`, not ingestion time → makes rebuild by replay reproduce as-known-at answers.
- [LOCAL] Late fact detection → a fact with event time ≤ cutoff applied after the close triggers `statements.reconcile-month` → covers an outage of the consumers.
- [LOCAL] Close safety margin 10 min past month end plus the 2nd 02:00 UTC schedule → more than a day for late events.
- [LOCAL] Batch sizes → snapshot insert 10,000, adjustment work 1,000 shops, export cursor 1,000 rows → from SD-41 scale notes and the existing export.
- [LOCAL] Statement months list scope → months with a snapshot plus open months (not every month since launch) → keeps the list short.
- [LOCAL] Replica reads → closed months and exports on the replica, live data states `dataAsOf`, one fallback to primary → III.12.
- [LOCAL] Findings are upserted per (month, kind, shop) and cleared automatically; no manual acknowledge in this version → smallest workable review loop.
- [LOCAL] Reconciliation grace 24 h for `missing_in_ledger` → ledger settlement is asynchronous (S14).
- [LOCAL] Rate categories are trimmed and lower-cased on write and on ingest; `*` is reserved for "any" → one comparison rule.
- [LOCAL] First supported month `2020-01` → bounds validation.
- [LOCAL] Statement store engine and partitioning (month-partitioned facts) → decided in `plan.md` with pool arithmetic (III.12).
