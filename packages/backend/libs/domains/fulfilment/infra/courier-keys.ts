/**
 * Cell-based sharding by city (10/07 #23): every courier key carries the city
 * hash tag, so a city's couriers, its GEO index and offer locks live on ONE
 * Redis slot (Lua can touch them atomically) and a hot city can be moved to
 * its own shard without affecting others. Kafka uses the city as the key too.
 */
export const geoKey = (city: string) => `couriers:{${city}}:available`;
export const courierKey = (city: string, courierId: string) =>
  `courier:{${city}}:${courierId}`;
export const offerLockKey = (city: string, courierId: string) =>
  `courier:{${city}}:${courierId}:offer`;
export const trackThrottleKey = (city: string, deliveryId: string) =>
  `delivery:{${city}}:${deliveryId}:pushed`;
export const surgeKey = (city: string) => `surge:{${city}}`;
export const demandKey = (city: string, minute: number) =>
  `demand:{${city}}:${minute}`;

/**
 * The one key that is not per city: the dispatcher instances' heartbeats (S20 R-8). A city's work never touches it.
 */
export const RING_KEY = 'delivery:ring:instances';

/**
 * Every per-city key builder, applied to one city (S20 R-9, A26, AS-54). The cell-isolation spec inspects this list: a
 * builder added here without the `{city}` hash tag fails it, and a builder missing from here is a review finding.
 */
export function keyShapes(
  city: string,
  ids: { courierId: string; deliveryId: string; minute: number },
): Record<string, string> {
  return {
    geoKey: geoKey(city),
    courierKey: courierKey(city, ids.courierId),
    offerLockKey: offerLockKey(city, ids.courierId),
    trackThrottleKey: trackThrottleKey(city, ids.deliveryId),
    surgeKey: surgeKey(city),
    demandKey: demandKey(city, ids.minute),
  };
}

/**
 * KEYS[1] courier hash, KEYS[2] city GEO set. ARGV: courierId, ts, lat, lng, ttlSec, searchable ('1' | '0').
 * Newer-only: a point not newer than the live one (phones batch and retry; the network reorders) changes nothing.
 * Otherwise the position and the searchable-set membership change together; the caller decides `searchable` from
 * the stored status. Returns {applied (1 | 0), active delivery id ('' if none)}.
 */
export const APPLY_LOCATION = `
local last = tonumber(redis.call('HGET', KEYS[1], 'ts') or '0')
local delivery = redis.call('HGET', KEYS[1], 'delivery') or ''
if tonumber(ARGV[2]) <= last then return {0, delivery} end
redis.call('HSET', KEYS[1], 'ts', ARGV[2], 'lat', ARGV[3], 'lng', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[5])
if ARGV[6] == '1' then
  redis.call('GEOADD', KEYS[2], ARGV[4], ARGV[3], ARGV[1])
else
  redis.call('ZREM', KEYS[2], ARGV[1])
end
return {1, delivery}`;

/**
 * KEYS[1] courier hash, KEYS[2] city GEO set. ARGV: courierId, status, deliveryId ('' to clear).
 * Status and GEO membership change together (an AVAILABLE courier without a
 * fresh position stays out of the index until its next ping).
 */
export const SET_STATUS = `
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'delivery', ARGV[3])
redis.call('EXPIRE', KEYS[1], 3600)
if ARGV[2] == 'AVAILABLE' then
  local lat, lng = redis.call('HGET', KEYS[1], 'lat'), redis.call('HGET', KEYS[1], 'lng')
  if lat and lng then redis.call('GEOADD', KEYS[2], lng, lat, ARGV[1]) end
else
  redis.call('ZREM', KEYS[2], ARGV[1])
end
return 1`;
