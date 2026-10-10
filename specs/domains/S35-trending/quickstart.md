# Quickstart: validating S35

Prerequisites: `docker-compose.test.yaml` services (Postgres, Redis, Kafka stand-in) running; run backend commands from `packages/backend`. Contract: [trending-api.md](contracts/trending-api.md); entities: [data-model.md](data-model.md).

```bash
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/discovery/domain      # unit specs U1-U8
/opt/sdd/repo/scripts/sdd/test-spec.sh trending-stream
/opt/sdd/repo/scripts/sdd/test-spec.sh trending-read
/opt/sdd/repo/scripts/sdd/test-spec.sh trending-platform
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/ads         # trending case gone, sponsored clicks intact
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/composition/bff               # envelope stub
pnpm check:boundaries
pnpm check:table-ownership --strict
pnpm exec tsc --noEmit
```

Smoke: produce a few `product_view` / `add_to_cart` messages (distinct `anonymous_id`s) to `analytics.events`, then one message four minutes later to move the watermark; `GET /api/trending?category=audio` → `200` envelope with ranked items and `Cache-Control: public, max-age=30, s-maxage=30`; `?limit=0` → `400 validation_failed`; `?category=A:b` → `400`.

## Ops artifacts (no automated test proves these; rows in `specs/UNVERIFIED.md`, status "not run")

- **SC-001**: end-to-end freshness against a deployed stack with the edge cache: an interaction appears in the ranking within 5 minutes in at least 99% of 1,000 probes, and the home page still renders when the endpoint is slow or down (the page part is W02/S48's).
- **SC-006**: replay 10 million synthetic events over 10 million distinct products and 1,000 categories per window into one consumer; tracked memory stays under the budget, no event is lost (buffered, then back-pressured) and the approximate top-K is compared with the exact one.
- **SC-007**: `loadtest:trending` at 500 rps, uncached; p99 < 200 ms and no unfiltered list (503 instead).
- **SC-008**: the alert "no `trending_last_merge_timestamp_seconds` advance for 10 minutes while `trending_events_total{outcome="counted"}` grows" exists in the monitoring stack and fires in a drill (the e2e proves the metrics move, not the alert rule).
- **SC-009**: 500,000 events/s across 64 partitions with 16 consumers; lag stays under 60 s.
- Edge cache honours `Cache-Control`, keys on the full URL and forwards no credentials for `/api/trending`.
