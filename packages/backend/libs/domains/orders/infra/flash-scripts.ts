/**
 * Key space and Lua scripts of the flash-sale fast store (S11 data-model §2, research R-03). Every key family has its
 * own hash tag (`{<saleId>:<b>}` for a bucket's stock and draws, `{<saleId>:claim:<id>}`, `{<saleId>:quota:<buyer>}`,
 * `{<saleId>:adm}`, `{<saleId>:claims}`, `{<saleId>:buyers}`), so on a cluster each lives on its own slot, and no script
 * touches two families: a claim is a sequence of idempotent single-family steps that can be resumed or given back from
 * the claim record. The arithmetic follows the pure functions in `domain/` (`flash-bucket-plan`, `flash-admission`).
 */

export const flashKeys = {
  stock: (saleId: string, bucket: number) =>
    `flash:{${saleId}:${bucket}}:stock`,
  draws: (saleId: string, bucket: number) =>
    `flash:{${saleId}:${bucket}}:draws`,
  claim: (saleId: string, claimId: string) =>
    `flash:{${saleId}:claim:${claimId}}`,
  claimPattern: (saleId: string) => `flash:{${saleId}:claim:*}`,
  quota: (saleId: string, buyerId: string) =>
    `flash:{${saleId}:quota:${buyerId}}`,
  admission: (saleId: string) => `flash:{${saleId}:adm}`,
  soldOut: (saleId: string) => `flash:{${saleId}:state}:sold-out-emitted`,
  claims: (saleId: string) => `flash:{${saleId}:claims}`,
  buyers: (saleId: string) => `flash:{${saleId}:buyers}`,
};

/** KEYS: stock, draws. ARGV: claimId, take, defaultTtlMs. -2 already drawn, -1 not enough (a missing bucket is empty). */
export const BUCKET_DRAW = `
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 then return -2 end
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local take = tonumber(ARGV[2])
if cur < take then return -1 end
local left = redis.call('DECRBY', KEYS[1], take)
redis.call('HSET', KEYS[2], ARGV[1], take)
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then ttl = tonumber(ARGV[3]) end
redis.call('PEXPIRE', KEYS[2], ttl)
return left
`;

/** KEYS: stock, draws. ARGV: claimId, mode ('return' | 'discard'), defaultTtlMs. Returns the units that were drawn. */
export const BUCKET_RETURN = `
local n = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
if n > 0 then
  if ARGV[2] == 'return' then
    redis.call('INCRBY', KEYS[1], n)
    if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3])) end
  end
  redis.call('HDEL', KEYS[2], ARGV[1])
end
return n
`;

/** KEYS: stock. ARGV: target. Lowers the bucket to the target, never raises it. Returns the bucket after. */
export const BUCKET_CLAMP = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local target = tonumber(ARGV[1])
if cur > target then redis.call('DECRBY', KEYS[1], cur - target); return target end
return cur
`;

/**
 * KEYS: claim record. ARGV: buyer, qty, unitPriceMinor, nowMs, ttlMs, plan (json). Creates the record, or answers the
 * existing one ({state, plan}); a `RETURNED` record is replaced (a retry after a refusal takes a fresh claim).
 */
export const CLAIM_OPEN = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  local state = redis.call('HGET', KEYS[1], 'state')
  if state ~= 'RETURNED' then
    return {state, redis.call('HGET', KEYS[1], 'plan') or '[]'}
  end
  redis.call('DEL', KEYS[1])
end
redis.call('HSET', KEYS[1], 'state', 'CLAIMED', 'buyer', ARGV[1], 'qty', ARGV[2], 'unitPriceMinor', ARGV[3],
  'createdAtMs', ARGV[4], 'plan', ARGV[6])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
return {'created', ARGV[6]}
`;

/** KEYS: claim record. ARGV: plan (json). Replaces the plan while the claim is still `CLAIMED`; 1 done, 0 not claimed. */
export const CLAIM_SET_PLAN = `
if redis.call('HGET', KEYS[1], 'state') ~= 'CLAIMED' then return 0 end
redis.call('HSET', KEYS[1], 'plan', ARGV[1])
return 1
`;

/** KEYS: claim record. CLAIMED → COMMITTED. */
export const CLAIM_COMMIT = `
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'CLAIMED' then redis.call('HSET', KEYS[1], 'state', 'COMMITTED'); return 'committed' end
if state == 'COMMITTED' or state == 'SOLD' then return 'already_committed' end
return 'not_held'
`;

/** KEYS: claim record. CLAIMED | COMMITTED → SOLD (a payment proves the order exists). */
export const CLAIM_CONVERT = `
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'CLAIMED' or state == 'COMMITTED' then redis.call('HSET', KEYS[1], 'state', 'SOLD'); return 'converted' end
if state == 'SOLD' then return 'already_converted' end
return 'not_held'
`;

/**
 * KEYS: claim record. ARGV: mode. CLAIMED | COMMITTED | RETURNING → RETURNING (resumable; the first mode wins).
 * Returns {'begun', plan, buyer, mode}, {'already_released'} or {'not_held'}.
 */
export const CLAIM_RELEASE_BEGIN = `
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'CLAIMED' or state == 'COMMITTED' then
  redis.call('HSET', KEYS[1], 'state', 'RETURNING', 'mode', ARGV[1])
  return {'begun', redis.call('HGET', KEYS[1], 'plan') or '[]', redis.call('HGET', KEYS[1], 'buyer') or '', ARGV[1]}
end
if state == 'RETURNING' then
  return {'begun', redis.call('HGET', KEYS[1], 'plan') or '[]', redis.call('HGET', KEYS[1], 'buyer') or '',
    redis.call('HGET', KEYS[1], 'mode') or ARGV[1]}
end
if state == 'RETURNED' then return {'already_released'} end
return {'not_held'}
`;

/** KEYS: claim record. RETURNING → RETURNED. */
export const CLAIM_RELEASE_END = `
if redis.call('HGET', KEYS[1], 'state') == 'RETURNING' then redis.call('HSET', KEYS[1], 'state', 'RETURNED') end
return 1
`;

/** KEYS: quota hash. ARGV: claimId, qty, limit, ttlMs. 1 already counted, 0 over the limit, 2 counted. */
export const QUOTA_TAKE = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 1 end
local total = tonumber(redis.call('HGET', KEYS[1], 'total') or '0')
if total + tonumber(ARGV[2]) > tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HINCRBY', KEYS[1], 'total', ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
return 2
`;

/** KEYS: quota hash. ARGV: claimId. Returns the quota the claim held (0 when none). */
export const QUOTA_RELEASE = `
local q = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
if q > 0 then
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('HINCRBY', KEYS[1], 'total', -q)
end
return q
`;

/**
 * KEYS: admission hash. ARGV: rate, nowMs, ttlMs. Token bucket, burst = one second of the rate, starting full; the
 * clock is the caller's (`flash-admission.ts` is the specification). Returns 1 admitted, 0 not.
 */
export const ADMIT = `
local rate = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local t = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAtMs')
local tokens = tonumber(t[1])
local updated = tonumber(t[2])
if tokens == nil or updated == nil then tokens = rate; updated = now end
local elapsed = now - updated
if elapsed < 0 then elapsed = 0 end
tokens = tokens + elapsed * rate / 1000
if tokens > rate then tokens = rate end
if updated < now then updated = now end
local ok = 0
if tokens >= 1 then tokens = tokens - 1; ok = 1 end
redis.call('HSET', KEYS[1], 'tokens', string.format('%.9f', tokens), 'updatedAtMs', string.format('%d', updated))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return ok
`;

/** KEYS: sorted set. ARGV: score, member, ttlMs. */
export const ZSET_ADD = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`;

/** KEYS: set. ARGV: member, ttlMs. */
export const SET_ADD = `
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`;
