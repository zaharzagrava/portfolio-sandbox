# SD-41 — Seller Statements & "As-Of" Reporting (bitemporal)

Status: ☑ done (typechecked; spec written, not run) · Phase 2 · Depends on: SD-20, SD-24, SD-02, SD-29

## Marketplace adaptation
Commission rates per category/shop change over time, sometimes retroactively ("Electronics fee 8% → 7% from March, decided in April"). Sellers and finance ask: "What was my March statement **as we knew it on April 1**?" vs "**corrected** March". Closed months must never silently change.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Bitemporal** `CommissionRate(valid_period tstzrange, recorded_period tstzrange)` + **exclusion constraint** (`EXCLUDE USING gist (shop_id WITH =, category WITH =, valid_period WITH &&) WHERE upper_inf(recorded_period)`) | 10/02 Ex5, 03/03 §7 |
| SCD Type 2 for shop profile / plan history | 03/03 §7 |
| Query as-of: `valid_period @> :d AND recorded_period @> :k` | 03/03 §7 |
| **Period close**: monthly snapshot tables `StatementSnapshot` (materialised totals per shop/month) — reports read snapshots for closed periods, compute live for open | 10/02 Ex5 |
| Late corrections → **adjustment rows** in the current open period referencing the original period | 06/02 §5 |
| Heavy reports from **ClickHouse** (CDC'd ledger/orders) instead of OLTP | 10/02 Ex5 |
| Golden-dataset reconciliation: snapshot totals vs ledger | 06/02 §5 |
| Statement export: streamed CSV (Postgres cursor → `pipeline` → response / S3) with backpressure | 02/02 §4.1 |

## Steps
- [x] Migrations: `btree_gist`, `CommissionRate` bitemporal + exclusion constraint, `StatementSnapshot`, `StatementAdjustment`, `AccountingPeriod(status OPEN/CLOSED)`.
- [x] `CommissionRateService.setRate()` (closes current recorded row, inserts new — never UPDATE history), `rateAsOf(shop, category, validAt, knownAt)`.
- [x] Period close job (SD-29): compute snapshot from ClickHouse, lock period.
- [x] Statement API: `GET /shops/:id/statements/:period?knownAt=` ; streamed CSV export.
- [x] e2e: retroactive rate change → closed March snapshot unchanged, April contains adjustment; as-of query returns old rate for knownAt before change.

## Scale
- Target: 1M shops × monthly statements; reports p99 < 2 s.
- Hot path: statement reads → snapshot table (one row per shop/period) or Redis cache; live open-period numbers → ClickHouse aggregate.
- First bottleneck & fix: month-close computing 1M statements → ClickHouse GROUP BY shop in one pass, bulk insert snapshots in batches of 10k.
- Capacity model: ClickHouse aggregates 1B ledger rows in seconds; snapshot insert 1M rows ≈ minutes, off-peak.
- Proof: benchmark script for period close at 100k shops.

## FE visualisation (phase 2)
Statement page with "as known on" date picker, adjustments highlighted.

## Implementation notes (2026-10-01)
- Migration `20261001200000-statements-bitemporal`: `CommissionRate` (`validPeriod`/`recordedPeriod` tstzranges, **GiST exclusion constraint** on current knowledge, marketplace default row), `AccountingPeriod`, `StatementSnapshot`, `StatementAdjustment` (unique per shop+month+reason).
- `CommissionRateService.setRate`: advisory lock per (shop, category); closes the recorded period of overlapping current rows and re-inserts their uncovered remainders (range math in SQL - `±infinity` safe), then inserts the new row; enqueues `statements.retro-adjust`. `rateAsOf(validAt, knownAt)` prefers shop-specific over default, specific category over `*`. `history()` for audits.
- `StatementService`: one SQL per month with a `CROSS JOIN LATERAL` as-of rate lookup per line; `statement()` = snapshot (closed) / live (open) / as-known-at; `closeMonth` (idempotent, batched `unnest` insert, locks the period); `retroAdjust` (recompute closed months with today's knowledge vs snapshot + prior adjustments → adjustment booked in the open month, idempotent).
- `streamStatementCsv`: `pg-query-stream` server-side cursor → CSV Transform → response via `pipeline` (backpressure, cleanup on disconnect), formula-injection-safe cells, `Content-Disposition: attachment` + `nosniff`; rate-limited by the `exports.concurrent` concurrency policy. `ReportingPool` targets `DB_READ_HOST` (read replica) when set.
- Jobs (worker): `statements.close-month` (2nd of month 02:00), `statements.retro-adjust`. Endpoints: `GET /api/shops/:shopId/statements/:month[?knownAt=]`, `GET .../lines.csv`, admin `POST|GET /api/admin/commission-rates`.
- Spec `statements/statements.e2e-spec.ts`.
