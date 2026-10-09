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
export const declinedKey = (city: string, deliveryId: string) =>
  `delivery:{${city}}:${deliveryId}:declined`;
export const trackThrottleKey = (deliveryId: string) =>
  `delivery:${deliveryId}:pushed`;
export const surgeKey = (city: string) => `surge:{${city}}`;
export const demandKey = (city: string, minute: number) =>
  `demand:{${city}}:${minute}`;

export const OFFER_TTL_MS = 15_000;

/**
 * KEYS[1] courier hash, KEYS[2] city GEO set. ARGV: courierId, ts, lat, lng, ttlSec.
 * Drops stale / out-of-order points (phones batch and retry; the network
 * reorders), then keeps the GEO index in sync with availability.
 * Returns the courier's active delivery id ('' if none), or false if dropped.
 */
export const APPLY_LOCATION = `
local last = tonumber(redis.call('HGET', KEYS[1], 'ts') or '0')
if tonumber(ARGV[2]) <= last then return false end
redis.call('HSET', KEYS[1], 'ts', ARGV[2], 'lat', ARGV[3], 'lng', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[5])
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'AVAILABLE' then
  redis.call('GEOADD', KEYS[2], ARGV[4], ARGV[3], ARGV[1])
else
  redis.call('ZREM', KEYS[2], ARGV[1])
end
return redis.call('HGET', KEYS[1], 'delivery') or ''`;

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
