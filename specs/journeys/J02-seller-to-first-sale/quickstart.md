# Quickstart: J02 — validation guide

Contracts: [contracts/journey-kit.md](contracts/journey-kit.md). Data: [data-model.md](data-model.md). Research: [research.md](research.md).

## Prerequisites

```bash
moon run infra-setup                                   # stores, schemas, topics, ElasticMQ queues
# after any queue change reload ElasticMQ (scripts/infra/reload-queues.sh) and wait for /health/ready (L-020)
export JOURNEY_ENV=packages/backend/.env               # STRIPE_WEBHOOK_SECRET is read from it, never printed
# local profile (refused in production): CLOCK_CONTROL=enabled PROVIDER_DOUBLES=enabled
#   BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD, search refresh 1s, allowedReceiverHosts for the receiver
moon run dev-monolith                                  # wait for GET http://localhost:8000/health/ready
# the document extractor must be running (part of the local deployment after WP4)
```

After any backend edit (watch mode): `bash scripts/sdd/stack-fix.sh api-ready`; a 502/503 that disappears is the restart. Restart the API yourself with `bash scripts/sdd/stack-fix.sh api-restart` when an env var or start script changed.

## Per-work-package checks (narrowest first)

```bash
scripts/sdd/test-spec.sh libs/domains/catalog/product-command      # WP6 plan limit (limit, fail closed, no write)
scripts/sdd/test-spec.sh libs/domains/developer-platform/webhook-contract   # WP8 headers and body
scripts/sdd/test-spec.sh libs/domains/identity/shop-owner-promotion         # WP2 group name
python3 scripts/livespec/check.py                                           # proofs and code anchors stay true
```

## Journey

```bash
pnpm test:journeys -- -t "US1"        # one story while building (US1..US6)
pnpm test:journeys                    # all, serial
```

Expected: 33 scenarios mapped in `test-plan.md`; every hop within 2 × its contract; 0 fixed sleeps (`grep -rn "setTimeout\|sleep(" packages/backend/test/journeys` empty); `GET /api/admin/clock` shows `real` and no group is `PAUSED` afterwards. The suite needs about 10 minutes; if run from an unattended shell use `nohup … > specs/journeys/J02-seller-to-first-sale/journeys-run.log` and poll in the foreground.

## Standalone boots and static gates (final checkpoint)

`core`, `worker`, `projector`, `payment-processor`, `sse-gateway` and the extractor, each alone against the stack, `/health/ready` 200. Then `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict`, `check:module-graph`, `check:model-registry`, `tsc --noEmit`, ESLint on touched packages.

## Ops artifacts (criteria no automated test proves)

The journey asserts each hop once per run; the following criteria are percentiles over many runs or a wall-clock budget of the whole suite and have no automated proof:

- **SC-001** — shop created to `SELLER` role within 3 s in 99% of runs. Run: loop `pnpm test:journeys -- -t "AS-02"` 100 times and compute p99 of the H1 poll durations printed by `waitForContract`. Status: not run.
- **SC-002** — last approved document to `VERIFIED` within 5 s (p99); submission to verified under 30 s. Run: loop `-t "AS-06"` 100 times, p99 of H4 and total. Status: not run.
- **SC-003** — first charge to plan limits within 5 s (p99). Run: loop `-t "AS-12"` 100 times, p99 of H6+H7+H8. Status: not run.
- **SC-004** — product listed to public search within 10 s (p99). Run: loop `-t "AS-18"` 100 times, p99 of H9. Status: not run.
- **SC-005** — order paid to webhook and rank within 10 s (p99). Run: loop `-t "AS-25"` 100 times, p99 of H13 and H14. Status: not run.
- **SC-008** — clean stack to green in under 10 minutes with 0 fixed sleeps. Run: `time scripts/qa/fresh-run.sh && time pnpm test:journeys`, plus the `grep` above. Status: not run.

SC-006 (0 duplicates) and SC-007 (0 lost facts, lag back to 0 within 15 s) are proven by AS-03, AS-13, AS-19, AS-05, AS-15, AS-20, AS-28, AS-29. The six rows above are also in `specs/UNVERIFIED.md`.
