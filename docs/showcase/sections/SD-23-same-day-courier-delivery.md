# SD-23 — Same-Day Courier Delivery (Uber-style dispatch)

Status: ☑ done (typechecked; spec written, not run) · Phase 4 · Depends on: F-02 (Dynamo), F-03, SD-19 (orders), SD-29

## Marketplace adaptation
Orders from local shops (SD-13 pickup points) can be delivered same-day by **couriers**. Couriers stream GPS every 4 s; dispatch offers an order to the best nearby courier with a timeout; buyers track live.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Location ingestion endpoint (batched points, HTTP keep-alive / WS) → **Redis GEO** per city `couriers:{city}` (`GEOADD`, `GEOSEARCH BYRADIUS`) — latest position only in memory | 10/07 #23 |
| **Location history in DynamoDB** `CourierTrack` (PK `COURIER#<id>#<date>`, SK ts) via Kafka `courier.locations` consumer — disputes/analytics, TTL 90 days | 10/07 #23, D24 |
| **Atomic courier state** AVAILABLE → OFFERED (Redis `SET courier:{id}:offer orderId NX PX 15000`) → never double-assigned | 10/07 #23 |
| Offer loop: rank candidates (distance; ETA hook), offer one at a time with timeout → next (SD-29 delayed job / SQS delay) | 10/07 #23 |
| **Delivery state machine** REQUESTED → OFFERED → ASSIGNED → PICKED_UP → DELIVERED / CANCELLED (Postgres, conditional transitions, history) | 10/07 #23 |
| **Cell-based sharding by city**: Kafka key = city, dispatcher instances own cities (consistent hashing reused from SD-16), blast radius per city | 10/07 #23 |
| Live tracking: courier position → SSE topic `delivery:{id}` throttled to 1 update/2 s | 10/06 |
| Surge multiplier per H3/geohash cell computed every minute from supply/demand counts | 10/07 #23 |

## Steps
- [x] `DeliveryModule`: courier status endpoints, location ingest (validate, drop stale/out-of-order by timestamp), dispatch service, offer accept/decline, tracking SSE.
- [x] Dynamo `CourierTrack` + consumer (BatchWrite).
- [x] Delivery models/migrations + state machine.
- [x] e2e: 3 couriers near pickup → nearest offered; decline → next; two concurrent dispatches can't offer the same courier; accept → ASSIGNED.

## Scale
- Target: 200k active couriers → 50k location updates/s; 5k dispatches/s at peak lunch.
- Hot path: location → Redis GEOADD (per city key) + Kafka produce (async persistence). Dispatch → GEOSEARCH + SET NX. Postgres only for delivery state transitions (5k/s → batched inserts of history).
- First bottleneck & fix: one mega-city GEO key hot → split city into geohash-prefix sub-keys and search neighbours; Dynamo track writes → partition by courier+day.
- Capacity: Redis GEOADD ~100k/s per shard → 1 shard per big city; Dynamo on-demand 50k WCU-equivalent.
- Proof: k6 courier simulator (location stream) + dispatch requests; dispatch p99 < 200 ms; double-assignments == 0.

## Implementation notes (2026-10-01)
- **Schema:** migration `20261001280000-courier-delivery` adds `Courier`, `Delivery` (partial indexes for open/active deliveries) and `DeliveryEvent` history. DynamoDB `CourierTrack` (`dynamodb/CourierTrack.json`, courier+day partitions, 90-day TTL). ElasticMQ queue `delivery-offer-timeouts`.
- **Cell sharding by city:** every courier key is hash-tagged `{city}` (GEO index, courier hash, offer locks), so Lua touches them atomically and a hot city can get its own shard. The Kafka key is the city.
- **`CourierService`:**
  - Location batches (≤ 20 points, timestamps within 5 min / +10 s skew) → one Lua call that applies only newer timestamps and keeps the GEO set equal to the AVAILABLE couriers.
  - Buyer tracking push on `delivery:{id}` is throttled to 1 per 2 s (`SET NX PX`).
  - One Kafka event per batch → `CourierTrackProjector` → BatchWrite (deduped keys, UnprocessedItems backoff).
- **`DispatchService`:**
  - `GEOSEARCH` with widening radii 3/6/12 km, skipping couriers who declined. The courier offer lock is `SET NX PX 15000`, so double-offering is impossible.
  - Conditional transitions (`UPDATE ... FROM (SELECT ... FOR UPDATE) WHERE previous IN (allowed)`) plus a history row in one transaction. The pure transition table is in `delivery-state.ts`.
  - Offer expiry and "no courier yet" retries are SQS-delayed messages keyed by attempt (stale timers are ignored). After 8 attempts the delivery is cancelled and the buyer notified.
  - Accept requires the offered courier and a live offer; the lock is released only if still owned.
- **`SurgeJob`** (worker, every minute): per geohash-5 cell, demand (10-minute request counters) / supply (available couriers via `GEOHASH`), clamped to 1.0–3.0 in 0.25 steps; it prices `feeCents` at request time. `geohash.ts` is verified against the canonical vector.
- **Endpoints:** `POST /api/couriers/me`, `PUT /couriers/me/availability`, `POST /couriers/me/locations`, `POST /api/shops/:shopId/deliveries`, `GET /api/deliveries/:id`, `POST /deliveries/:id/{accept,decline,picked-up,delivered}`. The SSE `delivery:` policy (buyer + courier) is in the gateway.
- **Spec** `delivery/delivery.e2e-spec.ts` covers: nearest first → decline → next → accept → pool membership, concurrent dispatch with one courier, timeouts and stale timers, ordered locations, surge pricing.
