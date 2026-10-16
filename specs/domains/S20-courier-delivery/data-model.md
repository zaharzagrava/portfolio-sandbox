# Data model: S20

Owner of all tables: `domain:fulfilment`. No foreign key to another domain's table; IDs are plain `UUID`. Money is `BIGINT` minor units. Migrations: expand (additive, `lock_timeout`) and contract (drops) as separate files.

## Courier (exists; changed)
`id UUID PK` (the user ID; FK to `User` dropped), `city TEXT` (CHECK `^[a-z0-9-]{2,40}$`), `vehicle` in (`bike`,`scooter`,`car`), `status` in (`OFFLINE`,`AVAILABLE`,`BUSY`), `createdAt`. `OFFLINE↔AVAILABLE` by the courier through a conditional `UPDATE … WHERE status IN (…)`; `BUSY` only in accept / finish / cancel transactions; city and vehicle change only `WHERE status <> 'BUSY'` and no live offer.

## Delivery (exists; changed)
`id, shopId, orderId NOT NULL, buyerId, city, pickupLat/Lng, dropoffLat/Lng, status, courierId?, attempt int, feeMinor BIGINT, currency CHAR(3), surge NUMERIC(4,2), nextActionAt timestamptz?, cancelReason text?, orderSyncedStatus text?, version int, createdAt, updatedAt`.
Indexes: unique partial `(orderId, shopId) WHERE status <> 'CANCELLED'`; unique partial `(courierId) WHERE status IN ('ASSIGNED','PICKED_UP')`; keyset `(shopId, createdAt DESC, id DESC)`; `(nextActionAt) WHERE status IN ('REQUESTED','OFFERED')`. Dropped (contract step): FKs on `shopId`, `buyerId`; column `feeCents`.
States (FR-022): `REQUESTED → OFFERED → ASSIGNED → PICKED_UP → DELIVERED`; `OFFERED → REQUESTED` (decline / expire / withdraw); `REQUESTED | OFFERED | ASSIGNED → CANCELLED`; terminal `DELIVERED`, `CANCELLED`. The exact table is AS-28.

## DeliveryOffer (new)
`id, deliveryId, courierId, attempt, status OFFERED|ACCEPTED|DECLINED|EXPIRED|WITHDRAWN, offeredAt, expiresAt, respondedAt?`. Unique partial `(courierId) WHERE status='OFFERED'`; unique `(deliveryId, courierId)` (permanent exclusion: never offered twice); `(expiresAt) WHERE status='OFFERED'` for recovery.

## DeliveryEvent (history; changed)
`id, deliveryId, from, to, actorKind courier|shop|system|order, actorId?, detail?, version, at`. FK and cascade dropped; append-only.

## DeliverableOrder (new)
`orderId PK, buyerId, shopIds uuid[], currency, status PAID|CANCELLED, orderVersion int, updatedAt`. Upsert guarded by `orderVersion` (higher wins; equal or lower ignored; cancelled-before-paid creates `CANCELLED`).

## Track point (DynamoDB `CourierTrack`)
Partition `courierId#day`, sort `ts`; attributes `lat, lng, accuracy?, deliveryId?, expiresAt` (epoch seconds, +90 d). Conditional put on `(courier, ts)` → exactly once.

## Redis (per city, hash tag `{city}`)
Live position hash, geo set of searchable couriers, offer guard, surge map (180 s expiry), track throttle; ring heartbeat is global. All derived; loss is repaired by pings and the recovery job.

## Outbox
`delivery.status_changed` v1 per milestone (`REQUESTED`, `ASSIGNED`, `PICKED_UP`, `DELIVERED`, `CANCELLED`), written in the transition transaction; `deliveryVersion` = `Delivery.version`.
