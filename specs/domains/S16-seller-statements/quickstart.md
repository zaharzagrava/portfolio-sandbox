# Quickstart / validation guide: S16 — Seller statements

Run backend commands from `packages/backend`. Test specs run through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]` (condensed output; it prints the path of the full log). Run the narrowest spec that proves a change and the whole capability suite once at the end. Big suites run in batches of fresh processes; a batch without its summary line is a crash, not a flaky test (L-008).

## Prerequisites

- Test stack up (`docker-compose.test.yaml`): Postgres (with `btree_gist`), Redis, Kafka stand-in, ElasticMQ; migrations applied including `…-statements-s16-expand.js`. Every queue and topic the code names is defined (L-002, L-020): topic `statements.events` registered; no new SQS queue is added by this capability.
- Fixtures: `test/fixtures/statements/` (DS-1, RC1, golden dataset + `golden.expected.json`), the S03 shop double, S01 admin/member fixtures, the consumer delivery harness. Tests create their own shops, orders and facts (L-005, L-006); none relies on seeded data.

## Validation scenarios

| # | What it proves | Command | Expected |
|---|---|---|---|
| 1 | Pure logic (AS-04, 07, 34, 47, 49, 55, 64, commission properties) | `test-spec.sh libs/domains/statements/domain` | all unit specs green |
| 2 | Rates (AS-01–13) | `test-spec.sh libs/domains/statements/commission-rates.e2e-spec.ts` | green; history shows 3 beliefs after AS-02 |
| 3 | Reads (AS-14–27) | `…/statement-read.e2e-spec.ts` | green; AS-15 asserts zero fact/rate reads |
| 4 | Close (AS-28–39) | `…/period-close.e2e-spec.ts` | green; crash twin run identical |
| 5 | Adjustments (AS-40–50) | `…/adjustments.e2e-spec.ts` | green; completeness invariant holds |
| 6 | Ingestion (AS-51–60) | `…/fact-ingestion.e2e-spec.ts` | green; replay reproduces answers |
| 7 | CSV (AS-61–70) | `…/statement-export.e2e-spec.ts` | green; truncated download is an error |
| 8 | Reconciliation + golden (AS-71–75) | `…/statement-reconciliation.e2e-spec.ts` | green; output equals `golden.expected.json` |
| 9 | Ops (AS-76–83) | `…/statements-ops.e2e-spec.ts` | green |
| 10 | Whole capability | `test-spec.sh libs/domains/statements` | green once at the end |
| 11 | Static gates | `pnpm tsc --noEmit`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict` (statements rows), `pnpm check:model-registry`, `pnpm check:no-wallclock`, S54 gate (direct `sequelize.transaction` count in the domain = 0), `python3 scripts/livespec/check.py` (from repo root) | all pass |
| 12 | Real apps boot alone (L-015, L-018, L-004) | start `apps/core`, `apps/worker` and `apps/projector` each on its own against the test stack (the repo's boot-check script; do not rely on the monolith) | each reaches ready; worker registers the schedule; projector joins the three groups |
| 13 | Fresh stack (L-012) | `scripts/qa/fresh-run.sh` with the statements suite | green on an empty stack |

## Ops artifacts (criteria no automated test proves)

Each is also a row in `specs/UNVERIFIED.md` with status `not run`; none may be described as verified.

- **SC-004** — close of 100,000 shops with sales in under 5 minutes, batches ≤ 10,000, never half-visible. Run `pnpm tsx scripts/bench/statements-close-100k.ts` against a seeded database in the performance job (the crash/half-visible part is proven by AS-36, the timing is not).
- **SC-005** — closed-month read p99 < 2 s and p95 < 300 ms with 5 years of history. Run a k6 read script against a database seeded with 60 months of snapshots for 100k shops; record the percentiles.
- **SC-007** — live statement shows a sale within 60 s of payment at p95. Measure `order.paid` event time to appearance in the live statement on a staging stack under steady order load; the `statements_ingestion_lag_seconds` histogram is the source.
- **D7 / UI happy paths** — the statements tab, "as known on" picker and CSV download (`packages/web/tests/seller-statements.spec.ts`, J01 step) belong to W04/J01; until they exist the journeys are not run.

Criteria proven automatically: SC-001 (AS-47/AS-75 and `reconciliation.spec.ts`), SC-002 (AS-62), SC-003 (AS-18/19/59), SC-006 (AS-65/66), SC-008 (AS-72–75), SC-009 (AS-77 static gates, AS-51/76), SC-010 (AS-01/AS-40).

## Live-spec check

`python3 scripts/livespec/check.py` must pass with `docs/spec/capabilities/S16-seller-statements.md` present and every `[proof: …]` / `[code: …]` true.
