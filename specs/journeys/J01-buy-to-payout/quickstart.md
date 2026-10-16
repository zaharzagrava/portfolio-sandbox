# Quickstart: J01 — validation guide

Contracts: [contracts/control-surface.md](contracts/control-surface.md). Data: [data-model.md](data-model.md).

## Prerequisites

```bash
moon run infra-setup                 # stores, schemas, topics (WP4 adds the five *.events topics), ElasticMQ queues
# after any queue change: reload ElasticMQ with `scripts/infra/reload-queues.sh`, then check readiness (L-020)
FORCE=1 scripts/infra/make-dev-env.sh  # only on an old .env: adds CLOCK_CONTROL=enabled, PROVIDER_DOUBLES=enabled, STRIPE_WEBHOOK_SECRET (restart the API afterwards)
export JOURNEY_ENV=packages/backend/.env         # STRIPE_WEBHOOK_SECRET is read from it (G-37); the journeys never print it
moon run dev-monolith                # wait for GET http://localhost:8000/health/ready
pnpm --filter api start:lambda-local document-extractor   # the only consumer of `onboarding-documents`: without it no shop is ever verified
pnpm --filter api seed:dev           # the operator account the journeys use (JOURNEY_ADMIN_EMAIL / JOURNEY_ADMIN_PASSWORD override the seed defaults)
```

`scripts/qa/stack-up.sh` does the last two itself. The journeys clear the rate-limit counters (`rl:*`) of the stack's Redis (`REDIS_URL`, default `redis://localhost:6300/0`) before registering actors, because every actor comes from one IP.

## Per-work-package checks (narrowest first)

```bash
scripts/sdd/test-spec.sh <control-surface specs>          # admin jobs, consumers, clock
scripts/sdd/test-spec.sh libs/domains/payments/finance    # commission at settlement (updated expectations)
scripts/sdd/test-spec.sh libs/infrastructure/outbox       # relay envelope on a real topic message, both modes
python3 scripts/livespec/check.py                         # proofs and code anchors stay true
```

## Journey

```bash
pnpm test:journeys                                         # all stories, serial
pnpm test:journeys -- -t "US1"                             # one story while building
```
Expected: 31 scenarios mapped in `test-plan.md`, every hop within 2 × its contract, 0 fixed sleeps, consumers resumed and clock restored afterwards (check `GET /api/admin/clock` shows `real`).

## Standalone boots (L-015, L-018)

Start each of `core`, `worker`, `projector`, `payment-processor`, `sse-gateway` alone against the stack and require `/health/ready` 200. Then `pnpm check:module-graph`.

## Static gates (AS-31)

`pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict`, `check:module-graph`, `check:model-registry`, `tsc --noEmit`, ESLint on touched packages.

## Final checkpoint (L-012, L-019)

1. Whole capability suites once (orders, payments, statements, notifications, projections).
2. `scripts/qa/fresh-run.sh` then `pnpm test:journeys` on the empty stack.
3. Browser suite once on an empty stack: `buy-to-payout.spec.ts` (AS-29) with `PW_EXPECT_TIMEOUT_MS`, 2 workers.

## Ops artifacts (criteria no automated test proves)

- **SC-001** — 99% of runs from payment to order `PAID` within 5 s. Run: loop `pnpm test:journeys -- -t "US1"` 100 times on the local stack and compute the p99 of the H3 poll durations printed by `waitForContract`. Status: not run.
- **SC-007** — clean stack to green in under 10 minutes with 0 fixed sleeps. Run: `time scripts/qa/fresh-run.sh && time pnpm test:journeys`; `grep -rn "setTimeout\|sleep(" packages/backend/test/journeys` must be empty. Status: not run.

Both are also rows in `specs/UNVERIFIED.md` (added in the same change).
