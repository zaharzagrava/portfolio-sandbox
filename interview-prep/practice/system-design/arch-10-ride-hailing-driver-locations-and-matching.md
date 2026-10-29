# arch-10. Ride-hailing: driver locations and matching

*Geo · Hard*

## The question

"Design the core of a ride-hailing app: drivers' apps send their location, and when a rider requests a ride we match them with a nearby driver within a few seconds. Up to 300k drivers online at peak, each sending a location every 4 seconds; ~2M rides a day. A driver must never be assigned two rides at once."

**Then:** "A stadium concert ends: 20k ride requests in 10 minutes from one square kilometre. At the same moment, the Redis node holding that city's driver locations dies."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Matching objective? → assume: shortest pickup ETA by road, not straight-line distance; ties broken by driver rating/acceptance.
- Offer model? → assume: offer to one driver at a time, 15 s to accept; batch matching in dense areas (deep dive 2).
- Pricing/surge? → assume: exists as a separate service; matching reads the multiplier, doesn't compute it.
- Location history? → assume: needed for trip records, disputes and ETA models, not for matching.
- Numbers → assume: 300k / 4 s = 75k location updates/s at peak; ~100 B each = 7.5 MB/s. Rides 2M/day ≈ 23/s avg, a few hundred/s at peaks. Location history ~150k avg online × 1 update/4 s × 86,400 s × 100 B ≈ 320 GB/day to S3.
- Geography → assume: ~200 cities; the busiest city has ~40k drivers online.

## Design

**1. Location ingest.** Driver app → WebSocket gateway (connections already open for offers) → location service:
- Redis (sharded by city, large cities split by region): `GEOADD drivers:{city}:available lon lat driverId` and `ZADD drivers:{city}:seen <ts> driverId`.
- Kafka `driver-locations` (key = driverId) → S3 for history, trip tracking, ETA training.
- A cleaner removes drivers not seen for 15 s (`ZRANGEBYSCORE seen` → `ZREM` from both sets).
Only the latest position is "hot"; nothing goes to Postgres per update.

**2. Driver state** in Postgres (source of truth for assignment): `drivers(id, status, current_trip_id, version)`; status `offline | available | offered | en_route | on_trip`. Available set in Redis mirrors it.

**3. Request → match.**
1. `POST /rides` (idempotency key) → `rides(id, rider_id, pickup, status='searching')`.
2. `GEOSEARCH drivers:{city}:available FROMLONLAT … BYRADIUS 3 km ASC COUNT 20`.
3. Road ETA for the top ~10 from the routing service (OSRM/Valhalla on our map data, or a maps API), pick the best.
4. **Reserve the driver atomically in Postgres:**
```sql
UPDATE drivers SET status = 'offered', current_trip_id = $ride, version = version + 1
WHERE id = $driver AND status = 'available';   -- 0 rows → someone else got them, take the next
```
5. Push the offer; 15 s timer (a delayed job). Accept → `en_route`, ride `matched`. Decline/timeout → driver back to `available`, next candidate (exclude this driver for this ride).

**4. Trip tracking.** During the trip, the rider's app subscribes to that driver's location; the gateway forwards updates from the location stream.

**5. Idempotent state changes.** Every driver/rider action carries the ride ID and expected state; transitions are guarded `UPDATE … WHERE status = expected`.

## Deep dives

**1. Geo index choice.** Options: Redis GEO (sorted set of 52-bit geohash scores; `GEOSEARCH` by radius), an in-memory H3 grid in the matching service (cell → driver set; H3 resolution 8 cells are ~0.7 km²), PostGIS. Chosen: Redis GEO sharded by city: 75k writes/s spread across shards is easy, radius queries are fast, and the data is ephemeral. H3 grid when we need per-cell aggregates (supply/demand per hexagon for surge and dispatch). Rejected: PostGIS for live positions (75k row updates/s of pure churn: WAL, vacuum, replication lag for data that's stale in 4 s).

**2. Hot area (twist, part 1).** 20k requests in 10 min is only ~33/s; throughput isn't the problem. Supply is: hundreds of requests compete for the same few hundred drivers, so greedy one-by-one matching causes offer collisions and bad global outcomes (a driver 1 min from rider A is sent to rider B). Chosen: batch matching for that area: collect requests for ~2 s, compute an ETA matrix, solve an assignment that minimizes total pickup time, then reserve drivers with the guarded UPDATE. Plus product levers: surge to pull in drivers, a designated pickup zone, a rider queue with honest wait estimates. Rejected: widening the search radius only (drivers 20 minutes away accept and riders cancel).

**3. Redis node dies (twist, part 2).** Locations are ephemeral: every online driver re-sends within 4 s, so a replacement node (or the promoted replica) is repopulated in seconds without restoring anything. During those seconds matching in that city returns fewer candidates; requests wait and retry, they don't fail. Assignment safety doesn't depend on Redis: the guarded UPDATE in Postgres is the only place a driver becomes `offered`, so a stale or duplicated Redis entry can't double-assign. Chosen: replicas for faster failover, but no durability effort (no AOF fsync) for location data. Rejected: making Redis the source of truth for driver status.

**4. Hot city sharding.** One key per city puts the busiest city on one shard. Split large cities by coarse region (H3 resolution 4-5 parents); a search near a border queries the neighboring regions too.

## Traps

- Writing every location update to Postgres.
- Matching by straight-line distance: a driver across a river or on the other side of a highway is "close".
- Using Redis as the authority for "driver is free": a lost write or failover can double-assign. Keep a guarded write in the database.
- Offering one ride to several drivers at once without a reservation step: two accept, one gets cancelled, both are annoyed.
- Treating the stadium spike as a throughput problem: it's a supply and assignment problem.
- Forgetting stale drivers: a driver whose phone died stays "available" and gets offers.

## Say it (60–90 s)

Driver apps send locations every four seconds over a WebSocket, which is seventy-five thousand updates a second at peak. The latest position goes into Redis GEO sets sharded by city, and the full stream goes to Kafka for history and ETA models; nothing goes to Postgres per update. A cleaner drops drivers not seen for fifteen seconds. When a rider requests a ride, I search Redis for available drivers within a few kilometres, get road ETAs for the closest ten, and reserve the best one with a guarded update in Postgres: set status offered only where status is available. That update is the single place a driver gets assigned, so nothing in Redis can double-book a driver. The driver has fifteen seconds to accept, otherwise the next candidate gets the offer. For the stadium, thirty requests a second isn't a throughput problem; the problem is many riders competing for few drivers, so I batch requests in that area every couple of seconds and solve an assignment that minimizes total pickup time, with surge and a pickup zone on the product side. If that city's Redis node dies, it refills in four seconds because every driver re-sends, and assignment safety is unaffected.

## Follow-ups

**Q:** How do you compute ETAs fast enough?
**A:** A routing engine with precomputed contraction hierarchies answers in milliseconds; adjust with live traffic speeds per road segment from the location stream. Cache ETAs per (origin cell, destination cell) for a short time.

**Q:** The driver accepts just as the offer times out.
**A:** Accept is a guarded transition `offered → en_route WHERE current_trip_id = $ride AND status = 'offered'`. If the timeout job already moved them back, the accept gets "offer expired" and the app says so.

**Q:** How do you test matching changes safely?
**A:** Replay recorded request and location streams through the new matcher offline and compare pickup ETAs and match rates; then a city-level A/B test.

</details>

## Theory in the notes

- [10-system-design/06-realtime-and-collaboration.md](../../10-system-design/06-realtime-and-collaboration.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
