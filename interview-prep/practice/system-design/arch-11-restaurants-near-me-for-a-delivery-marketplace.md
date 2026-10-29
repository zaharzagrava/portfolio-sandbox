# arch-11. "Restaurants near me" for a delivery marketplace

*Geo · Easy*

## The question

"Our food delivery marketplace has ~300k restaurants in 50 cities. The home screen shows restaurants that deliver to the user's address, with filters (cuisine, price, rating, open now) and sorting by distance or rating. ~30M searches a day, and dinner time on Friday is the peak. Design the search."

**Then:** "Product wants results sorted by estimated delivery time, and a restaurant that pressed 'pause, too busy' is still showing up in results for a few minutes."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- What does "near" mean? → assume: the restaurant's delivery zone (a polygon drawn per restaurant) contains the user's address; not a fixed radius.
- Free-text search over menus? → assume: separate feature (search index); this is the browse/filter screen.
- Freshness? → assume: menu/rating changes within minutes are fine; open/paused status within ~30 s.
- Results size? → assume: 20 per page, typical city user sees 100-500 candidates; dense Manhattan up to ~3,000.
- Numbers → assume: 30M/day ≈ 350/s avg; Friday 19:00 ~10x the average ≈ 3.5k/s. Data: 300k restaurants × ~2 KB (incl. polygon) ≈ 600 MB, fits in memory of one Postgres instance.
- Write rate → assume: tiny (hundreds/min of status changes), so this is a read-scaling problem.

## Design

**1. Data** (Postgres + PostGIS):
```sql
restaurants(id, city_id, name, location geography(Point, 4326),
  delivery_zone geography(Polygon, 4326), cuisines text[], price_level smallint,
  rating numeric(2,1), prep_minutes int, accepting_orders bool, open_now bool, timezone text)
CREATE INDEX ON restaurants USING gist (delivery_zone);
CREATE INDEX ON restaurants USING gin (cuisines);
opening_hours(restaurant_id, weekday, opens time, closes time)
```

**2. Query**
```sql
SELECT id, name, rating, ST_Distance(location, $pt) AS dist_m
FROM restaurants
WHERE ST_Intersects(delivery_zone, $pt)          -- GiST: bounding-box check, then exact
  AND accepting_orders AND open_now
  AND ($cuisines IS NULL OR cuisines && $cuisines)
  AND price_level <= $maxPrice
ORDER BY dist_m LIMIT 20 OFFSET 0;
```
Pagination: the candidate set is small (hundreds), so the API computes the full sorted ID list once, caches it for the session (5 min) and pages through it; no deep OFFSET queries.

**3. "Open now".** A job every minute recomputes `open_now` per restaurant from `opening_hours` in the restaurant's IANA time zone (handles DST and past-midnight hours like 18:00-02:00) and writes only changed rows. Queries filter on the flag, not on time math.

**4. Read scaling.** Each query is a few ms on an index; 3.5k/s ≈ 10-20 vCPU of query work → 2-3 read replicas plus the primary for writes.

**5. Cache.** Key = (H3 resolution 9 cell of the address, ~0.1 km², + filter hash), value = sorted candidate IDs, TTL 60 s in Redis. Dense areas get high hit rates. Restaurant cards (name, image, rating) hydrate from a per-restaurant cache.

**6. Response:** IDs + cards, plus a `generatedAt` so the app can refresh.

## Deep dives

**1. Paused restaurant still showing (twist, part 2).** Two caches hide the change: the 60 s result cache and replica lag. Chosen: results are cached as candidate IDs; at hydration time every card is checked against a small, always-fresh status map (`status:{restaurantId}` in Redis, updated synchronously when the restaurant presses pause), and paused ones are filtered out. Staleness drops to the status write itself. Rejected: shortening the cache TTL to 5 s (load goes up, the race remains); purging cache keys by restaurant (one restaurant appears under thousands of cell+filter keys).

**2. Sort by delivery ETA (twist, part 1).** ETA = prep time (live, from the restaurant's queue) + courier pickup wait + travel time. Computing road ETAs for 500 candidates per request is too slow. Chosen: precompute travel time per (restaurant, H3 cell) for cells inside each delivery zone every ~10 minutes from recent trip data and a routing engine; at query time, ETA = live prep time + table lookup. Sort in the API after the SQL filter. Rejected: straight-line distance as a proxy (rivers, highways), routing calls per request.

**3. PostGIS vs geohash/OpenSearch.** Geohash prefixes in Redis or OpenSearch `geo_distance` handle "within radius" well; delivery zones are polygons, so we need point-in-polygon. PostGIS does it with a GiST index on 300k rows comfortably. Chosen: PostGIS. Move to OpenSearch (`geo_shape` queries plus full-text) when menu search and complex relevance ranking join this screen.

## Traps

- Using a fixed radius when restaurants have delivery zones: shows restaurants that won't deliver to you.
- Computing "open now" with server time instead of the restaurant's time zone, or breaking on hours past midnight.
- Caching per exact GPS coordinate: every user is a cache miss. Round to a cell.
- Deep OFFSET pagination on a geo query: repeats the work for every page.
- Treating read scaling as a sharding problem: 600 MB of data needs replicas and caching, not shards.

## Say it (60–90 s)

The data is small, about three hundred thousand restaurants, so this is a read-scaling problem. I keep restaurants in Postgres with PostGIS: a point for the location and a polygon for the delivery zone, with a GiST index on the zone. The query asks for restaurants whose zone intersects the user's point, plus filters on cuisine, price and an open-now flag, sorted by distance or rating. Open-now is recomputed every minute by a job using each restaurant's time zone, so the query doesn't do time math. Friday peak is about three and a half thousand queries a second at a few milliseconds each, so two or three read replicas are enough. In front, I cache the sorted candidate IDs in Redis keyed by a small H3 cell around the address plus the filters, for sixty seconds. To fix the paused restaurant, I don't cache status with the results: at hydration I check each restaurant against a fresh status key written the moment they press pause. For sorting by delivery time, I precompute travel times from each restaurant to the cells in its zone and add live prep time at query time.

## Follow-ups

**Q:** What changes when we grow from 300k to 5M places?
**A:** Still fits PostGIS on one primary (a few GB); partition by city if vacuum or index rebuilds hurt. Read replicas scale reads.

**Q:** How do you rank beyond distance and rating?
**A:** A scoring function in the API over the candidate set: ETA, rating, conversion rate, promotions, user's past orders. Candidates from SQL, ranking in code.

**Q:** Why not cache the rendered home screen per city?
**A:** Delivery zones make results address-specific; a city-level cache shows restaurants that don't deliver to you.

</details>

## Theory in the notes

- [10-system-design/04-web-platform-architectures.md](../../10-system-design/04-web-platform-architectures.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [10-system-design/01-system-design-framework.md](../../10-system-design/01-system-design-framework.md)
