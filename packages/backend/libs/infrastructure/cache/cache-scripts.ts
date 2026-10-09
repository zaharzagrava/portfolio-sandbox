import { createHash } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * All Lua of the toolkit lives here so atomicity is reviewed in one place (R-01). Every script touches only keys
 * that share one hash tag (the entry `K` and `{K}:…`), so each runs on one shard.
 */
export class LuaScript {
  readonly sha: string;

  constructor(readonly source: string) {
    this.sha = createHash('sha1').update(source).digest('hex');
  }
}

/** EVALSHA with an EVAL fallback when the server has not seen the script yet. */
export async function runScript(
  client: Redis,
  script: LuaScript,
  keys: string[],
  args: (string | number)[] = [],
): Promise<unknown> {
  try {
    return await client.evalsha(script.sha, keys.length, ...keys, ...args);
  } catch (error) {
    if (error instanceof Error && error.message.includes('NOSCRIPT'))
      return client.eval(script.source, keys.length, ...keys, ...args);
    throw error;
  }
}

/**
 * The minimum record is `<version>:<until>`: `until` is on the injected clock (AS-39, AS-74), the store's own
 * expiry (PX) only cleans up after it. A record whose `until` has passed is no minimum at all.
 */
const MINIMUM_HELPER = `
local function currentMinimum(raw, now)
  if not raw then return nil end
  local v, u = string.match(raw, '^(%d+):(%d+)$')
  if not v then return nil end
  if tonumber(u) <= now then return nil end
  return tonumber(v)
end
`;

/**
 * Store a loaded entry unless the key's minimum accepted version forbids it (FR-022).
 * KEYS[1] entry, KEYS[2] `{K}:min`; ARGV[1] payload, ARGV[2] lifetime ms, ARGV[3] version or '', ARGV[4] now ms.
 */
export const GUARDED_STORE = new LuaScript(`${MINIMUM_HELPER}
local min = currentMinimum(redis.call('GET', KEYS[2]), tonumber(ARGV[4]))
if min ~= nil then
  if ARGV[3] == '' then return 'refused_unversioned' end
  if tonumber(ARGV[3]) < min then return 'refused_below_minimum' end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 'ok'
`);

/**
 * Delete the entry when it is older than `n` (or unversioned) and raise the minimum, never lowering it (FR-021).
 * KEYS[1] entry, KEYS[2] `{K}:min`; ARGV[1] n, ARGV[2] retention ms, ARGV[3] now ms, ARGV[4] until ms.
 * Returns 'applied' | 'skipped'.
 */
export const INVALIDATE_IF_OLDER = new LuaScript(`${MINIMUM_HELPER}
local n = tonumber(ARGV[1])
local raw = redis.call('GET', KEYS[1])
local ver = nil
if raw then
  local ok, env = pcall(cjson.decode, raw)
  if ok and type(env) == 'table' and type(env['ver']) == 'number' then ver = env['ver'] end
end
local min = currentMinimum(redis.call('GET', KEYS[2]), tonumber(ARGV[3]))
if ver ~= nil and ver >= n then return 'skipped' end
if min ~= nil and min >= n then return 'skipped' end
if raw then redis.call('DEL', KEYS[1]) end
redis.call('SET', KEYS[2], ARGV[1] .. ':' .. ARGV[4], 'PX', ARGV[2])
return 'applied'
`);

/** Compare-and-delete: release a lock only when the token is still ours. KEYS[1] lock; ARGV[1] token. */
export const RELEASE_LOCK = new LuaScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`);

// ---------------------------------------------------------------------------------------------------------
// Distributed lock (data-model: Lock, Fence counter)

/**
 * Take the lock and, only if it was free, draw the next fence from the resource's counter (R-08).
 * KEYS[1] lock, KEYS[2] fence counter; ARGV[1] token, ARGV[2] ttl ms, ARGV[3] fence retention ms.
 * Returns the fence (> 0), or 0 when the lock is held.
 */
export const LOCK_ACQUIRE = new LuaScript(`
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
  local fence = redis.call('INCR', KEYS[2])
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
  return fence
end
return 0
`);

/** Restart the lifetime only for the owner. KEYS[1] lock; ARGV[1] token, ARGV[2] ttl ms. Returns 1 or 0. */
export const LOCK_EXTEND = new LuaScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`);

// ---------------------------------------------------------------------------------------------------------
// Write-behind counters (data-model: Pending counter, Claimed batch, Claim index)

/**
 * Add to a member unless that would exceed the pending-member cap with a new member.
 * KEYS[1] pending hash; ARGV[1] member, ARGV[2] by, ARGV[3] cap. Returns the pending member count, or -1 at the cap.
 */
export const COUNTER_INCREMENT = new LuaScript(`
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then
  return -1
end
redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2])
return redis.call('HLEN', KEYS[1])
`);

/** Atomically takes the whole pending hash so increments arriving during a flush go to the next one. KEYS[1] pending. */
export const COUNTER_DRAIN = new LuaScript(`
local entries = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
return entries
`);

/**
 * Move every pending count into a claimed batch. KEYS[1] pending, KEYS[2] claim index, KEYS[3] batch hash;
 * ARGV[1] claim time ms, ARGV[2] batch id. Returns the batch as a flat HGETALL list (empty when nothing pending).
 */
export const COUNTER_CLAIM = new LuaScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then return {} end
redis.call('RENAME', KEYS[1], KEYS[3])
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[2])
return redis.call('HGETALL', KEYS[3])
`);

/** Delete a claimed batch for good. KEYS[1] batch hash, KEYS[2] claim index; ARGV[1] batch id. Returns 1 if it existed. */
export const COUNTER_COMMIT = new LuaScript(`
local existed = redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return existed
`);

/** Merge a claimed batch back into pending. KEYS[1] pending, KEYS[2] batch hash, KEYS[3] claim index; ARGV[1] batch id. */
export const COUNTER_RELEASE = new LuaScript(`
local existed = redis.call('EXISTS', KEYS[2])
if existed == 1 then
  local entries = redis.call('HGETALL', KEYS[2])
  for i = 1, #entries, 2 do
    redis.call('HINCRBY', KEYS[1], entries[i], entries[i + 1])
  end
  redis.call('DEL', KEYS[2])
end
redis.call('ZREM', KEYS[3], ARGV[1])
return existed
`);

/**
 * Merge back every batch claimed at or before the cutoff. KEYS[1] pending, KEYS[2] claim index;
 * ARGV[1] cutoff ms, ARGV[2] batch hash key prefix. Returns how many batches were merged.
 */
export const COUNTER_RECLAIM = new LuaScript(`
local ids = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
local merged = 0
for _, id in ipairs(ids) do
  local batch = ARGV[2] .. id
  if redis.call('EXISTS', batch) == 1 then
    local entries = redis.call('HGETALL', batch)
    for i = 1, #entries, 2 do
      redis.call('HINCRBY', KEYS[1], entries[i], entries[i + 1])
    end
    redis.call('DEL', batch)
    merged = merged + 1
  end
  redis.call('ZREM', KEYS[2], id)
end
return merged
`);
