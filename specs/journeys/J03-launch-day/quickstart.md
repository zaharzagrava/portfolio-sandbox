# Quickstart: J03 — validation guide

Contracts: [contracts/journey-kit.md](contracts/journey-kit.md). Data: [data-model.md](data-model.md). Research: [research.md](research.md).

## Prerequisites

```bash
moon run infra-setup                 # stores, schemas, topics, ElasticMQ queues (orders-booking-voucher-requested included)
# queue change? scripts/infra/reload-queues.sh, then wait for /health/ready (L-020)
export JOURNEY_ENV=packages/backend/.env
# local profile (refused in production): CLOCK_CONTROL=enabled PROVIDER_DOUBLES=enabled, bootstrap admin, rate-limit allow-list
moon run dev-monolith                # wait for GET http://localhost:8000/health/ready
```

After a backend edit (watch mode): `bash scripts/sdd/stack-fix.sh api-ready`; a 502/503 that disappears is the restart. Restart the API with `bash scripts/sdd/stack-fix.sh api-restart` when an env var or start script changed.

## Per-work-package checks (narrowest first)

```bash
scripts/sdd/test-spec.sh libs/domains/orders/booking-voucher                # WP1 consumer, route, redelivery
scripts/sdd/test-spec.sh libs/domains/notifications/notifications-catalog   # WP2 rows
scripts/sdd/test-spec.sh libs/domains/identity/admin-jobs                   # WP4 allow-list
scripts/sdd/test-spec.sh libs/domains/identity/consumers-admin              # WP4 queue consumer
scripts/sdd/test-spec.sh libs/domains/identity/topics-admin                 # WP3 tap
python3 scripts/livespec/check.py
```

## Journey

```bash
pnpm test:journeys -- -t "US1"       # one story while building (US1..US6)
pnpm test:journeys -- launch-day     # whole file, serial
```

Expected: 40 scenarios mapped in `test-plan.md`; every hop within 2 × its maximum; no fixed sleeps (`grep -rn "setTimeout\|sleep(" packages/backend/test/journeys` empty); afterwards `GET /api/admin/clock` shows real time and no group or queue consumer is `PAUSED`. The file can take over 10 minutes: unattended, use `nohup … > specs/journeys/J03-launch-day/journeys-run.log` and poll in the foreground.

## Standalone boots and static gates (final checkpoint)

`core`, `worker`, `projector`, `sse-gateway` each alone, `/health/ready` 200; then `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict`, `check:module-graph`, `check:model-registry`, `tsc --noEmit`, ESLint.

## Ops artifacts (criteria no automated test proves)

Statistical and wall-clock criteria need many runs; one journey run does not prove them. Each is a row in `specs/UNVERIFIED.md`, status **not run**:

- **SC-003**: booking to notice within 5 s and voucher within 10 s in 99% of runs: loop AS-02 100 times, p99 of H4 and H5.
- **SC-004**: paid order to buyer and owner notices within 5 s (p99): loop AS-12.
- **SC-005**: comment to viewers within 1 s, to history within 5 s, toxic removed within 5 s (p99): loop AS-20 and AS-24.
- **SC-006** (timing part): winner's order visible within 10 s of the end (p99): loop AS-31.
- **SC-008**: lag back to 0 within 15 s of resuming (p99): loop AS-06, AS-07, AS-18, AS-25, AS-36.
- **SC-009**: clean stack to green in under 15 minutes with 0 fixed sleeps: `scripts/qa/fresh-run.sh`, then `pnpm test:journeys`, grep for sleeps.

SC-001, SC-002 and SC-007 are asserted in every run (AS-11, AS-38, AS-03 and others); their "100% of runs" wording is only as strong as the runs made.
