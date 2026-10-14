# Quickstart: validating S11 — Flash sales

Run from `packages/backend` unless noted. Spec runner: `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]` (prints the summary, failing titles and assertion diffs, and the path of the full log). Run the narrowest file that proves a change; the whole capability once at the end. Contracts: [`contracts/http.md`](contracts/http.md), [`contracts/services.md`](contracts/services.md), [`contracts/events.md`](contracts/events.md). Data: [`data-model.md`](data-model.md).

## Prerequisites

- Test stack up (Postgres with real migrations including the two flash migrations, Redis of the production major version with no eviction policy, the outbox and job tables, ElasticMQ for the queues S10 already uses). Compare the stack with the doctor before the first run (L-011): the `FlashSale`, `FlashSaleHistory` and `StockReservation` tables must exist after migrations and Redis must accept `flash:` keys (`redis-cli SET flash:probe 1 PX 1000`).
- `btree_gist` extension present (created by `20261001320000-experiments.js`).
- Env: the new `orders_flash_*` config keys have defaults; the e2e kit freezes the clock and injects a seeded random source for bucket start and `Retry-After`.

## Scenario runs (each file is one `describe`, see [`test-plan.md`](test-plan.md))

| Step | Command | Expected |
|---|---|---|
| 1 pure rules | `pnpm jest libs/domains/orders/domain/flash-` | `flash-bucket-plan`, `flash-sale-state`, `flash-admission`, `flash-drift`, `flash-claim-state` specs green (AS-44–AS-46) |
| 2 scheduling | `test-spec.sh libs/domains/orders/flash-sale-schedule.e2e-spec.ts` | AS-14–AS-19 |
| 3 lifecycle | `test-spec.sh libs/domains/orders/flash-sale-lifecycle.e2e-spec.ts` | AS-20–AS-29, AS-37 |
| 4 reserving | `test-spec.sh libs/domains/orders/flash-sale-checkout.e2e-spec.ts` | AS-01–AS-13 |
| 5 claims | `test-spec.sh libs/domains/orders/flash-sale-claims.e2e-spec.ts` | AS-30–AS-36 |
| 6 public | `test-spec.sh libs/domains/orders/flash-sale-public.e2e-spec.ts` | AS-38–AS-41 |
| 7 observability | `test-spec.sh libs/domains/orders/flash-sale-observability.e2e-spec.ts` | AS-42 |
| 8 S10 regression | `test-spec.sh libs/domains/orders/` (batches of fresh processes, L-008) | all existing S10 specs green; `orders-boundary.e2e-spec.ts` no longer lists `FlashSaleModel` / `FlashStockService` |
| 9 static gates | `pnpm tsc --noEmit -p .`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict` | clean; flash files have 0 findings (AS-43, SC-009); `.tx.baseline` not raised |
| 10 living spec | `python3 scripts/livespec/check.py` (from the repo root) | passes with the new `S11` page and the edited `S10` page |

## Start the real apps (L-004, L-015)

A green jest run does not prove the apps boot. After step 8: start `apps/core` and `apps/worker` and confirm in their logs that `FlashSaleController` routes are mapped (`POST /api/shops/:shopId/flash-sales`, `GET /api/flash-sales`), that `flash-sale.load|end|reconcile|verify|sweep-claims` handlers and the two periodic schedules registered, and that no `UnknownJobTypeError` / `InvalidScheduleError` appears. If the sandbox denies a real start, record it as blocked in `questions.md`, not as passed.

## Manual drill (fresh stack, L-012): `scripts/qa/fresh-run.sh`

1. Create a sale for a seeded product: `POST /api/shops/$SHOP/flash-sales` with `startsAt` = now + 3 min, 100 units; expect `201` + `Location`.
2. Wait for `startsAt − 60 s`: `GET /api/shops/$SHOP/flash-sales/$ID` shows `LOADED`, `stats.unitsRemaining` 100, catalog stock lowered by 100.
3. At `startsAt`: `GET /api/flash-sales/$ID` shows `LIVE`; check out as several buyers; observe `202`, `422 out_of_stock` after 100, `429 flash_sale_busy` when the rate is set low.
4. `redis-cli --scan --pattern 'flash:*'` shows keys only for this sale; after reconcile (set the clock/config so it runs) none remain and catalog stock = original − sold.

## Ops artifacts (success criteria no automated test proves — also in `specs/UNVERIFIED.md`, status `not run`)

- **SC-002** (2,000 simultaneous buyers: 99% of answers < 150 ms, 99% of refusals < 50 ms with no database write): run `scripts/load-tests/flash-sale.test.js` (k6) against a production-like stack after step 8: `k6 run -e BASE_URL=… -e SALE_UNITS=50 -e VUS=2000 scripts/load-tests/flash-sale.test.js`. The updated script creates the sale through the new route, drives the load handler through the job runner, ends with an automatic assertion that `oversold == 0` (orders vs `units`) and prints the percentile checks. Never described as verified until the status in `specs/UNVERIFIED.md` says so.
- SC-001, SC-003, SC-004, SC-005 (the 20-minute bound is asserted as the computed `runAt` of the reconcile job against `endsAt`), SC-006, SC-007, SC-008 and SC-009 are proven by the e2e specs and static gates above (see the mapping in [`plan.md`](plan.md)).
- UI journey `packages/web/e2e/flash-sale.spec.ts` belongs to the web capability; it is not a criterion of this spec.
