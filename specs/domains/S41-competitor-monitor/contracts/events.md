# Contract: events

## Produced

**`sellerinsights.competitor_price_dropped` v1** (spec name `seller_insights.competitor_price_dropped`; the S53 envelope forbids `_` in the first type segment — see research.md "Gap status"). Aggregate type `seller_insights`, topic `seller_insights.events`, key = `watchId`, via `OutboxService.append` in the evaluation transaction.

Envelope `{eventId, type, version: 1, occurredAt, aggregateId: watchId}`; `aggregateVersion` = the observation counter (`priceVersion`).

Payload (zod in `packages/contracts`): `{watchId, shopId, productId, productTitle, host, competitorPriceMinor, yourPriceMinor, currency, ownerId, priceVersion}` — money integers ≥ 0, one currency (the competitor page's), never the URL path or query.

- One event per OWNER; `eventId` = deterministic hash of `(watchId, priceVersion, ownerId)`; redelivery of an observation writes no second row (unique `eventId`, per-watch `lastEvaluatedObservationNo`).
- Consumer: S28 (`insights.competitor_price_drop`); it must dedupe on `eventId`.
- Change from today (`crawler.service.ts` publishes `CompetitorPriceDropped.create(watchId, 0, …)` per undercut watch): `priceVersion` added (additive), aggregate version = counter instead of 0, one row per owner already holds.

## Consumed (projector app, S53 consumer framework, own consumer group)

| Type | Topic | Payload fields used | Effect | Idempotency |
|---|---|---|---|---|
| `tenancy.shop_created` v1 | tenancy topic | shopId, plan, status `ACTIVE`, shopVersion | upsert `CompetitorShop` | version guard `WHERE version < :v` |
| `tenancy.shop_plan_changed` v1 | same | shopId, plan, shopVersion | update plan | version guard |
| `tenancy.shop_status_changed` v1 | same | shopId, to, shopVersion | status; pause/resume watches in the same transaction | version guard |
| `tenancy.shop_deleted` v1 | same | shopId (no version) | delete watches + row, retire unwatched targets | unconditional, repeatable |
| `catalog.product_deleted` v1 | `products.events` | productId, shopId, productVersion | delete the product's watches, retire unwatched targets | deleting nothing is success |

Validation: zod per event (UUID ids, known plan/status enums, integer versions, supported envelope version); a failure is dead-lettered with a reason code and changes nothing; an unrelated type on the topic is ignored without a dead letter (AS-53). Consumer inject nothing foreign: schemas come from `@marketplace-sandbox/contracts` or the sibling entry points' event exports (`ShopCreated`, `ProductDeleted`, as `read-model.projectors.ts` already does).
