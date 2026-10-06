/**
 * Rate-limit algorithms as Redis Lua (lesson 03/04 §7, 04/03 §3). Scripts run
 * atomically - no read-modify-write race between instances - and use Redis
 * `TIME`, so all instances share one clock regardless of app-server skew.
 */

/**
 * Token bucket: capacity C, refill R tokens/ms. Requests may take up to
 * `requested` tokens; with `partial=1` it grants what's available (used by
 * the local lease limiter to take a slice of the budget in one round trip).
 * Returns { granted, remainingTokens, retryAfterMs }.
 */
export const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local partial = tonumber(ARGV[4])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
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
if granted == 0 then retry = math.ceil((math.max(1, requested) - tokens) / rate) end
return { granted, math.floor(tokens), retry }
`;

/**
 * Sliding window counter: weighted sum of the previous and current fixed
 * windows - smooth like a sliding log, O(1) memory like a fixed window.
 * KEYS[1] = current window key, KEYS[2] = previous window key (same hash tag).
 * Returns { allowed, remaining, resetMs }.
 */
export const SLIDING_WINDOW = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local elapsedInWindow = tonumber(ARGV[3])
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
local estimate = previous * (1 - elapsedInWindow / window) + current
if estimate + 1 > limit then
  return { 0, math.max(0, math.floor(limit - estimate)), window - elapsedInWindow }
end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], window * 2)
return { 1, math.max(0, math.floor(limit - estimate - 1)), window - elapsedInWindow }
`;

/**
 * Concurrency limiter: at most N in-flight leases (ZSET member = lease id,
 * score = expiry). Expired leases from crashed holders are pruned first, so a
 * dead process can't hold a slot forever. Returns 1 if acquired.
 */
export const CONCURRENCY_ACQUIRE = `
local limit = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local id = ARGV[3]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= limit then return 0 end
redis.call('ZADD', KEYS[1], now + leaseMs, id)
redis.call('PEXPIRE', KEYS[1], leaseMs * 2)
return 1
`;
