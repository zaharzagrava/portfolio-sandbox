/**
 * KEYS[1] = seen set, KEYS[2] = the period's board registry; then pairs (zsetKey, revenueHashKey) - one per (board, shop) update.
 * ARGV[1] = orderId, ARGV[2] = TTL seconds, ARGV[3] = TIE_BITS, then quadruples (board, shopId, amount, tie) matching the key pairs.
 * Returns 1 if applied, 0 if this order was already counted (Kafka replay).
 *
 * All keys are declared (Redis Cluster routes and validates by KEYS) and share
 * the period's hash tag. Revenue is an exact integer in the hash; the ZSET
 * score is REBUILT from it on each sale, so the tie-breaker is replaced rather
 * than accumulated. `%.0f` matters: Lua's default number→string is %.14g,
 * which would silently drop the tie-breaker's low digits at these magnitudes.
 */
export const APPLY_SALE = `
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[2])
local bits = tonumber(ARGV[3])
local pairs_count = (#KEYS - 2) / 2
for j = 0, pairs_count - 1 do
  local z, rev = KEYS[3 + 2 * j], KEYS[4 + 2 * j]
  local board, shop, amount, tie = ARGV[4 + 4 * j], ARGV[5 + 4 * j], tonumber(ARGV[6 + 4 * j]), tonumber(ARGV[7 + 4 * j])
  redis.call('SADD', KEYS[2], board)
  local total = redis.call('HINCRBY', rev, shop, amount)
  redis.call('ZADD', z, string.format('%.0f', total * bits + tie), shop)
  redis.call('EXPIRE', z, ARGV[2])
  redis.call('EXPIRE', rev, ARGV[2])
end
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1`;
