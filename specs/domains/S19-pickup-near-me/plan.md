# Implementation Plan: S19 — Pickup Points, Local Stock, "Available Near Me", Map Clustering

**Branch**: `S19-pickup-near-me` (working branch `sdd/auto`) | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-45, FR-001–FR-053, SC-001–SC-009), `test-plan.md`, `gaps.md` (A1–A27, D-6/D-7/D-8/D-12/D-16, section C ownership lines), `questions.md` (defaults accepted as written, no line edited by a human), the constitution v3.1.0, and the follow-ups left by S05, S10, S32, S48, S50 and W02 (below).

## Summary

Rebuild the pickup slice of `fulfilment` as three runtime paths that share ports in `domain/`:

1. **Write (exact store, `apps/core`, `PickupModule`)**: seller endpoints for points and local stock. Every write is one `TransactionRunner.run` that changes the row (conditional/atomic SQL: version compare, `quantity + :delta BETWEEN 0 AND 1000000`, point cap serialised per shop by a transaction-scoped advisory lock, R-5) and appends one `pickup.point_changed` / `pickup.stock_changed` outbox row. Adjustments use the S54 `@Idempotent` facility (24 h). The product of a stock write is checked through `ProductQueryService.getProductsByIds(ids, {shopId})` (R1) **before** the transaction opens (no network I/O inside it, III.3); that same read seeds the product copy.
2. **Read (`apps/core`)**: `GET /search/near` and `GET /pickup-points/clusters` read only the pickup availability index (800 ms bound, `503 search_unavailable`, never a fallback); `GET /pickup-points/near` reads PostGIS (2 s `statement_timeout`, `503 service_unavailable`). `PickupAvailabilityService.checkAvailability` (R1 export) reads the exact store in one statement.
3. **Project (`apps/projector`, `PickupProjectorModule`)**: S53 `Projector` consumers (own groups, coalescing, version guards, DLQ) for `pickup.stock_changed`, `pickup.point_changed`, `catalog.product_*` and `tenancy.shop_*`. They keep two fulfilment-owned copy tables (`PickupProductCopy`, `PickupShopCopy`) and write one index document per (point, product) built by one pure function from `stock + point + product copy + shop copy`. Replay of the four topics in any order, twice, rebuilds the same documents (AS-31).

Visibility is one pure function `isOfferVisible` (FR-023) used by the projector (to index or delete a document), the exact browse query builder (as the SQL it mirrors is tested against the function table) and the cluster/search filters.

All I/O crosses `domain/` ports with `infra/` adapters (D-6). `PickupService` is split into use-case services without SQL. Product and shop data arrive only through R1 (`getProductsByIds`) and R3 (events into the copy tables) (D-7, D-12). The barrel exports `PickupModule`, `PickupProjectorModule`, `PickupAvailabilityService`, DTO/event types only (D-8). No new deployable app (I.6).

## Technical Context

**Language/Version**: TypeScript (strict), NestJS, Zod schemas in `packages/contracts/src/fulfilment/pickup.ts` (already holds the read schemas; extended)
**Primary Dependencies**: `SearchEngineClient` (generic, S32 D-16: `search`, `bulk`, `indexExists`, `createIndex`, `count`, per-call `timeoutMs`/`maxRetries`), `TransactionRunner` / `@Transactional` (S54), `OutboxService.append`, S53 `Projector` framework (`projections/projector.ts`, `coalesce`, `DeadLetterWriter`), S54 `@Idempotent` (`IdempotencyModule`), `RateLimitModule.forFeature` + `definePolicies` (S50), `ProductQueryService` (S05), `ShopScoped` (S03), `Firewall({anonymous})` (S01), `MetricsRegistry`, `CLOCK`, `fast-check`
**Storage**: PostgreSQL + PostGIS (`PickupPoint` + `version`, `PickupStock`, new `PickupProductCopy`, `PickupShopCopy`; adjustment idempotency rows live in the S54 `IdempotencyKey` table, owner `infrastructure:idempotency`); Elasticsearch index `pickup_availability` (v2 mapping) owned by this domain's `infra/`; Kafka topic `pickup.events` (aggregate `pickup`, retention `full-history`) via the outbox
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (5 e2e files in `test-plan.md`), unit specs beside `domain/`, Playwright journey `packages/web/tests/storefront-discovery.spec.ts` (W02-owned, not `e2e/`)
**Target Platform**: Linux; `apps/core` (HTTP), `apps/projector` (consumers)
**Project Type**: backend domain module; web/BFF callers owned by W02/S48 (in-repo callers adapted so the build stays green)
**Performance Goals**: search/cluster p99 < 80 ms server time at 20 000 rps (SC-001, ops artifact: no load rig in the repo)
**Constraints**: search/cluster index call 800 ms, `maxRetries: 0` (latency-bound, one retry layer: none); exact browse `SET LOCAL statement_timeout = 2000` inside a read transaction; bulk write timeout 5 s with the framework's transient retry; `getProductsByIds` 500 ms budget; no retry inside a request
**Scale/Scope**: ≤ 100 points per shop; stock 0…1 000 000; delta ±100 000; `limit` ≤ 50; clusters ≤ 500 cells; cluster `pickupPoints` exact up to 1 000 per cell (`cardinality` precision_threshold 1000); projector batch ≤ 500 events

**Maximum accepted staleness (IX.7 R3)**: 95 % of changes visible in search within 5 s, 99.9 % within 30 s (FR-036). Budget: outbox relay (S53 target ≈ 1 s) + consumer batch/coalesce window (≤ 250 ms) + index `refresh_interval` 2 s → typical 3–4 s. Measured by `pickup_index_lag_seconds` = now − `occurredAt` of the newest applied event. The exact check and the exact browse are never stale. Clusters add the 30 s CDN copy on top, stated in the contract.

**Connection arithmetic (III.12)**: unchanged pools; the exact browse and the exact check use the existing sequelize pool (`pool.max` per core instance, set in `ApiConfigService`); the browse holds a connection for ≤ 2 s (statement limit) and is rate-limited to 120/min per caller, so one slow-store episode cannot occupy more than the 120 × 2 s ≈ 4 connection-minutes per caller per minute; the projector uses a separate small pool (`projector` app config). No new pool, no change of `pool max × instances`.

## Constitution Check

| Gate | Status | How |
|---|---|---|
| 1 Boundaries (I.1–I.3, X, no `forwardRef`, no `Scope.REQUEST`) | PASS after work | ports `PickupPointRepository`, `PickupStockRepository`, `PickupBrowseReader`, `PickupAvailabilityIndex`, `ProductCopyStore`, `ShopCopyStore`, `CatalogProductReader` (+ tokens) in `domain/`; adapters in `infra/`; `api/` and `application/` import no `infra/` (A22); `domain/` takes `now` and ids as parameters |
| 2 Controllers (II.1) | PASS | one call per method to an application service; zod parse pipe for the three public reads and bodies; problem+json from the global filter (domain errors extend the platform's `DomainError` with stable codes) |
| 3 Data access (III) | PASS after work | shop in every predicate (III.4); raw SQL only with named replacements and a fixed ORDER BY; invariants by store (`CHECK`, conditional `UPDATE … WHERE version = :v`, `quantity + :d BETWEEN 0 AND 1000000`, the 100-point cap under `pg_advisory_xact_lock` per shop: research R-5); keyset cursors (III.10); no I/O inside a transaction (R1 read first, outbox append is the allowed exception); every ES/DB call has a timeout. `.tx.baseline` = 1 is `dispatch.service.ts` (S20, not touched, not raised); no `sequelize.transaction` added |
| 4 Migrations (III.11) | PASS after work | expand step (`version`, copy tables, keyset index, `lock_timeout`), contract step (drop the two FKs) as separate files; neither runs at app start |
| 5 Messaging (IV.4–IV.6) | PASS after work | outbox for both events; every consumer validated by zod (`defineEvent` schemas), idempotent by version guard (documented in `data-model.md`), poison → DLQ with reason; explicit timeouts on every outbound call; retries at one layer |
| 6 Contracts (V) | PASS after work | explicit response DTOs; zod request/response schemas in `packages/contracts`; problem+json with codes; `Idempotency-Key` on adjustments (V.6); additive changes only inside the pickup contract (the existing bare-array/number-price shapes are replaced in this release: BREAKING list in `questions.md`) |
| 7 Web (VI) | N/A here | W02 owns the Playwright journey and screens; in-repo callers adapted at compile level only |
| 8 Tests (VII) | PASS after work | all 45 scenarios mapped (`test-plan.md`); every fallback/degradation forced (AS-08, 09, 22, 26, 39, 43); consumer duplicate/invalid pairs for four handlers; concurrency by `Promise.all` (AS-13, 19, 21) |
| 9 Operational (VIII) | PASS after work | `pickup_*` metrics with fixed-enum labels; no coordinates of shoppers, full addresses or bodies in logs; index mapping created idempotently at start-up and a missing/unreachable engine fails readiness of the projector (not a swallowed warning, A19); graceful shutdown by the framework |
| 10 DB isolation (IX) | PASS after work | FKs dropped; no `ProductModel`/`ShopModel` import; copy tables registered in `db/ownership.ts`; `check:table-ownership --strict` shows zero pickup lines (baseline `.ownership.baseline` = 1 of which the pickup part is `fulfilment → catalog.Product`) |
| 11 Monorepo (X) | PASS after work | barrel as in D-8; `apps/*` import modules only; contracts in `packages/contracts` |

Post-design re-check: PASS. Risks recorded: (a) the S05 `catalog.product_*` payload and the compacted-topic tombstone must be read from the real `product-events.ts`/contracts at T-time — the copy handler accepts both the `catalog.product_deleted` event and a tombstone state (research R-3); (b) `shop_deleted` in S03 carries `{shopId, shopVersion}` (spec text says `{shopId}`): the handler requires `shopId` and uses `shopVersion` when present (R-4); (c) cluster `pickupPoints` uses a `cardinality` aggregation (exact to precision_threshold 1000, as FR-026/AS-34 state).

## Follow-ups from built sibling specs (treated as requirements)

1. **S05 → S19**: product facts only from `catalog.product_*` full-state events (`productVersion`, `quantity`, `inStock`, `status`, `shopId`, `priceMinor`, `isSandbox`) into `PickupProductCopy`; no read of `Product`; `catalog.product_changed` is not consumed (it stops being written and is then removed); the `products` topic is compacted — replay yields the latest snapshot per product and a `catalog.product_deleted` tombstone means "remove" (R-3). Stock-write seed uses `getProductsByIds(ids, {shopId})`.
2. **S10 → S19, S20**: `OrderFulfilmentService.apply` / `order.paid` / `InvalidOrderTransitionError` concern delivery fulfilment, which is S20's (spec Scope, Out of scope). S19 consumes none of them; recorded under "Sibling-spec follow-ups" in `gaps.md` so S10's list can drop S19. Nothing is built for it here.
3. **S32 → S19**: the projector and index already use `SearchEngineClient`; the work left is to stop using `getClient()` for the hot paths and use `search`/`bulk`/`indexExists`/`createIndex` with explicit timeouts, a private index name and no shared index or filter (A13, A19).
4. **S48 → S19**: `pickupPageSchema` in `packages/contracts/src/bff/upstream.ts` is replaced by a re-export of this capability's schema (`pickupPointsNearResponseSchema`), keeping the exported name; the BFF's drift shows as `UPSTREAM_INVALID`. The BFF file is S48's; the one-line re-export is made here so the BFF suite stays green, and noted in `gaps.md`.
5. **S50 → S19**: `fulfilment.near-search` and `fulfilment.map-clusters` declared in `fulfilment/rate-limit-policies.ts` via `definePolicies('fulfilment', …)` and registered by `RateLimitModule.forFeature`; `@RateLimit('search.query')` and `skipThrottle` (G-34/G-35 pickup call sites, lines 57, 65, 71) replaced. `search.query` stays declared by `catalog` for its other call sites.
6. **W02 → S19**: the journey file is `packages/web/tests/storefront-discovery.spec.ts`; `test-plan.md` says `packages/web/e2e/…`; W02's file is not edited here, the correction is in `gaps.md`, and the pickup steps of that journey are adapted only if the response shape change breaks them (T-task in the callers step).
7. **S54 toolkit**: `dispatch.service.ts` (S20, same domain) keeps its single `// S54 T037 audit` site; no pickup file opens `sequelize.transaction`. The pickup writes use `TransactionRunner.run`.
8. **gaps.md items**: every row A1–A27, D-6, D-7, D-8, D-12, D-16 and the section C lines are in the technical tasks below. A27 (showcase note edit) and pattern P0328 status are doc tasks.

## Project Structure

### Documentation

```text
specs/domains/S19-pickup-near-me/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/pickup-api.md
└── tasks.md   # /speckit-tasks
```

### Source code (`packages/backend/libs/domains/fulfilment/`; contracts in `packages/contracts/src/fulfilment/`)

```text
packages/contracts/src/fulfilment/pickup.ts          # extend: write bodies/responses, stock, cluster, events payloads (A24)
packages/backend/migrations/
  2026101x…-pickup-s19-expand.js                     # lock_timeout; PickupPoint.version; copy tables; keyset index; backfill copy rows not needed (replay)
  2026101x…-pickup-s19-contract.js                   # drop FK PickupPoint.shopId, PickupStock.productId (separate deploy step)
packages/backend/db/ownership.ts                     # + PickupProductCopy, PickupShopCopy: domain:fulfilment (A26)
fulfilment/
├── api/
│   ├── pickup-points.controller.ts                  # seller: create, list, patch, stock list/set/adjust (ShopScoped, @Idempotent on adjust)
│   ├── pickup-public.controller.ts                  # public: search/near, pickup-points/near, clusters (Firewall anonymous, policies, Cache-Control)
│   └── pickup.dto.ts                                # request/response DTOs built from contracts schemas
├── application/
│   ├── pickup-points.service.ts                     # create/update/list, limit, event
│   ├── pickup-stock.service.ts                      # set, adjust, list; R1 product ownership; seed copy; event
│   ├── pickup-search.service.ts                     # search/near, clusters (index port), browse (reader port), cursors
│   ├── pickup-availability.service.ts               # exported R1 service: checkAvailability
│   ├── pickup-projection.service.ts                 # use cases for the four consumers (apply stock/point/product/shop)
│   └── events/pickup-events.ts                      # pickup.stock_changed / pickup.point_changed v1 (aggregate 'pickup', topic pickup.events)
├── domain/
│   ├── pickup-ports.ts                              # ports + tokens
│   ├── pickup-errors.ts                             # PickupPointNotFoundError, InvalidAvailabilityRequestError, … with codes/status
│   ├── offer-visibility.ts (+spec)                  # isOfferVisible
│   ├── opening-hours.ts (+spec)                     # validate/normalise
│   ├── stock-rules.ts (+spec, fast-check)           # decide set/adjust, version guard
│   ├── search-cursor.ts (+spec)                     # opaque cursor: tuple + query hash (HMAC-free, tamper-evident via hash)
│   ├── geo-input.ts (+spec)                         # lat/lng/radius/limit/q/bbox/zoom parse
│   ├── cluster-cap.ts (+spec)                       # sort + cap 500 + truncated
│   ├── offer-document.ts                            # pure build of the index document from the four sources
│   └── geohash.ts                                   # S20's, untouched
├── infra/
│   ├── pickup-point.repository.ts / pickup-stock.repository.ts / pickup-browse.reader.ts   # SQL behind ports
│   ├── product-copy.store.ts / shop-copy.store.ts   # copy tables (version-guarded upserts)
│   ├── availability-index.ts                        # index adapter: mapping, search, collapse, geotile, bulk (SearchEngineClient only)
│   ├── catalog-product.reader.ts                    # ACL over ProductQueryService (timeout, DTO → port type)
│   ├── pickup-*.projector.ts (4)                    # stock, point, product, shop consumers (Projector)
│   └── pickup-metrics.ts                            # pickup_* series
├── pickup.module.ts                                 # PickupModule (core) — replaces current wiring
├── pickup-projector.module.ts                       # PickupProjectorModule
├── rate-limit-policies.ts                           # fulfilment.near-search, fulfilment.map-clusters
├── index.ts                                         # D-8: modules + PickupAvailabilityService + types
└── pickup-{points,stock,search,clusters,availability-projector}.e2e-spec.ts   # replaces pickup.e2e-spec.ts (scenarios preserved, L-017)
apps/core/src/core.module.ts       # imports PickupModule (already)
apps/projector/src/projector.module.ts   # import PickupProjectorModule instead of PickupAvailabilityProjector (A23)
packages/contracts/src/bff/upstream.ts   # pickupPageSchema → re-export of the S19 schema (S48 follow-up 4)
docs/spec/capabilities/S19-pickup-near-me.md   # living-spec page, written first (cross-spec rule 0)
docs/showcase/sections/SD-13-pickup-near-me.md # A27 routes
```

**Structure Decision**: stay inside `fulfilment`; pickup files are separate from S20's delivery files, which are not touched. The old `PickupService`/`AvailabilityIndex`/`PickupAvailabilityProjector` names are removed from the barrel (D-8). `pickup.e2e-spec.ts` is replaced by the five files; every scenario it proved (set stock → searchable, zero stock removes, near radius) reappears as AS-01/AS-16/AS-24 (L-017).

## Technical tasks by gap (input for `/speckit-tasks`)

Order follows `gaps.md` §D, test-first within each step (VII.9: A1 first).

0. **Living spec first** (rule 0): write `docs/spec/capabilities/S19-pickup-near-me.md` with rules R-nn and `[proof: S19 AS-nn]` / `[code: …]` anchors; run `python3 scripts/livespec/check.py`; no `*.reviewed.json`. Confirm `check:table-ownership` lines of section C by running it (gaps §C).
1. **Failing e2e first**: skeletons of the five e2e files for A1, A3, A4, A6, AS-12 (IDOR), AS-21 (concurrency) fail against the draft.
2. **Contracts, config, policies**: A24 (schemas incl. events), A12 (policy declaration + registration), error classes with codes (A14), metrics names (A20).
3. **Pure domain (unit, table-driven)**: `opening-hours` (A5), `stock-rules` (A6), `offer-visibility` (A8/A9), `geo-input` (A10/A11), `search-cursor`, `cluster-cap`, `offer-document`. Gate: unit specs green.
4. **Schema**: expand migration (A2 `version`, A25 keyset index, copy tables, `lock_timeout`), ownership registry (A26), then the contract migration after code stops relying on cascade (A25, section C FK lines).
5. **Write path**: repositories behind ports (A22), `PickupPointsService` (A2, A4, A5), `PickupStockService` (A1, A3, A6, A7), `@Idempotent` adjustments, events (A18) with `stockVersion`, seller controller and list endpoints (A7).
6. **Read path**: index adapter on `SearchEngineClient` with timeouts and `503` mapping (A9, A10, A13, A19), `PickupSearchService`, public controller with strict zod parse and policies (A8–A12), exact browse reader with statement limit and keyset cursor (A8, A13), `PickupAvailabilityService` (A17).
7. **Projection**: copy stores, four `Projector`s with coalescing, version guard, DLQ, shop deletion fan-out, product deletion fan-out (A15, A16, FR-033), index mapping bootstrap that fails loudly (A19), replay test (AS-31).
8. **Wiring and barrel**: `PickupModule`, `PickupProjectorModule`, `index.ts` (D-8, A23), `apps/projector` and BFF re-export; **start the real API and the projector** (L-015, L-004): `scripts/qa/fresh-run.sh` smoke of the three public reads and one seller write.
9. **Callers, docs**: in-repo callers of the old response shapes (web product page, BFF stub) adapted at compile level; showcase note (A27); pattern P0328 status after approval.
10. **Gates**: `tsc --noEmit`, ESLint, `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict`, `python3 scripts/livespec/check.py`, then the whole capability suite once in batches (L-008); ops artifacts into `specs/UNVERIFIED.md` (SC-001, SC-002 at scale).

## Complexity Tracking

None. No constitution exception is requested. The per-shop point cap counts under a per-shop transaction advisory lock rather than a bare count-then-insert (III.6), see research R-5.
