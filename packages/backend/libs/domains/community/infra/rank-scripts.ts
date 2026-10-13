/**
 * Lua scripts of the ranking cache (S25 D1-D3). Rankings are ZSETs whose members are sortable ids (timestamp first),
 * so "score descending, then newest id first" is the native reverse order, and a keyset page needs the last
 * (score, member) the client saw.
 */

/**
 * KEYS[1] = ranking. ARGV = cursorScore ('' for the first page), cursorMember, count.
 * Returns a flat array [member, score, member, score, ...] of at most `count` entries after the cursor.
 */
export const RANK_PAGE = `
local count = tonumber(ARGV[3])
if ARGV[1] == '' then
  return redis.call('ZREVRANGE', KEYS[1], 0, count - 1, 'WITHSCORES')
end
local cursorScore = tonumber(ARGV[1])
local out = {}
local seen = 0
local ties = redis.call('ZREVRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[1], 'WITHSCORES')
for i = 1, #ties, 2 do
  if ties[i] < ARGV[2] and seen < count then
    out[#out + 1] = ties[i]
    out[#out + 1] = ties[i + 1]
    seen = seen + 1
  end
end
if seen < count then
  local rest = redis.call('ZREVRANGEBYSCORE', KEYS[1], '(' .. ARGV[1], '-inf', 'WITHSCORES', 'LIMIT', 0, count - seen)
  for i = 1, #rest do out[#out + 1] = rest[i] end
end
return out
`;

/**
 * KEYS[1] = ranking, KEYS[2] = built marker. ARGV = cap, ttlSeconds, then member/score pairs.
 * Adds the members, trims to the cap (lowest rank first), refreshes both expiries.
 */
export const RANK_PUT = `
local cap = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
for i = 3, #ARGV, 2 do
  redis.call('ZADD', KEYS[1], ARGV[i + 1], ARGV[i])
end
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -(cap + 1))
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('EXPIRE', KEYS[1], ttl) end
redis.call('SET', KEYS[2], '1', 'EX', ttl)
return 1
`;

/** KEYS[1] = ranking. ARGV = member, score, ttlSeconds. Updates a member only when it is already ranked. */
export const RANK_UPDATE = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 1
end
return 0
`;

/**
 * KEYS[1] = vote counts hash. ARGV = dUps, dDowns, dWups, dWdowns, ttlSeconds.
 * Applies the delta only when the entry exists; returns the new [ups, downs, wups, wdowns] or false.
 */
export const COUNT_APPLY = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
local ups = redis.call('HINCRBY', KEYS[1], 'ups', ARGV[1])
local downs = redis.call('HINCRBY', KEYS[1], 'downs', ARGV[2])
local wups = redis.call('HINCRBY', KEYS[1], 'wups', ARGV[3])
local wdowns = redis.call('HINCRBY', KEYS[1], 'wdowns', ARGV[4])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
return { ups, downs, wups, wdowns }
`;

/** KEYS[1] = counter key. ARGV = delta, ttl. Adjusts an existing numeric counter only. */
export const COUNTER_ADJUST = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
local v = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return v
`;
