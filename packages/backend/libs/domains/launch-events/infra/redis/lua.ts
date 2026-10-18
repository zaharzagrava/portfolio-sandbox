/**
 * Lua scripts of the booking half (S22 D-4). Keys of one event share the hash tag `{eventId}` so a cluster keeps them in
 * one slot. Every script is atomic; none reads a clock (the caller passes `now` from the injected clock).
 */

/** Creates or returns the ticket of (event, user); sheds a new join at the maximum length (G-07, G-09, AS-02, AS-11). */
export const JOIN = `
local E = ARGV[1]
local newTicket = ARGV[2]
local score = ARGV[3]
local now = tonumber(ARGV[4])
local maxLen = tonumber(ARGV[5])
local hb = tonumber(ARGV[6])
local ttl = tonumber(ARGV[7])
local shards = tonumber(ARGV[8])
local newShard = ARGV[9]
local userId = ARGV[10]
local function shardKey(s) return 'lq:{' .. E .. '}:' .. s end
local existing = redis.call('GET', KEYS[1])
if existing then
  local tk = 'lt:{' .. E .. '}:' .. existing
  local h = redis.call('HMGET', tk, 'admitted', 'lastSeen', 'tokenExp', 'shard')
  if h[1] then
    if h[1] == '1' then
      if tonumber(h[3]) > now then return {'existing', existing} end
      redis.call('DEL', tk)
    else
      if now - tonumber(h[2]) <= hb then
        redis.call('HSET', tk, 'lastSeen', now)
        redis.call('EXPIRE', tk, ttl)
        return {'existing', existing}
      end
      redis.call('ZREM', shardKey(h[4]), existing)
      redis.call('DEL', tk)
    end
  end
end
local len = 0
for s = 0, shards - 1 do len = len + redis.call('ZCARD', shardKey(s)) end
if len >= maxLen then return {'full'} end
local tk = 'lt:{' .. E .. '}:' .. newTicket
redis.call('HSET', tk, 'user', userId, 'score', score, 'lastSeen', now, 'admitted', '0', 'shard', newShard)
redis.call('EXPIRE', tk, ttl)
redis.call('ZADD', shardKey(newShard), score, newTicket)
redis.call('EXPIRE', shardKey(newShard), ttl)
redis.call('SET', KEYS[1], newTicket, 'EX', ttl)
redis.call('SADD', 'lr:active', E)
redis.call('EXPIRE', 'lr:active', ttl)
return {'created', newTicket}
`;

/** Takes back a ticket that was just created (the join was refused after creation, e.g. by the join limit). */
export const RETRACT = `
local E = ARGV[1]
local ticket = ARGV[2]
local tk = 'lt:{' .. E .. '}:' .. ticket
local shard = redis.call('HGET', tk, 'shard')
if shard then redis.call('ZREM', 'lq:{' .. E .. '}:' .. shard, ticket) end
redis.call('DEL', tk)
if redis.call('GET', KEYS[1]) == ticket then redis.call('DEL', KEYS[1]) end
return 1
`;

/** Owner-only status: refreshes the heartbeat, removes a lapsed ticket, returns the exact global rank (AS-06, AS-07, AS-10). */
export const VIEW = `
local E = ARGV[1]
local ticket = ARGV[2]
local userId = ARGV[3]
local now = tonumber(ARGV[4])
local hb = tonumber(ARGV[5])
local shards = tonumber(ARGV[6])
local tk = 'lt:{' .. E .. '}:' .. ticket
local h = redis.call('HMGET', tk, 'user', 'admitted', 'lastSeen', 'shard', 'score', 'token', 'tokenExp', 'admittedAt')
if not h[1] or h[1] ~= userId then return false end
if h[2] == '1' then
  if tonumber(h[7]) <= now then redis.call('DEL', tk) return false end
  return {'admitted', h[6], h[7], h[8] or h[7]}
end
if now - tonumber(h[3]) > hb then
  redis.call('ZREM', 'lq:{' .. E .. '}:' .. h[4], ticket)
  redis.call('DEL', tk)
  return false
end
redis.call('HSET', tk, 'lastSeen', now)
local rank = 1
local len = 0
for s = 0, shards - 1 do
  local k = 'lq:{' .. E .. '}:' .. s
  rank = rank + redis.call('ZCOUNT', k, '-inf', '(' .. h[5])
  len = len + redis.call('ZCARD', k)
end
return {'waiting', tostring(rank), tostring(len)}
`;

/**
 * The first \`want\` live tickets in global order, without taking them. A fence older than the epoch seen is refused
 * (a stale admitter cannot act, AS-08); lapsed tickets met on the way are removed and cost no capacity (AS-07).
 */
export const PEEK = `
local E = ARGV[1]
local want = tonumber(ARGV[2])
local fence = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local hb = tonumber(ARGV[5])
local shards = tonumber(ARGV[6])
local ttl = tonumber(ARGV[7])
local epochKey = 'la:{' .. E .. '}:epoch'
local cur = tonumber(redis.call('GET', epochKey) or '0')
if fence < cur then return {'stale'} end
redis.call('SET', epochKey, fence, 'EX', ttl)
local cursor = {}
for s = 0, shards - 1 do cursor[s] = 0 end
local function head(s)
  local r = redis.call('ZRANGE', 'lq:{' .. E .. '}:' .. s, cursor[s], cursor[s], 'WITHSCORES')
  if #r == 0 then return nil end
  return {r[1], tonumber(r[2])}
end
local out = {'ok'}
local taken = 0
local guard = 0
while taken < want and guard < 200000 do
  guard = guard + 1
  local best = nil
  local bestShard = nil
  for s = 0, shards - 1 do
    local hd = head(s)
    if hd and (best == nil or hd[2] < best[2] or (hd[2] == best[2] and hd[1] < best[1])) then
      best = hd
      bestShard = s
    end
  end
  if best == nil then break end
  local ticket = best[1]
  local shardKey = 'lq:{' .. E .. '}:' .. bestShard
  local tk = 'lt:{' .. E .. '}:' .. ticket
  local h = redis.call('HMGET', tk, 'user', 'lastSeen', 'admitted')
  if not h[1] or h[3] == '1' then
    redis.call('ZREM', shardKey, ticket)
  elseif now - tonumber(h[2]) > hb then
    redis.call('ZREM', shardKey, ticket)
    redis.call('DEL', tk)
    redis.call('DEL', 'lu:{' .. E .. '}:' .. h[1])
  else
    out[#out + 1] = ticket
    out[#out + 1] = h[1]
    cursor[bestShard] = cursor[bestShard] + 1
    taken = taken + 1
  end
end
return out
`;

/** Takes the peeked tickets out of the queue and marks them admitted; stores the bucket; guarded by the fence. */
export const COMMIT = `
local E = ARGV[1]
local fence = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local tokensBefore = tonumber(ARGV[5])
local count = tonumber(ARGV[6])
local epochKey = 'la:{' .. E .. '}:epoch'
local cur = tonumber(redis.call('GET', epochKey) or '0')
if fence < cur then return {'stale'} end
redis.call('SET', epochKey, fence, 'EX', ttl)
local out = {'ok'}
local admitted = 0
for i = 0, count - 1 do
  local base = 7 + i * 4
  local ticket = ARGV[base]
  local token = ARGV[base + 2]
  local tokenExp = ARGV[base + 3]
  local tk = 'lt:{' .. E .. '}:' .. ticket
  local shard = redis.call('HGET', tk, 'shard')
  if shard then
    if redis.call('ZREM', 'lq:{' .. E .. '}:' .. shard, ticket) == 1 then
      redis.call('HSET', tk, 'admitted', '1', 'token', token, 'tokenExp', tokenExp, 'admittedAt', tostring(now))
      redis.call('EXPIRE', tk, math.max(60, math.ceil((tonumber(tokenExp) - now) / 1000) + 60))
      out[#out + 1] = ticket
      admitted = admitted + 1
    end
  end
end
redis.call('HSET', 'la:{' .. E .. '}:bucket', 'tokens', tostring(tokensBefore - admitted), 'at', tostring(now))
redis.call('EXPIRE', 'la:{' .. E .. '}:bucket', ttl)
return out
`;

/** Sets or clears seat bits and assigns the next \`seq\` in one step; refuses when the map is absent (AS-46). */
export const MAP_APPLY = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local bit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
for i = 3, #ARGV do redis.call('SETBIT', KEYS[1], tonumber(ARGV[i]), bit) end
local seq = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('EXPIRE', KEYS[2], ttl)
return seq
`;

/** Bitmap and \`seq\` read together, so the \`seq\` is never older than a bit in the bitmap. */
export const MAP_READ = `
local bitmap = redis.call('GET', KEYS[1])
local seq = redis.call('GET', KEYS[2])
if not bitmap or not seq then return false end
return {bitmap, seq}
`;

export const MAP_SEED = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

export const QUOTA_CLAIM = `
local cur = redis.call('GET', KEYS[1])
if not cur then return {-1, 0} end
cur = tonumber(cur)
local count = tonumber(ARGV[1])
if cur + count > tonumber(ARGV[2]) then return {0, cur} end
local n = redis.call('INCRBY', KEYS[1], count)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return {1, n}
`;

export const QUOTA_CREDIT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local n = redis.call('DECRBY', KEYS[1], tonumber(ARGV[1]))
if n < 0 then redis.call('SET', KEYS[1], 0, 'KEEPTTL') n = 0 end
return n
`;

/** The seat filter: takes the seat, or takes it over when the holder written in the value has lapsed by the caller's clock. */
export const SEAT_LOCK_TRY = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', tonumber(ARGV[2])) then return 1 end
local cur = redis.call('GET', KEYS[1])
if cur then
  local exp = tonumber(string.match(cur, ':(%d+)$'))
  if exp and exp <= tonumber(ARGV[3]) then
    redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
    return 1
  end
end
return 0
`;

export const SEAT_LOCK_RELEASE = `
local cur = redis.call('GET', KEYS[1])
if cur and string.sub(cur, 1, #ARGV[1] + 1) == ARGV[1] .. ':' then return redis.call('DEL', KEYS[1]) end
return 0
`;

export const SEAT_LOCK_KEEP = `
local cur = redis.call('GET', KEYS[1])
if cur and string.sub(cur, 1, #ARGV[1] + 1) == ARGV[1] .. ':' then
  redis.call('SET', KEYS[1], ARGV[1] .. ':9999999999999', 'PX', tonumber(ARGV[2]))
  return 1
end
return 0
`;
