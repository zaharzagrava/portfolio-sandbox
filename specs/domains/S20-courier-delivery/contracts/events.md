# Event contracts: S20

Produced (schemas in `packages/contracts/src/fulfilment/delivery.ts`, via `defineEvent`):

- `delivery.status_changed` v1 — outbox, topic `delivery.events`, key `deliveryId`, envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; payload `{deliveryId, orderId, shopId, buyerId, status, previousStatus | null, courierId | null, reason | null, feeMinor, currency, deliveryVersion}`; `deliveryVersion` strictly increases; one event per milestone, none for offer churn.
- `courier.locations_reported` v1 — direct produce, topic `courier`, key = city; payload `{courierId, city, deliveryId | null, points: [{lat, lng, ts, accuracy?}]}`; consumer: the history projector only.
- SQS `delivery-offer-timeouts` `{deliveryId, city, courierId, attempt, handBacks?}` — standard queue, no `groupId`, delay ≤ 900 s.

Consumed (own consumer group each; zod-validated, version-guarded, poison → DLQ with a reason):

- `order.paid` v1, `order.cancelled` v1 (topic `orders.events`) → `DeliverableOrder`.
- `tenancy.shop_deleted` v1 → cancel the shop's open deliveries (`PICKED_UP` flagged, not cancelled).
- `courier.locations_reported` v1 → Dynamo `CourierTrack`.

Jobs (S49, each with `declareJobType`): `fulfilment.compute-surge` (60 s, concurrency 1), `fulfilment.recover-deliveries` (15 s, concurrency 1), `fulfilment.apply-order-lifecycle` (≤ 8 attempts).
