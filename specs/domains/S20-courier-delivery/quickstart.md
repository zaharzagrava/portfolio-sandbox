# Quickstart: validating S20

Run backend commands from `packages/backend`; run e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>`.

## Prerequisites
Test stack with Postgres, Redis, DynamoDB local, ElasticMQ (queue `delivery-offer-timeouts` present) and the Kafka stand-in; migrations applied (`pnpm db:jest:migrate:up` for the expand step and the fee bridge, then by hand `pnpm db:jest:migrate:up --migrations-path migrations/contract` for the contract step; `db:migrate` never runs `migrations/contract`).

## Static gates
1. `pnpm exec tsc --noEmit` and ESLint.
2. `pnpm check:boundaries`.
3. `pnpm --dir packages/backend check:table-ownership --strict` — zero delivery findings (AS-58, SC-010).
4. `python3 scripts/livespec/check.py` — the S20 page anchors resolve.
5. No `// S54 T037 audit` left in `libs/domains/fulfilment`.

## Narrow proofs
| Change | Command |
|---|---|
| Pure rules | `pnpm jest libs/domains/fulfilment/domain` |
| Courier | `test-spec.sh fulfilment/courier-shift`, `courier-locations`, `courier-track-projector` |
| Dispatch, lifecycle | `test-spec.sh fulfilment/delivery-dispatch`, `delivery-lifecycle` |
| Request, reads | `test-spec.sh fulfilment/delivery-request` |
| Tracking, surge, ownership, orders, metrics | `delivery-tracking`, `delivery-surge`, `delivery-city-ownership`, `delivery-order-events`, `delivery-observability` |

## Whole capability suite (once at the end; one fresh process per file, L-008)
Run the eleven e2e files plus the unit specs; each must print its summary line.

## Ops artifacts (no automated test proves these; status "not run")
- SC-001: 50 000 points/s, p99 < 20 ms — load run against `POST /couriers/me/locations`.
- SC-002: 10 000 randomised concurrent dispatch / decline / timeout / accept with the guard wiped — soak script (the e2e proves the invariant on small cases only).
- SC-003: 5 000 req/s first-offer p99 < 200 ms; offer push within 1 s.
- SC-004: crash drill — kill the worker mid-offer; an overdue offer is acted on within 30 s.
- SC-006: status push within 2 s in a real environment.
- SC-008: add a dispatcher to five on a staging ring; ≤ 25 % of cities move (the pure ring test proves the function, not the fleet).
- SC-009: 90-day expiry of GPS points (Dynamo TTL) in a real environment.
