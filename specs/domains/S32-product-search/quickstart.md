# Quickstart: validating S32

Validation guide only; implementation detail is in `tasks.md`. Contracts: [`contracts/http-api.md`](contracts/http-api.md), [`contracts/events-and-ports.md`](contracts/events-and-ports.md). Data: [`data-model.md`](data-model.md).

## Prerequisites

- Test stack up: `docker compose -f docker-compose.test.yaml up -d` (Postgres, Redis, Redpanda, Elasticsearch 8.15.3, ClickHouse). Run backend commands from `packages/backend`.
- Migrations applied (six discovery tables, synonym seed v1, ClickHouse TTL).
- Config present in the test env: `search_log_secret`, `search_id_signing_key` (distinct from `jwt_secret`).

## Run the proofs (narrowest first)

Always through the condensed runner; open the full log only when its output is not enough.

```bash
cd packages/backend
../../scripts/sdd/test-spec.sh libs/domains/discovery/domain            # six unit files (AS-81 … AS-86, SC-004 permutations)
../../scripts/sdd/test-spec.sh libs/domains/discovery/search-query       # AS-01 … AS-14
../../scripts/sdd/test-spec.sh libs/domains/discovery/search-facets-semantic
../../scripts/sdd/test-spec.sh libs/domains/discovery/search-projection  # AS-22 … AS-38
../../scripts/sdd/test-spec.sh libs/domains/discovery/search-reindex     # AS-39 … AS-51
../../scripts/sdd/test-spec.sh libs/domains/discovery/search-synonyms    # AS-53 … AS-60
../../scripts/sdd/test-spec.sh libs/domains/discovery/shop-product-search # AS-61 … AS-69
../../scripts/sdd/test-spec.sh libs/domains/discovery/search-measurement # AS-70 … AS-76
../../scripts/sdd/test-spec.sh libs/domains/discovery/search-admin       # AS-52, AS-77
../../scripts/sdd/test-spec.sh libs/domains/discovery/search-platform    # AS-78 … AS-80
../../scripts/sdd/test-spec.sh libs/domains/discovery                    # whole capability suite, once at the end
../../scripts/sdd/test-spec.sh libs/infrastructure/projections/versioned-sinks  # the moved ES client must keep S53 green
```

Static gates: `npx tsc --noEmit -p packages/backend` and `-p packages/contracts`; `pnpm --dir packages/backend check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (zero findings for discovery search code; paste its exact output into section C of `gaps.md`).

## Manual walk-through (local, after `pnpm start` of core + projector + worker)

1. Publish a `catalog.product_created` for an `ACTIVE` product; within 10 s `GET /api/products/search?q=<title word>` returns it with `mode: "lexical"` and a `searchId`.
2. `POST /api/search/clicks` with that `searchId`, `productId`, `position: 0` → `202`.
3. As an admin: `POST /api/admin/search/reindex` → `202`; poll `GET /api/admin/search/reindex/<runId>` until `COMPLETED`; `GET /api/admin/search/index` shows the new index, the previous one retained and `outdated: false`.
4. `PUT /api/admin/search/synonyms {rules:["airpods, earbuds"], expectedVersion: 1}` → `200`; search `earbuds` finds AirPods without a reindex.
5. `GET /api/shops/<shopId>/products/search?q=<typo>` as a member returns the shop's own products only.

Closed-shop codes for the shop route are taken from spec AS-64 (`403 shop_suspended`, `409 shop_offboarding`, `404` for `DELETED`); if S03's `ShopScoped` answers read permissions differently, the test follows S03's implemented behaviour and the difference is recorded in `gaps.md` before the spec is touched.

## Ops artifacts (criteria no automated test proves)

Status for every row below is **not run**; none may be described as verified. Each has a row in `specs/UNVERIFIED.md`.

- **SC-001** — p95 < 300 ms at 100,000 searches/s over 50 M products. Run: `pnpm --dir packages/backend loadtest:search` against a staging index seeded with 50 M synthetic documents (24 shards, 2 replicas), k6 ramp to 100,000 req/s, read p95 from the k6 summary.
- **SC-002** — change visible within 10 s for 95% and 60 s for 99% of changes at 5,000 product changes/s. Run: publish a 5,000 events/s stream of `catalog.product_updated` for 10 minutes, compare `occurredAt` with the first search response showing the new `productVersion` (metric `search_projection_lag_seconds` histogram).
- **SC-003 (load part)** — a full reindex under load causes zero failed searches and no dip in counts, rollback under one minute. Run: `loadtest:search` at the SC-001 rate while `POST /admin/search/reindex` runs to completion, then `POST /admin/search/rollback`; error rate must be 0. (The 50 searches/s variant is automated in AS-40.)
- **SC-006** — zero hidden products in 10,000 searches against a deliberately polluted index. Run: seed an index with archived, sandbox-flag, deleted and suspended-shop documents mixed with visible ones, replay 10,000 recorded queries, assert no hidden `id` in any response (script under `scripts/loadtest/`).
- **SC-010** — at least 95% of a curated typo test set finds the intended product. Run: relevance harness over a curated set of (typo query, expected product) pairs against a seeded staging index; fail below 0.95.

SC-004, SC-005, SC-007, SC-008 (report content), SC-009 are proven by automated tests (AS-81 permutation property, AS-53/AS-57, AS-63, AS-73, AS-13/AS-20).
