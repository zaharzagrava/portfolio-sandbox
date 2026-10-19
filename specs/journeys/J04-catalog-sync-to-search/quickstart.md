# Quickstart: J04 — validation guide

Contracts: [contracts/journey-kit.md](contracts/journey-kit.md). Data: [data-model.md](data-model.md). Research: [research.md](research.md).

## Prerequisites
```bash
moon run infra-setup        # stores, schemas, topics (incl. pickup/tenancy/catalog-sync events), ElasticMQ
moon run dev-monolith       # wait for GET http://localhost:8000/health/ready
# local profile (refused in production): CLOCK_CONTROL=enabled PROVIDER_DOUBLES=enabled BOOTSTRAP_ADMIN_*
#   SEARCH_REFRESH_INTERVAL=1s ALLOWED_PROVIDER_HOSTS=<double host:port> clamav_host=<scanner double>
```
After backend edits: `bash scripts/sdd/stack-fix.sh api-ready`; env or start-script changes: `bash scripts/sdd/stack-fix.sh api-restart`.

## Per-WP checks
```bash
scripts/sdd/test-spec.sh libs/infrastructure/projections/consumer-groups   # aliases
scripts/sdd/test-spec.sh libs/domains/catalog-sync/integration-boundary    # provider host allow-list
python3 scripts/livespec/check.py
```

## Journey
```bash
pnpm test:journeys -- -t "J04 AS-01"      # one scenario while building
pnpm test:journeys -- catalog-sync-to-search
```
The whole file takes 10+ minutes: `nohup … > specs/journeys/J04-catalog-sync-to-search/journeys-run.log` and poll in the foreground. Expected: 23 scenarios (test-plan.md), every hop within 2 × contract, no `setTimeout`/`sleep(` in the journey, no group left `PAUSED`, clock `real`.

## Final checkpoint (run by the loop, not tasks)
Standalone boots, `pnpm check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `tsc --noEmit`, fresh stack.

## Ops artifacts (criteria no automated test proves)
- **SC-001** — 60-row file visible within 60 s of upload end. Run: loop `-t "AS-01"` 100 times, p99 of `[hop] J04.H1`+`H3`. Status: not run.
- **SC-002** — Shopify variants visible within 60 s. Run: loop `-t "AS-05"` 100 times, p99 of H4+H3. Status: not run.
- **SC-003** — after a till sale, availability and Shopify stock within 10 s. Run: loop `-t "AS-10"` 100 times, p99 of H10 and H11. Status: not run.
- **SC-004** — pickup shelf findable within 10 s. Run: loop `-t "AS-08"` and `-t "AS-09"` 100 times, p99 of H7 and H8. Status: not run.
- **SC-005** — 100 replays and 100 duplicate webhooks change stock once. Run: loop `-t "AS-11"` and `-t "AS-06"` 100 times. Status: not run.
- **SC-006** — both-sold cases end identical and non-negative. Run: loop `-t "AS-14"` and `-t "AS-15"` 100 times. Status: not run.
- **SC-008** — suspension hides products within 10 s. Run: loop `-t "AS-20"` 100 times, p99 of H14. Status: not run.

SC-007 and SC-009 are proven by AS-17 to AS-19 and by the no-sleep grep. The seven rows above are also in `specs/UNVERIFIED.md`.
