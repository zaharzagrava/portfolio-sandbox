# Quickstart: validating S40

Run from `packages/backend`. Use `scripts/sdd/test-spec.sh` (condensed output, prints the full-log path).

## Prerequisites
Test stack with Postgres, Redis, Kafka, ClickHouse; migrations and ClickHouse DDL applied by the migration step (never at app start).

## Validation scenarios

| Goal | Command | Expected |
|---|---|---|
| Pure rules | `scripts/sdd/test-spec.sh libs/domains/seller-insights/domain` | periods, ranking key (incl. property test), percent, conversion, average order value green |
| Read models | `… read-models.e2e-spec.ts` | AS-58–AS-60 |
| Board feed | `… leaderboard-feed.e2e-spec.ts` | AS-01–AS-16 |
| Reads / rank | `… leaderboard-read.e2e-spec.ts` | AS-17–AS-30 |
| Snapshots | `… leaderboard-snapshots.e2e-spec.ts` | AS-09, AS-31–AS-36 |
| Live | `… dashboard-live.e2e-spec.ts` | AS-37–AS-45, AS-49 |
| History and stats | `… dashboard-history.e2e-spec.ts`, `… seller-stats.e2e-spec.ts` | AS-46–AS-57 |
| Observability | `… observability.e2e-spec.ts` | AS-61 |
| Static | `pnpm check:table-ownership --strict`, `pnpm check:boundaries`, `tsc --noEmit`, `python3 scripts/livespec/check.py` | zero `seller-insights` findings |
| Whole capability | `scripts/sdd/test-spec.sh libs/domains/seller-insights` once, at the end | green |

## Ops artifacts (success criteria no automated test proves)

- **SC-002** (boards and counters within 5 s p99, today/stats within 30 s p99): publish a sustained order stream and read feed lag gauges; status not run.
- **SC-003** (live panel changes within 2 s of payment for 99%): drive paid orders with a subscribed client and record the delay; status not run.
- **SC-005** (public top list < 100 ms p99 at 50,000 req/s, cached): k6 against the CDN-fronted route; status not run.

SC-001, SC-004, SC-006, SC-007, SC-008 are proven by AS-12, AS-02/03/41, AS-26/45, AS-22/33, AS-60. SC-009 is proven structurally by AS-62 (no order-table access in the domain) and AS-46.
