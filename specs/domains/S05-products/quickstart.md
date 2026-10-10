# Quickstart: validating S05 — Products

Run from `packages/backend` unless stated. Use the condensed runner; open the full log it prints only when the summary is not enough.

## Prerequisites

- Test engines up (`docker-compose.test.yaml`: Postgres, Redis, Kafka/SQS stand-ins); migrations applied by the test harness. Production deploy order: expand migrations → code → backfill job to completion (`catalog_backfill_orphans` = 0) → contract migrations.
- Config: `platform_currency` (ISO 4217, default `USD`), validated at startup.

## Narrowest proofs, in work-package order

```bash
S=/opt/sdd/repo/scripts/sdd/test-spec.sh
npx jest libs/domains/catalog/domain                                   # unit: status machine, stock rule (fast-check), input normalisation
$S libs/domains/catalog/product-write                                  # WP-4/5: AS-01…AS-22, SC-001 matrix
$S libs/domains/catalog/product-query-stock                            # WP-4: AS-48…AS-58, SC-002 (1,000 requests / 100 units)
$S libs/domains/catalog/product-import                                 # AS-60…AS-64
$S libs/domains/catalog/product-read                                   # WP-6: AS-23…AS-26, AS-31…AS-33, AS-38, SC-006
$S libs/domains/catalog/product-cache                                  # AS-27…AS-30, AS-34…AS-37, AS-84, SC-003, SC-005
$S libs/domains/catalog/product-invalidation                           # WP-7: AS-39…AS-47
$S libs/domains/catalog/product-views                                  # WP-8: AS-66…AS-75
$S libs/domains/catalog/product-shop-lifecycle                         # WP-9: AS-76…AS-81
$S libs/domains/catalog/product-events                                 # AS-65, AS-82, AS-83, AS-85
$S libs/domains/catalog/product-boundary                               # AS-86 (entry point), AS-87
```

Whole capability once at the end: `$S libs/domains/catalog` (collab and drafts specs included; they must stay green).

## Static gates

```bash
npx tsc --noEmit -p tsconfig.json && (cd ../contracts && npx tsc --noEmit)
pnpm lint
pnpm check:boundaries
pnpm check:table-ownership --strict      # expected: 0 findings for `catalog`; findings for `Product` in other domains remain until their follow-ups land (red overall, see SC-009)
pnpm check:no-wallclock
```

Numbers to record in the final report: `check:table-ownership` `catalog` 3 → 0 findings; direct `sequelize.transaction` sites in `libs/domains/catalog` 0 → 0 (`wrapInTransaction` 1 → 0); other domains' `Product` findings unchanged (their follow-ups).

## Manual smoke (after the suite is green)

1. Create a product: `POST /api/shops/$SHOP/products {title, brand, category, priceMinor: 12900, quantity: 5}` as a `STAFF` member → `201`, `version: 1`.
2. `GET /api/products/$ID` twice with `-i`: `ETag: W/"$ID-v1"`, `Cache-Control: public, s-maxage=15, stale-while-revalidate=30`; repeat with `If-None-Match` → `304`.
3. `PATCH` with `expectedVersion: 1` → `version: 2`; stale `expectedVersion: 1` again → `409 version_conflict`, `currentVersion: 2`.
4. `POST …/archive {expectedVersion: 2}` → public `GET` is `404`; `…/restore` → `200` again.
5. Check the outbox rows and `products.events` for `catalog.product_*` with `aggregateVersion` 1, 2, 3, 4.

## Deploy notes

- Pending view counts staged under the old Redis name `wb:{product-views}` at deploy time are not read by the new code (loss ≤ one flush interval, analytics-grade, FR-037).
- Old `product:v1:*` entries expire by TTL; the new key space is `product:v2:*`.
- Routes `POST /products`, `POST /products/shops/:shopId`, `GET /products/search`, `GET /shops/:shopId/products/search` answer `404` after this release; `packages/web` is adapted in the same change.
- Orphan products (no `shopId` and no `sellerId`) block the `NOT NULL` contract migration; resolve them by hand (assign a shop or archive) before running it.

## Ops artifacts (criteria no automated test proves)

Each is also a row in `specs/UNVERIFIED.md` (status `not run`). Do not describe them as verified.

| Criterion | How to run it |
|---|---|
| **SC-004** (99% of pages show a new price within 5 s, 100% within 6 minutes even if the notification is lost, under production-like load) | Deployed stack with the real broker: script that updates a price on 1,000 products, polls `GET /products/:id` from two instances every 250 ms, records time-to-new-price per product; repeat with the invalidation consumer stopped to confirm the 6-minute bound. The automated tests prove the mechanism (AS-30, AS-39–AS-46, p99 over 100 events in the test environment) but not the percentile at scale |
| **SC-007** (after 10,000 views of one product at most one count write per 10 s for it; stored count equals views served) | k6 script of 10,000 `GET /products/:id` for one id against a deployed stack with the worker running; count `UPDATE "Product"` statements touching the id through `pg_stat_statements` over the run; compare `viewCount` to the number of `200`/`304` answers. Automated tests prove the flush logic with 5 and 2,500 views (AS-66, AS-69) |
| **SC-008** (a seller lists a new product and sees it in the inventory in under 2 minutes of interaction) | Stopwatch walk-through of the W04 inventory screen once it exists (add product, see it in the list), 5 runs, median reported. The API half (create then list) is proven by AS-01 and AS-14 |

| **SC-009** (0 cross-domain queries for `catalog` and 0 queries against the product table from any other domain) | `pnpm check:table-ownership --strict`. The `catalog` half is expected green and is asserted in the final report; the second half stays red until the consumers in `gaps.md` section C migrate (same situation as S03's SC-009), so the criterion as a whole is not run |

SC-001, SC-002, SC-003, SC-005, SC-006 and SC-010 are proven by tests and gates named in the table above (SC-001 matrix and SC-002 1,000-request run are explicit test cases in `product-write` and `product-query-stock`).
