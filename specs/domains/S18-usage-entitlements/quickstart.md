# Quickstart: validating S18

Run backend commands from `packages/backend`. Test runs go through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path> [jest args]` (condensed output, path of the full log).

| # | Step | Command | Expected |
|---|---|---|---|
| 1 | Live spec page | `python3 scripts/livespec/check.py` (repo root), page `docs/spec/capabilities/S18-usage-entitlements.md` | passes; no `*.reviewed.json` touched |
| 2 | Pure domain | `test-spec.sh libs/domains/billing/domain` | `entitlements`, `usage-overage`, `usage-adjustment` green (AS-03–05, 07, 25, 33–36, 39–41; SC-002 property) |
| 3 | Entitlements | `test-spec.sh libs/domains/billing/entitlements.e2e-spec.ts` | AS-01, 02, 06, 08–11 |
| 4 | Cache | `test-spec.sh libs/domains/billing/entitlements-cache.e2e-spec.ts` | AS-12–21, SC-005 |
| 5 | Ingestion | `test-spec.sh libs/domains/billing/usage-ingestion.e2e-spec.ts` | AS-22–31, SC-001 (10,000 randomized events) |
| 6 | Lines, settlement, reconcile | `test-spec.sh libs/domains/billing/usage-invoice-lines.e2e-spec.ts` | AS-32, 37, 38, 42–47, SC-003, SC-008 |
| 7 | Migration | `test-spec.sh libs/domains/billing/usage-migration.e2e-spec.ts` | AS-48 |
| 8 | Read API | `test-spec.sh libs/domains/billing/usage-read.e2e-spec.ts` | AS-49–55, SC-007 |
| 9 | Observability | `test-spec.sh libs/domains/billing/billing-observability.e2e-spec.ts` | AS-57 |
| 10 | Whole capability (once, at the end) | `test-spec.sh libs/domains/billing` | green |
| 11 | Other importers | `test-spec.sh libs/domains/auctions`, `libs/domains/assistant`, `libs/domains/developer-platform` | green (`RequiresShopEntitlement`, `checkQuota` users; auctions AS-03 keeps `entitlement_required {feature}`) |
| 12 | Static gates (AS-56) | `pnpm tsc --noEmit`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, `pnpm check:no-wallclock`, the S54 direct-transaction count for billing | billing rows 0; `UsageSettlement` registered |
| 13 | Real apps boot alone (L-015, L-018, L-004) | start `apps/core`, `apps/worker`, `apps/projector` each on its own against the test stack | each reaches ready; the three consumers subscribe |
| 14 | Fresh stack (L-012) | `scripts/qa/fresh-run.sh` with the billing suite | green on an empty stack |

## Ops artifacts (criteria no automated test proves)

Each is also a row in `specs/UNVERIFIED.md` with status `not run`; none may be described as verified.

- **SC-004** — a usage event is visible to the usage read within 30 s of publication in 99% of cases. AS-55 proves one event at `T + 30 s`; the 99th percentile under load needs a staging run: publish 1,000 `usage.recorded` events at a steady rate and poll `GET /shops/:id/usage`.
- **SC-006** — 99% of cached checks under 20 ms, and 100% fail closed with cache and subscription source both down. The e2e proves the fail-closed result (AS-11, AS-19, AS-20), not the latency percentile. Run a k6 script against a guarded route on a staging stack, then stop Redis and the basis source.
- **SC-009 (lock time)** — the migration applies to a populated database without blocking writes longer than `lock_timeout`. AS-48 proves the data conversion and idempotence on a seeded schema; the lock behavior needs a copy of production-size data with concurrent writers.

Proven automatically: SC-001 (AS-23/24/31 plus a randomized ingestion test), SC-002 (property in `usage-adjustment.spec.ts` and AS-43), SC-003 (AS-42), SC-005 (AS-14/16/17), SC-007 (AS-51/52), SC-008 (AS-47).
