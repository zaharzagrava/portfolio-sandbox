# Quickstart / validation guide: S17 — Subscriptions (domain `billing`)

Run backend commands from `packages/backend`. Test specs run through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]` (condensed output; it prints the path of the full log). Run the narrowest spec that proves a change and the whole capability suite once at the end. Contracts: [contracts/http.md](contracts/http.md), [contracts/events.md](contracts/events.md), [contracts/jobs.md](contracts/jobs.md); tables: [data-model.md](data-model.md).

## Prerequisites

- Test stack up (`docker-compose.test.yaml`): Postgres, Redis, Kafka stand-in, ElasticMQ; migrations applied including `…-billing-s17-expand.js`. Every queue and topic the code names is defined (L-002, L-020): topics for the four billing events and the three `tenancy.*` topics consumed; the job queues for `billing.run`, `billing.charge-invoice`, `billing.resolve-attempt`, `billing.manual-attempt`. Tables the code needs exist (L-011): `SubscriptionTransition`, `InvoiceTransition`, `SubjectPlanState`.
- Fixtures: `test/fixtures/billing/` (DS-1 prices, FS builder, provider double scripts `pm_ok`, `pm_declined`, `pm_auth`, `pm_timeout`, `pm_late`), S03 shop fixtures and R1 double, S01 admin/buyer fixtures, the consumer delivery harness, the frozen clock. Tests create their own shops, subscriptions and invoices (L-005, L-006); none relies on what ran before.

## Validation scenarios

| # | What it proves | Command | Expected |
|---|---|---|---|
| 1 | Pure logic (AS-21, 30, 43, 63, 64, 70) | `test-spec.sh libs/domains/billing/domain` | all six unit specs green, properties ≥ 1,000 cases |
| 2 | Catalog (AS-01–08) | `…/plans-catalog.e2e-spec.ts` | green; AS-05 privileged statements rejected by the store |
| 3 | Subscribe (AS-09–20) | `…/subscribe.e2e-spec.ts` | green; provider double has 0 calls in AS-09; 50× race has one 201 |
| 4 | State machine, cancel, resume, tenancy events (AS-22–25, 71–77) | `…/subscription-lifecycle.e2e-spec.ts` | green; history chain consistent under 50× |
| 5 | Billing run (AS-26–29, 31–39) | `…/billing-run.e2e-spec.ts` | green; crash twin run identical |
| 6 | Charging and dunning (AS-40–42, 44–58) | `…/invoice-charging.e2e-spec.ts` | green; ≤ 1 create call per attempt key |
| 7 | Change and proration (AS-59–62, 65–69) | `…/subscription-change.e2e-spec.ts` | green; invoice equals preview |
| 8 | Reads and events (AS-78–81) | `…/billing-reads-events.e2e-spec.ts` | green; plan versions consecutive |
| 9 | Ops (AS-82–85) | `…/billing-ops.e2e-spec.ts` | green; migration re-run is a no-op |
| 10 | Whole capability | `test-spec.sh libs/domains/billing` | green once at the end |
| 11 | Static gates | `pnpm tsc --noEmit`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict` (billing rows: 0), `pnpm check:model-registry`, `pnpm check:no-wallclock`, the S54 direct-transaction gate (count for billing stays 0), `python3 scripts/livespec/check.py` | green |
| 12 | Real apps boot alone (L-015, L-018, L-004) | start `apps/core` and `apps/worker` each on its own against the test stack (the repo's boot-check script; do not rely on the monolith) | each reaches ready; the worker registers the `billing.run` schedule once and the three consumers |
| 13 | Fresh stack (L-012) | `scripts/qa/fresh-run.sh` with the billing suite | green on an empty stack |
| 14 | Other importers of billing still compile and pass | `test-spec.sh libs/domains/auctions`, `libs/domains/assistant` (they use `RequiresShopEntitlement`, `UsageService`) | green (A28) |

## Ops artifacts (criteria no automated test proves)

Each is also a row in `specs/UNVERIFIED.md` with status `not run`; none may be described as verified.

- **SC-001** — 10,000 simulated renewals with two concurrent runs, duplicate charge deliveries and random worker crashes: 0 double bills, 0 skipped periods, 0 double charges per attempt. Run `pnpm tsx scripts/bench/billing-run-10k.ts` against a seeded database in the performance job. (The small-scale invariants are proven by AS-28, AS-37, AS-45; the 10,000-run scale is not.)
- **SC-002** — 99% of subscriptions renewed and charge-requested within 15 minutes of period end; `billing_overdue_subscriptions` is 0 outside an incident. Measure in the same bench and on staging from the gauge.
- **SC-007** — subscribe p95 under 1 second; the interaction-time part ("under 2 minutes") is a manual walk-through. Run a k6 script against `POST /shops/:id/subscription` on a staging stack with the provider double, record p95.
- **SC-010 (lock time)** — the migration applies to a populated database without blocking writes longer than the configured `lock_timeout`. AS-84 proves the data conversion and idempotence on a seeded old schema; the write-blocking measurement needs a production-sized database: run the expand migration on a copy with 1M subscriptions and 10M invoices while a write load runs, record the longest blocked write.
- **Provider search consistency (R-4)** — the live Stripe account's search latency after a create is not exercised by the HTTP-edge double. Run once against the Stripe test mode: create a charge, search immediately and after 60 s, record when it appears.
- **J02 API journey step** — the subscribe → charge → `ACTIVE` step belongs to J02 (`packages/backend/test/journeys/seller-to-first-sale.spec.ts`); this capability's e2e proves the pieces, the journey is not edited here.

Criteria proven automatically: SC-003 (AS-59/60/64 and the property specs), SC-004 (AS-42/43/55/56), SC-005 (AS-48–51), SC-006 (AS-18, 57, 69, 74, 80), SC-008 (AS-05, 39 plus recomputation check in AS-61), SC-009 (AS-83).

## Live-spec check

`python3 scripts/livespec/check.py` must pass with `docs/spec/capabilities/S17-subscriptions.md` present (created in the first behavior task, rule 0) and every `[proof: …]` / `[code: …]` true. No `*.reviewed.json` is created or edited.
