# Quickstart: validating S19

Run backend commands from `packages/backend`. Use `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]` for e2e specs (condensed result plus path of the full log).

## Prerequisites

Test stack up (`docker-compose.test.yaml`): Postgres with PostGIS, Elasticsearch, Redis, Kafka stand-in, outbox. Migrations applied (expand, then contract). Verify tables and queues exist with the doctor (L-011, L-002).

## Static gates

1. `pnpm exec tsc --noEmit` (backend, contracts) and ESLint.
2. `pnpm check:boundaries`.
3. `pnpm --dir packages/backend check:table-ownership --strict` — zero pickup findings (AS-44, SC-009).
4. `python3 scripts/livespec/check.py` — the S19 page's `[proof:]` and `[code:]` anchors resolve.

## Narrow proofs (during work)

| Change | Command |
|---|---|
| Pure rules | `pnpm jest libs/domains/fulfilment/domain` |
| Seller points | `scripts/sdd/test-spec.sh fulfilment/pickup-points` |
| Stock | `scripts/sdd/test-spec.sh fulfilment/pickup-stock` |
| Search, browse | `scripts/sdd/test-spec.sh fulfilment/pickup-search` |
| Clusters | `scripts/sdd/test-spec.sh fulfilment/pickup-clusters` |
| Consumers, replay, metrics | `scripts/sdd/test-spec.sh fulfilment/pickup-availability-projector` |

## Whole capability suite (once at the end, batches of fresh processes, L-008)

Run the five e2e files above one process each, plus the unit specs; each batch must print its summary line. Record the green run in the task report (VII.9).

## Real application start (L-015, L-004, L-012)

`scripts/qa/fresh-run.sh` on an empty stack: start `apps/core` and `apps/projector`; the projector logs the index mapping as created or present; then
1. create a point and set stock as a seller (`201`, `200`);
2. after the index catches up, `GET /api/search/near?lat=52.52&lng=13.405&q=…` returns the product;
3. `GET /api/pickup-points/clusters?bbox=…` returns a cell and `Cache-Control: public, s-maxage=30`;
4. `GET /api/pickup-points/near?…&productId=…` returns the point with `quantity`.

## Journey

`packages/web/tests/storefront-discovery.spec.ts` (W02) is run unchanged by W02; it is only re-run here if the response shape change touches its pickup steps (run on an empty stack, 2 workers, `PW_EXPECT_TIMEOUT_MS`, L-006/L-007).

## Ops artifacts (no automated test proves them; rows also in `specs/UNVERIFIED.md`, status `not run`)

| Criterion | How to run it |
|---|---|
| SC-001 p99 < 80 ms at 20 000 rps for search and clusters | k6/vegeta against `/search/near` and `/pickup-points/clusters` on a production-sized index (≥ 1 M documents); read server-side latency histogram `pickup_search_duration_seconds` |
| SC-002 freshness 95 % ≤ 5 s, 99.9 % ≤ 30 s | write a continuous stock stream (≥ 100 changes/s) for 30 min; read `pickup_index_lag_seconds` percentiles |
| SC-006 at most 1 in 1 000 shown offers short after the exact check | replay production-like traffic and compare `checkAvailability` against shown offers over a day |

SC-003, SC-004, SC-005, SC-007, SC-008, SC-009 are proven by AS-21, AS-20, AS-12/AS-18, AS-38/AS-34, AS-31, AS-44.
