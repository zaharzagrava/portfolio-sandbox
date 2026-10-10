/**
 * Rate-limit algorithms as Redis Lua (P0327). Every decision is one atomic script call, so there is no read-modify-write
 * race between instances (FR-009). Time is the store's `TIME`, unless the caller passes a millisecond override (tests
 * drive the store clock through `TimeSource`, FR-010). Every stored item gets an expiry (FR-011).
 *
 * All scripts return arrays of numbers. Decision scripts return
 * `{ granted | allowed, remaining, retryAfterMs, resetMs, flag }` with flag 0 = ordinary, 1 = paused, 2 = cost above limit.
 * `retryAfterMs` is `-1` when waiting never helps.
 */

/** Shared prologue: `now` in ms from the override argument or the store clock. */
const NOW = (argIndex: number): string => `
local now
if ARGV[${argIndex}] ~= '' then
  now = tonumber(ARGV[${argIndex}])
else
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
`;

export interface LuaScript {
  name: string;
  source: string;
}

/**
 * Token bucket. KEYS[1] bucket hash. ARGV: capacity, ratePerMs, requested, partial(0|1), nowOverride.
 * `partial = 1` grants what is available (floor), used by the local lease to take a slice in one call.
 * A pause (`paused_until`) denies everything until it ends. Lowering the capacity clamps the stored tokens on read.
 */
export const TOKEN_BUCKET: LuaScript = {
  name: 'token-bucket',
  source: `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local partial = tonumber(ARGV[4])
${NOW(5)}
if requested > capacity then return { 0, 0, -1, 0, 2 } end

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts', 'paused_until')
local paused = tonumber(state[3])
if paused ~= nil and paused > now then
  return { 0, 0, paused - now, paused - now, 1 }
end

local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)

local granted = 0
if tokens >= requested then
  granted = requested
elseif partial == 1 then
  granted = math.floor(tokens)
end
tokens = tokens - granted

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate) + 1000)

local retry = 0
if granted == 0 then
  local need = requested
  if partial == 1 then need = 1 end
  retry = math.ceil((math.max(1, need) - tokens) / rate)
end
return { granted, math.floor(tokens), retry, math.ceil((capacity - tokens) / rate), 0 }
`,
};

/**
 * Sliding window counter. KEYS[1] = base name of the window items (ending in ':sw:'); the current and previous items
 * are base..index and base..(index-1), the index coming from the store clock inside this step (all share one hash tag).
 * ARGV: limit, windowMs, cost, nowOverride. Integer arithmetic: admit iff
 *   previous * (W - elapsed) + (current + cost) * W <= limit * W.
 */
export const SLIDING_WINDOW: LuaScript = {
  name: 'sliding-window',
  source: `
local limit = tonumber(ARGV[1])
local W = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
${NOW(4)}
if cost > limit then return { 0, 0, -1, 0, 2 } end

local index = math.floor(now / W)
local elapsed = now - index * W
local currentKey = KEYS[1] .. index
local current = tonumber(redis.call('GET', currentKey) or '0')
local previous = tonumber(redis.call('GET', KEYS[1] .. (index - 1)) or '0')

local used = previous * (W - elapsed) + current * W
if used + cost * W <= limit * W then
  redis.call('INCRBY', currentKey, cost)
  redis.call('PEXPIRE', currentKey, W * 2)
  local remaining = math.floor((limit * W - used - cost * W) / W)
  return { 1, remaining, 0, W - elapsed, 0 }
end

local remaining = math.max(0, math.floor((limit * W - used) / W))
local retry
local room = (limit - current - cost) * W
if room >= 0 then
  -- Waiting inside this window: previous * (W - e2) <= room, with e2 the elapsed time when admitted.
  local e2 = W - math.floor(room / previous)
  retry = e2 - elapsed
else
  -- The current window alone is full: admitted in the next window, where it becomes the previous one.
  local e3 = 0
  if current > 0 then
    e3 = W - math.floor((limit - cost) * W / current)
    if e3 < 0 then e3 = 0 end
  end
  retry = (W - elapsed) + e3
end
if retry < 1 then retry = 1 end
return { 0, remaining, retry, retry, 0 }
`,
};

/**
 * Concurrency limiter: ZSET member = lease id, score = expiry (ms). KEYS[1] the set. ARGV: limit, leaseMs, id, nowOverride.
 * Expired leases are pruned first, so a crashed holder frees its slot when its lease ends.
 * Returns { acquired, remaining, retryAfterMs } with the hint clamped to 1-5 s.
 */
export const CONCURRENCY_ACQUIRE: LuaScript = {
  name: 'concurrency-acquire',
  source: `
local limit = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local id = ARGV[3]
${NOW(4)}
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local earliest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local wait = tonumber(earliest[2]) - now
  if wait < 1000 then wait = 1000 end
  if wait > 5000 then wait = 5000 end
  return { 0, 0, wait }
end
redis.call('ZADD', KEYS[1], now + leaseMs, id)
redis.call('PEXPIRE', KEYS[1], leaseMs * 2)
return { 1, limit - count - 1, 0 }
`,
};

/**
 * Penalty: empty the bucket and pause it until now + ms, never shortening an existing pause.
 * KEYS[1] bucket. ARGV: ms, nowOverride, timeToFullMs. Returns { pausedUntil }. The item lives until the bucket would be
 * full again after the pause (+ 1 s), so it never reappears full while the pause is still "recent".
 * After the pause the bucket refills from empty: its timestamp is the end of the pause.
 */
export const PENALIZE: LuaScript = {
  name: 'penalize',
  source: `
local ms = tonumber(ARGV[1])
${NOW(2)}
local until_ = now + ms
local existing = tonumber(redis.call('HGET', KEYS[1], 'paused_until'))
if existing ~= nil and existing > until_ then until_ = existing end
redis.call('HSET', KEYS[1], 'tokens', 0, 'ts', until_, 'paused_until', until_)
redis.call('PEXPIRE', KEYS[1], (until_ - now) + tonumber(ARGV[3]) + 1000)
return { until_ }
`,
};

/**
 * Refund for a token bucket: add back units up to the capacity; creates nothing for an unknown subject.
 * KEYS[1] bucket. ARGV: capacity, units. Returns { refunded }.
 */
export const REFUND_TOKEN_BUCKET: LuaScript = {
  name: 'refund-token-bucket',
  source: `
local capacity = tonumber(ARGV[1])
local units = tonumber(ARGV[2])
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
if tokens == nil then return { 0 } end
local after = math.min(capacity, tokens + units)
redis.call('HSET', KEYS[1], 'tokens', after)
return { 1 }
`,
};

/**
 * Refund for a sliding window: decrement the current window item, never below zero, keeping its expiry; creates nothing.
 * KEYS[1] base. ARGV: windowMs, units, nowOverride. Returns { refunded }.
 */
export const REFUND_SLIDING_WINDOW: LuaScript = {
  name: 'refund-sliding-window',
  source: `
local W = tonumber(ARGV[1])
local units = tonumber(ARGV[2])
${NOW(3)}
local key = KEYS[1] .. math.floor(now / W)
local value = tonumber(redis.call('GET', key))
if value == nil then return { 0 } end
local after = value - units
if after < 0 then after = 0 end
redis.call('SET', key, after, 'KEEPTTL')
return { 1 }
`,
};

/**
 * Reset a token bucket (KEYS[1]) or a sliding window (KEYS[1] base): deletes the subject's items without scanning.
 * ARGV: kind ('tb' | 'sw'), windowMs, nowOverride.
 */
export const RESET: LuaScript = {
  name: 'reset',
  source: `
local kind = ARGV[1]
if kind == 'tb' then
  redis.call('DEL', KEYS[1])
  return { 1 }
end
local W = tonumber(ARGV[2])
${NOW(3)}
local index = math.floor(now / W)
redis.call('DEL', KEYS[1] .. index, KEYS[1] .. (index - 1))
return { 1 }
`,
};
