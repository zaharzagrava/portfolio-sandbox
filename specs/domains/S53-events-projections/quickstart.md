# Quickstart: validating S53

Scenario detail lives in `test-plan.md`; contracts in `contracts/`; tables in `data-model.md`.

## Prerequisites
`docker compose -f docker-compose.test.yaml up -d` (Postgres 18, Redpanda with transactions, ElasticMQ, Redis, Elasticsearch, DynamoDB local, Scylla, ClickHouse). CDC spec only: add `--profile cdc` (Debezium, Kafka Connect). Run from `packages/backend`.

## Automated validation
```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm check:boundaries
pnpm check:technical-tables                    # AS-09, SC-008 (green now; `check:table-ownership --strict` also fails on the 87 D-7/D-12 findings owned by other specs)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/events
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/outbox   # outbox-cdc only with the cdc profile up
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/inbox
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/projections
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/sqs
```
Expected: every scenario AS-01 to AS-108 passes once; no fixed sleeps; the suite asserts persisted state in each test. Run the narrowest spec while developing and the whole capability suite once at the end.

## Ops artifacts
Success criteria that no automated test proves. Status of each is **not run** (see `specs/UNVERIFIED.md`); do not describe them as verified.

- **SC-001** (10,000 randomized commit/rollback transactions with relay crashes and broker outages, 0 missing, 0 phantom): run a randomized driver that opens transactions through a fixture service, kills the relay and pauses the broker through the fault proxy at random, then compares committed aggregate versions with the topic contents read by a real consumer.
- **SC-004** (99% of `minVersion` reads within 500 ms, 100% within 2.5 s): run the fixture route under steady write load with a `minVersion` header, record the source (`read-model`, `write-model`, `pending`) and latency, compute the percentiles.
- **SC-005** (projection lag p99 < 2 s at 1, 2 and 4 instances, 100,000-event flood): run the F-05 load script (`docs/showcase/sections/F-05-cqrs-projection-framework.md`) against 1, 2 and 4 projector instances and read `projection_lag_seconds`. Reported, not a CI gate.
- **AS-21** (CDC relay produces the same topic, key, value and headers as the poller; poller off): `S53_CDC=1 /opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/outbox/outbox-cdc` with `docker compose -f docker-compose.test.yaml --profile cdc up -d`. The spec is written but was not run: the Debezium image could not be pulled in the sandbox.
- **SC-006** (100,000-event shadow rebuild, zero failed reads on the live target, promotion refused until caught up): produce 100,000 events, run `projections:rebuild` for a shadow version while a reader loop hits the live target, try `projections:promote` early and after `caughtUp`.
