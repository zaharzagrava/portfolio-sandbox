---
id: S19
title: Pickup points, local stock, available near me, map clustering
kind: capability
status: draft
depends_on: [S01, S03, S05, S50, S53, S54]
concepts: [problem-json-errors, rate-limit-policy, projection-and-replay, idempotency-key, search-index]
models: []
scope:
  - packages/backend/libs/domains/fulfilment/api/pickup*.ts
  - packages/backend/libs/domains/fulfilment/application/pickup*.ts
  - packages/backend/libs/domains/fulfilment/domain/pickup*.ts
  - packages/backend/libs/domains/fulfilment/domain/offer*.ts
  - packages/backend/libs/domains/fulfilment/domain/stock-rules.ts
  - packages/backend/libs/domains/fulfilment/infra/pickup*.ts
  - packages/contracts/src/fulfilment/**
---
# S19 - Pickup points, local stock, available near me, map clustering
## Purpose
Shops register physical pickup points and keep a local stock count per product at each point. Shoppers ask which products are in stock within a radius, browse the points around them and pan a map that shows clusters of points with stock. The exact store (PostgreSQL with PostGIS) holds points and stock; search and the map read only a search index that follows the exact store with a bounded delay; a reservation-time service reads the exact store.

## Entry points
- `POST /api/shops/:shopId/pickup-points`, `GET /api/shops/:shopId/pickup-points`, `PATCH /api/shops/:shopId/pickup-points/:pointId`: seller management of points. [code: packages/backend/libs/domains/fulfilment/api/pickup-points.controller.ts#PickupPointsController]
- `GET /api/shops/:shopId/pickup-points/:pointId/stock`, `PUT /api/shops/:shopId/pickup-points/:pointId/stock/:productId`, `POST /api/shops/:shopId/pickup-points/:pointId/stock/:productId/adjustments`: local stock. [code: packages/backend/libs/domains/fulfilment/api/pickup-points.controller.ts#PickupPointsController]
- `GET /api/search/near`, `GET /api/pickup-points/near`, `GET /api/pickup-points/clusters`: anonymous reads. [code: packages/backend/libs/domains/fulfilment/api/pickup-public.controller.ts#PickupPublicController]
- Topic `pickup.events`: `pickup.stock_changed` and `pickup.point_changed`. Consumer groups of the projector: stock, point, product (`products` topic) and shop (`tenancy` topic). [code: packages/backend/libs/domains/fulfilment/application/events/pickup-events.ts#PickupStockChanged]
- `PickupAvailabilityService.checkAvailability`: the exact batch check for a later pickup checkout. [code: packages/backend/libs/domains/fulfilment/application/pickup-availability.service.ts#PickupAvailabilityService]

## Rules
- **S19.R-01** A shop member with `products.write` MUST be able to create a pickup point (name 1-120 and address 1-300 characters after trimming, coordinates, optional opening hours); the point and one `pickup.point_changed` event MUST commit in one transaction. [proof: S19 AS-10] [code: packages/backend/libs/domains/fulfilment/application/pickup-points.service.ts#PickupPointsService]
- **S19.R-02** Opening hours MUST be `{}` or a timezone with at most three non-overlapping intervals per day whose close is after open; anything else MUST answer `400` `validation_failed`, and no row or event is written. [proof: S19 AS-11] [code: packages/backend/libs/domains/fulfilment/domain/opening-hours.ts#validateOpeningHours]
- **S19.R-03** Every endpoint of the seller API MUST answer `401` without credentials, `404` for a shop the caller is not a member of, `403` for a viewer's write and `403` for a suspended shop; a point of another shop MUST answer `404` `pickup_point_not_found`. [proof: S19 AS-12] [code: packages/backend/libs/domains/fulfilment/api/pickup-points.controller.ts#PickupPointsController]
- **S19.R-04** A shop MUST NOT hold more than 100 points, inactive ones included, also under concurrent creates (`409` `pickup_point_limit_reached`). [proof: S19 AS-13] [code: packages/backend/libs/domains/fulfilment/infra/pickup-point.repository.ts#PickupPointSqlRepository]
- **S19.R-05** A point's name, address, opening hours and active flag MUST be editable; its location and shop MUST NOT change (`400`); every effective change MUST add one to `version` and emit one event, and a change that alters nothing MUST do neither. [proof: S19 AS-14, S19 AS-15] [code: packages/backend/libs/domains/fulfilment/application/pickup-points.service.ts#PickupPointsService]
- **S19.R-06** A stock write to an inactive point MUST answer `409` `pickup_point_inactive` and change nothing. [proof: S19 AS-15] [code: packages/backend/libs/domains/fulfilment/application/pickup-stock.service.ts#PickupStockService]
- **S19.R-07** Setting stock MUST store an absolute quantity from 0 to 1,000,000, add one to the row `version` only when the quantity changes and write one `pickup.stock_changed` event in the same transaction. [proof: S19 AS-16, S19 AS-17] [code: packages/backend/libs/domains/fulfilment/domain/stock-rules.ts#decideSet]
- **S19.R-08** A set with `expectedVersion` MUST succeed only when it equals the current version (`0` means no row); otherwise it MUST answer `409` `stock_version_conflict` with `currentVersion`. [proof: S19 AS-19] [code: packages/backend/libs/domains/fulfilment/domain/stock-rules.ts#decideSet]
- **S19.R-09** The product of a stock write MUST belong to the addressed shop (checked through the catalog with the shop filter); otherwise `404` `product_not_found`. [proof: S19 AS-18] [code: packages/backend/libs/domains/fulfilment/infra/catalog-product.reader.ts#CatalogProductReaderAdapter]
- **S19.R-10** An adjustment MUST need an `Idempotency-Key` (24 hours): a replay returns the stored answer with `Idempotency-Replayed: true`, a key reused with another body answers `422`, a key in flight `409`, a missing key `422`; `delta` MUST be a non-zero integer within 100,000. [proof: S19 AS-20] [code: packages/backend/libs/domains/fulfilment/api/pickup-points.controller.ts#PickupPointsController]
- **S19.R-11** Stock MUST never leave 0 to 1,000,000; a change that would break it MUST answer `409` `insufficient_pickup_stock` or `stock_limit_exceeded`, and concurrent decrements MUST succeed exactly as often as stock allows. [proof: S19 AS-21] [code: packages/backend/libs/domains/fulfilment/domain/stock-rules.ts#decideAdjust]
- **S19.R-12** A stock or point change and its event MUST commit together or not at all; a failed event append MUST leave the row unchanged and answer a generic `503`. [proof: S19 AS-22] [code: packages/backend/libs/domains/fulfilment/application/pickup-stock.service.ts#PickupStockService]
- **S19.R-13** The seller lists of points and of a point's stock MUST be keyset-paged, points by `createdAt` descending then `id` descending, with inactive points included and only the caller's shop. [proof: S19 AS-23] [code: packages/backend/libs/domains/fulfilment/infra/pickup-point.repository.ts#PickupPointSqlRepository]
- **S19.R-14** An offer MUST be visible only when stock is above zero, the point is active, the shop is `ACTIVE`, and the product is not archived and not sandbox; one pure function MUST decide it for the index, the exact browse and the clusters. [proof: S19 AS-06] [code: packages/backend/libs/domains/fulfilment/domain/offer-visibility.ts#isOfferVisible]
- **S19.R-15** The three public reads MUST answer anonymous callers and MUST return explicit bodies that parse with the contract schemas, with `priceMinor` and `currency`. [proof: S19 AS-07] [code: packages/contracts/src/fulfilment/pickup.ts#pickupNearSearchResponseSchema]
- **S19.R-16** Query parameters MUST be validated strictly (`lat`, `lng`, `radiusKm` 0.1-50 default 5, `q` up to 100 characters with blank meaning absent, `limit` 1-50 default 20, `cursor`, `productId`), unknown parameters MUST be refused, and nothing is clamped. [proof: S19 AS-04, S19 AS-42] [code: packages/backend/libs/domains/fulfilment/domain/geo-input.ts#parseNearQuery]
- **S19.R-17** Search MUST return one item per product with its nearest in-stock point, ordered by relevance then distance (with `q`) or by distance then `productId`, found regardless of map cell boundaries. [proof: S19 AS-01, S19 AS-02, S19 AS-03] [code: packages/backend/libs/domains/fulfilment/infra/availability-index.ts#PickupAvailabilityIndexAdapter]
- **S19.R-18** Search cursors MUST be opaque, tamper-evident and bound to their query; a cursor reused with another query MUST answer `400`. [proof: S19 AS-05] [code: packages/backend/libs/domains/fulfilment/domain/search-cursor.ts#decodeCursor]
- **S19.R-19** The policy `fulfilment.near-search` MUST limit search and browse to 120 requests a minute per user or client address and `fulfilment.map-clusters` MUST limit clusters to 300 a minute per client address; over the limit answers `429` `rate_limited` with `Retry-After`, and a limiter outage MUST allow the request. [proof: S19 AS-08, S19 AS-39] [code: packages/backend/libs/domains/fulfilment/rate-limit-policies.ts#fulfilmentRatePolicies]
- **S19.R-20** When the search index is unreachable or slower than 800 ms, search and clusters MUST answer `503` `search_unavailable` with `Retry-After` and a generic detail, and MUST NOT query the exact store. [proof: S19 AS-09, S19 AS-39] [code: packages/backend/libs/domains/fulfilment/domain/pickup-errors.ts#SearchUnavailableError]
- **S19.R-21** Stock, point, product and shop changes MUST reach the index idempotently and in version order: an older message is ignored, a duplicate has one effect, and a burst per point and product becomes one write. [proof: S19 AS-24, S19 AS-25, S19 AS-27] [code: packages/backend/libs/domains/fulfilment/application/pickup-projection.service.ts#PickupProjectionService]
- **S19.R-22** A message that fails its schema, has an unknown type or an unsupported version MUST be dead-lettered with its reason and have no other effect, in each of the four consumers. [proof: S19 AS-26] [code: packages/backend/libs/domains/fulfilment/infra/pickup-stock.projector.ts#PickupStockProjector]
- **S19.R-23** Point and product changes MUST update the offers they touch; an older `pointVersion` or `productVersion` MUST be ignored; product deletion MUST remove the product's stock rows with one `pickup.stock_changed` of quantity 0 each. [proof: S19 AS-28, S19 AS-29] [code: packages/backend/libs/domains/fulfilment/application/pickup-projection.service.ts#PickupProjectionService]
- **S19.R-24** Shop suspension MUST hide the shop's offers and reinstatement MUST show them; an older `shopVersion` MUST be ignored; shop deletion MUST deactivate every point of the shop with one event each and keep the stock. [proof: S19 AS-30] [code: packages/backend/libs/domains/fulfilment/application/pickup-projection.service.ts#PickupProjectionService]
- **S19.R-25** The index MUST be rebuildable from the events alone, delivered in any order and more than once, with the same documents as the live index. [proof: S19 AS-31] [code: packages/backend/libs/domains/fulfilment/domain/offer-document.ts#buildOfferDocument]
- **S19.R-26** `checkAvailability` MUST read the exact store in one statement and report shortages immediately although search may still show the offer; an unknown point MUST throw `PickupPointNotFoundError`, an inactive one MUST answer `pickup_point_inactive`, and an invalid request MUST throw `InvalidAvailabilityRequestError`. [proof: S19 AS-32, S19 AS-33] [code: packages/backend/libs/domains/fulfilment/application/pickup-availability.service.ts#PickupAvailabilityService]
- **S19.R-27** Clusters MUST count in-stock visible offers and distinct points per cell for a zoom from 0 to 20, give the centroid, give `pickupPointId` for a single-point cell, filter by `productId`, and accept a box that crosses the antimeridian. [proof: S19 AS-34, S19 AS-35, S19 AS-36, S19 AS-37] [code: packages/backend/libs/domains/fulfilment/domain/geo-input.ts#parseClusterQuery]
- **S19.R-28** A cluster answer MUST hold at most 500 cells, the highest by offers with ties by `cellId`, and set `truncated`. [proof: S19 AS-38] [code: packages/backend/libs/domains/fulfilment/domain/cluster-cap.ts#capClusterCells]
- **S19.R-29** A successful clusters answer MUST carry `Cache-Control: public, s-maxage=30` and no cookie; `429` and `503` MUST carry `no-store`. [proof: S19 AS-39] [code: packages/backend/libs/domains/fulfilment/api/pickup-public.controller.ts#PickupPublicController]
- **S19.R-30** The exact browse MUST return points within the radius (boundary included) ordered by exact distance then `id`, hide invisible points, give `quantity` only with `productId`, and be keyset-paged. [proof: S19 AS-40, S19 AS-41] [code: packages/backend/libs/domains/fulfilment/infra/pickup-browse.reader.ts#PickupBrowseSqlReader]
- **S19.R-31** The exact browse MUST cancel a statement that runs longer than two seconds and answer `503` `service_unavailable` with a generic detail. [proof: S19 AS-43] [code: packages/backend/libs/domains/fulfilment/infra/pickup-browse.reader.ts#PickupBrowseSqlReader]
- **S19.R-32** The pickup tables MUST hold no foreign key to another domain, and the pickup code MUST import no model of another domain. [proof: S19 AS-44]
- **S19.R-33** The domain MUST export `pickup_*` metrics and log without shopper coordinates, full addresses or bodies. [proof: S19 AS-45] [code: packages/backend/libs/domains/fulfilment/infra/pickup-metrics.ts#PickupMetrics]

## Behaviors
- **S19.B-01** Given `A` with stock 4 at a point 3 km away and 0 at another, when searching with radius 5, then one item with the nearest point returns; with radius 2 none. [proof: S19 AS-01]
- **S19.B-02** Given a misspelled query, when searching, then the product is still found. [proof: S19 AS-02]
- **S19.B-03** Given 45 products, when paging with limit 20, then pages of 20, 20 and 5 arrive in the order of one unpaged request. [proof: S19 AS-05]
- **S19.B-04** Given an archived product, a sandbox product, an inactive point and a suspended shop, when shoppers search, browse and load clusters, then none of them is visible. [proof: S19 AS-06]
- **S19.B-05** Given 99 points, when two creates run at once, then exactly one answers `201` and one `409`. [proof: S19 AS-13]
- **S19.B-06** Given stock 5, when ten decrements of one run at once, then five succeed and five answer `409`. [proof: S19 AS-21]
- **S19.B-07** Given an adjustment repeated with the same key, then the stored answer returns and stock changes once. [proof: S19 AS-20]
- **S19.B-08** Given a stock change to zero committed but not consumed, then search still shows the offer and the exact check reports the shortage. [proof: S19 AS-32]
- **S19.B-09** Given the index emptied, when every event is replayed shuffled and twice, then the index equals the live one. [proof: S19 AS-31]
- **S19.B-10** Given zoom 3, 8 and 14 over the same data, then the cell count never falls and the total of offers stays the same. [proof: S19 AS-35]

## Lifecycles
A pickup point is `active` or inactive by `PATCH`; setting the current value is a no-op. Shop deletion deactivates it. No other status exists.

## Owns
- Tables `PickupPoint`, `PickupStock`, `PickupProductCopy`, `PickupShopCopy`. [code: packages/backend/db/ownership.ts#OWNERSHIP]
- Index `pickup_availability` and the four consumer groups of the pickup projector.
- Rate-limit policies `fulfilment.near-search` and `fulfilment.map-clusters`.
- Events `pickup.stock_changed` and `pickup.point_changed`.

## Decisions
- Search and clusters never fall back to the exact store: it is sized for writes and exact checks.
- Product and shop facts come from events into copy tables of this domain plus one catalog batch read at stock write; no foreign key and no foreign model.
- One index document per point and product is a pure function of the four sources; its external version is the sum of their versions, so replay in any order converges.
- The point cap is serialised per shop by a transaction advisory lock.

## Known gaps
- The p99 latency under 80 ms at 20,000 requests per second, the freshness percentiles and the 1-in-1000 staleness bound have no automated proof (listed in `specs/UNVERIFIED.md`).
