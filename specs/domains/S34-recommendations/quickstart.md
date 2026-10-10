# Quickstart: validating S34

Prerequisites: `docker-compose.test.yaml` services (Postgres, Redis, ClickHouse) running; run backend commands from `packages/backend`. Contracts: [recommendations-api.md](contracts/recommendations-api.md); entities: [data-model.md](data-model.md).

```bash
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/discovery/domain         # unit specs U1-U6
/opt/sdd/repo/scripts/sdd/test-spec.sh recommendations-baskets
/opt/sdd/repo/scripts/sdd/test-spec.sh recommendations-build
/opt/sdd/repo/scripts/sdd/test-spec.sh recommendations-read
/opt/sdd/repo/scripts/sdd/test-spec.sh recommendations-cold-start
/opt/sdd/repo/scripts/sdd/test-spec.sh recommendations-platform
pnpm check:boundaries
pnpm check:table-ownership --strict
pnpm exec tsc --noEmit
```

Smoke: deliver a few `order.paid` envelopes (three buyers, two shared products), run the `recommendations.build-bought-together` job once, then `GET /api/products/<id>/recommendations` → `200` with `type: "bought-together"`, `Cache-Control: public, max-age=60, s-maxage=300`; `?limit=0` → `400 validation_failed`; an unknown id → `404 product_not_found`.

## Ops artifacts (no automated test proves these; rows in `specs/UNVERIFIED.md`, status "not run")

- **SC-001**: `loadtest:recommendations` against a deployed node with a realistic id mix and the edge cache in front; p99 ≤ 300 ms uncached, and the product page still renders when the rail is slow or down (composition budget is S48's).
- **SC-007**: one build run on the 1-billion-order-line fixture finishes in under 60 minutes; no list older than 3 days.
- **SC-009**: the alert "no `recommendations_build_last_success_timestamp` advance for 36 hours" exists in the monitoring stack and fires in a drill (the e2e proves the metric moves on success and not on failure, not the alert rule).
- Edge cache honours `Cache-Control`, keys on the full URL and forwards no credentials for `/api/products/*/recommendations`.
- Replay before cut-over: replay `orders.events` into `recommendation_baskets`, then enable the build and apply `042_drop_order_baskets.sql` (operator step).
