# Quickstart: validating S31

Run from `packages/backend`. Backend e2e specs go through `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>`; the full list of scenarios and their files is in [test-plan.md](test-plan.md), shapes in [contracts/interfaces.md](contracts/interfaces.md), tables in [data-model.md](data-model.md).

## Prerequisites

Test stack up (Postgres, Redis, MinIO, ElasticMQ), migrations applied (`pnpm migrate`), the config keys of `contracts/interfaces.md` at their defaults (tests lower the quota and use test chunking 4/16/64 KiB).

## Per-area checks (narrowest first)

| Area | Command |
|---|---|
| Pure rules | `test-spec.sh libs/domains/asset-library/domain` |
| Upload, quota, idempotency | `test-spec.sh asset-upload` |
| Access and isolation | `test-spec.sh asset-access` |
| Sync, journal, manifest | `test-spec.sh asset-sync` |
| Versions, delete, cleanup | `test-spec.sh asset-lifecycle` |
| Share and delivery | `test-spec.sh asset-share` |
| Digital delivery and events | `test-spec.sh digital-delivery` and `digital-events` |
| Operations and jobs | `test-spec.sh asset-operations` |
| Whole capability (once, at the end) | `test-spec.sh libs/domains/asset-library` |

## Static gates

`pnpm exec tsc --noEmit`, ESLint, `pnpm check:boundaries`, `pnpm check:table-ownership --strict` (zero `asset-library` lines), `pnpm check:model-registry`, `pnpm check:module-graph`, `pnpm check:asset-library-no-fk`, `pnpm check:no-wallclock`, `python3 scripts/livespec/check.py`.

## Ops artifacts (criteria no automated test proves; also rows in `specs/UNVERIFIED.md`, status "not run")

- **SC-001 at 1 GiB**: tests prove the delta on a 1 MiB file; run a sync of a real 1 GiB random file with production chunk parameters, edit the middle, count uploaded chunks (≤ 3) and compare checksums.
- **SC-003 at 100 clicks**: tests use 10 concurrent redeems; run 100 concurrent redeems of a link capped at N against a deployed stack and count `200` answers.
- **SC-004 p99 30 s**: no test measures percentile lag; run the paid/refunded flow under load and read the event-to-entitlement lag histogram.
- **SC-006 25 h**: tests move the clock; observe in a deployed environment that unreferenced objects disappear between 24 h and 25 h.
- **SC-008 50 GiB memory**: tests stream megabytes; upload and download a 50 GiB file and watch the app process memory stay flat.
