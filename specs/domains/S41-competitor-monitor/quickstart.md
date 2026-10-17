# Quickstart: validating S41 — Competitor Price Monitor

A run guide; contracts are in [contracts/](contracts/), tables in [data-model.md](data-model.md). Backend commands run from `packages/backend`.

## Prerequisites

Test stack up (`docker-compose.test.yaml`: Postgres, Redis, ClickHouse, MinIO, Kafka stand-in, ElasticMQ) with migrations applied, including the S41 expand migration and the ClickHouse `competitor_prices` v2 file.

## Narrow checks while building

```bash
scripts/sdd/test-spec.sh libs/domains/seller-insights/domain            # unit: url, robots, extract-price, simhash, schedule, alert-rule
scripts/sdd/test-spec.sh competitor-watches                             # AS-01..AS-15
scripts/sdd/test-spec.sh competitor-crawl                               # AS-16..AS-31
scripts/sdd/test-spec.sh competitor-pricing                             # AS-32..AS-42
scripts/sdd/test-spec.sh competitor-alerts                              # AS-43..AS-50
scripts/sdd/test-spec.sh competitor-reactions                           # AS-51..AS-56
```

Use `-t "AS-23"` to run one scenario. The whole capability suite (all five files + unit) runs once at the end.

## Static gates (AS-57)

```bash
pnpm --dir packages/backend check:table-ownership --strict    # zero findings for seller-insights crawler files
pnpm check:boundaries
pnpm --dir packages/backend exec tsc --noEmit
python3 scripts/livespec/check.py                             # living page S41 keeps its [proof:]/[code:] true
```

Expected: no `JOIN "Product"`, no `ShopModel`/`ShopMembershipModel` import, no FK from `CompetitorWatch` to `Shop`/`Product`, `CompetitorShop` in `db/ownership.ts`, no new direct `sequelize.transaction`.

## End-to-end story (what the e2e files prove)

1. Stan registers `HTTPS://Rival.test:443/p/iphone/?utm_source=ads&b=2&a=1#reviews` → `201`, normalised URL, no request to the competitor.
2. The scheduler queues the target once; a worker takes it under the host lease, fetches `robots.txt` then the page through the SSRF guard, extracts `899.00 EUR`, records observation 1, archives the page.
3. `PA` costs 99900 EUR → two outbox rows (owners Ann and Olga), none for Stan or Vic.
4. The competitor raises the price to 1099.00 → observation 2, no event; drops to 849.00 → event with `priceVersion` 3.

## Ops artifacts (criteria no automated test proves — not run)

| Criterion | How to run it | Status |
|---|---|---|
| SC-005 first fetch of a new URL within 2 minutes in a running fleet (scheduler cycle + lease) | Start worker; register a URL against a fixture host; measure registration → first `lastCheckedAt`. The scenario logic is proven by AS-11/AS-16 with a frozen clock; the wall-clock bound is not | not run |
| SC-006 registration p95 < 500 ms (excluding DNS) and history read p95 < 300 ms for 365 days | k6 or autocannon against core with 365 days of seeded history (`scripts/load-tests/`) | not run |
| SC-007 10 M watched URLs / 6 h ≈ 460 fetches/s fleet-wide, politeness bound holds | `packages/backend/scripts/load-tests/competitor-crawl.*` against a fixture fleet; check max in-flight per host = 1 | not run |

Each row is also in `specs/UNVERIFIED.md`.
