/**
 * One call applies one paid order to every board of one period, all or nothing (S40 FR-003, FR-006, R-1..R-3).
 *
 * KEYS: [1] applied set, [2] sealed flag, [3] revenue hash (`board|shop` -> minor units), [4] last-slot hash
 * (`board|shop` -> slot), [5] board list, [6..] the sorted set of each board touched.
 * ARGV: [1] time to live in ms (period end + 35 d, counted from the injected clock), [2] order id, [3] sale slot, [4] update count, then per update four values:
 * the 1-based index of its sorted set among KEYS[6..], board name, shop id, amount.
 *
 * Returns {'sealed'|'duplicate'|'applied'|'limit', value}. The score of a shop is revenue * 2^20 + (2^20 - 1 - last slot)
 * where last slot is the larger of the stored slot and this sale's: an older event delivered later never moves it back, so
 * the board does not depend on delivery order. `%.0f` matters: Lua's default number to string is `%.14g`, which would
 * drop the low digits of a score near 2^53.
 */
export const APPLY_ORDER_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return {'sealed', '0'} end
if redis.call('SISMEMBER', KEYS[1], ARGV[2]) == 1 then return {'duplicate', '0'} end
local slot = tonumber(ARGV[3])
local n = tonumber(ARGV[4])
local MAX_REVENUE = 8589934591
local SLOTS = 1048576
local totals = {}
for i = 1, n do
  local o = 4 + (i - 1) * 4
  local field = ARGV[o + 2] .. '|' .. ARGV[o + 3]
  local current = tonumber(redis.call('HGET', KEYS[3], field) or '0')
  local total = current + tonumber(ARGV[o + 4])
  if total > MAX_REVENUE then return {'limit', string.format('%.0f', total)} end
  totals[i] = total
end
for i = 1, n do
  local o = 4 + (i - 1) * 4
  local zset = KEYS[5 + tonumber(ARGV[o + 1])]
  local board, shop = ARGV[o + 2], ARGV[o + 3]
  local field = board .. '|' .. shop
  local previous = tonumber(redis.call('HGET', KEYS[4], field) or '-1')
  local last = math.max(previous, slot)
  redis.call('HSET', KEYS[3], field, string.format('%.0f', totals[i]))
  redis.call('HSET', KEYS[4], field, string.format('%.0f', last))
  redis.call('ZADD', zset, string.format('%.0f', totals[i] * SLOTS + (SLOTS - 1 - last)), shop)
  redis.call('SADD', KEYS[5], board)
end
redis.call('SADD', KEYS[1], ARGV[2])
for k = 1, #KEYS do
  if k ~= 2 then redis.call('PEXPIRE', KEYS[k], ARGV[1]) end
end
return {'applied', '0'}`;

/** KEYS[1] zset, KEYS[2] revenue hash; ARGV[1] shop field `board|shop`, ARGV[2] shop id. One atomic read of rank, size, revenue. */
export const POSITION_SCRIPT = `
local rank = redis.call('ZREVRANK', KEYS[1], ARGV[2])
if not rank then return false end
local size = redis.call('ZCARD', KEYS[1])
local revenue = redis.call('HGET', KEYS[2], ARGV[1])
return {rank + 1, size, revenue or '0'}`;
