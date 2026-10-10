/**
 * Store the event in the replay buffer and announce it to live subscribers in one atomic step (S51 FR-022, research D1).
 * The position comes from `XADD`, so a transaction cannot carry it into `PUBLISH`; a script can.
 *
 * KEYS[1] replay stream, KEYS[2] live channel
 * ARGV[1] topic, ARGV[2] type, ARGV[3] payload (JSON text), ARGV[4] events kept, ARGV[5] retention ms,
 * ARGV[6] slack (the buffer is cut back to the kept count once it grows past kept + slack)
 * Returns the stream position.
 *
 * Retention (FR-020): events older than the retention age are removed by the store's clock; past kept + slack the oldest
 * are removed down to kept (so the buffer holds between kept and kept + slack events); the key's expiry is refreshed, so
 * an idle topic's buffer disappears as a whole (III.9: every key has a TTL).
 *
 * Every removal takes a prefix of the stream, so the largest removed position is known exactly before the trim. It is
 * written into the stream's "max deleted entry id" (XSETID): a reader whose cursor is below it knows an event after the
 * cursor is gone and must resync (FR-017, research D4). Trimming alone does not record it.
 */
export const PUBLISH_SCRIPT = `
local id = redis.call('XADD', KEYS[1], '*', 't', ARGV[2], 'd', ARGV[3])
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local maxRemoved = nil

local cutoff = nowMs - tonumber(ARGV[5])
if cutoff > 0 then
  local cutoffId = cutoff .. '-0'
  local aged = redis.call('XREVRANGE', KEYS[1], '(' .. cutoffId, '-', 'COUNT', 1)
  if #aged > 0 then
    maxRemoved = aged[1][1]
    redis.call('XTRIM', KEYS[1], 'MINID', cutoffId)
  end
end

local kept = tonumber(ARGV[4])
local length = redis.call('XLEN', KEYS[1])
if length > kept + tonumber(ARGV[6]) then
  local oldest = redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', length - kept)
  maxRemoved = oldest[#oldest][1]
  redis.call('XTRIM', KEYS[1], 'MAXLEN', '=', kept)
end

if maxRemoved then
  redis.call('XSETID', KEYS[1], id, 'MAXDELETEDID', maxRemoved)
end
redis.call('PEXPIRE', KEYS[1], ARGV[5])
redis.call('PUBLISH', KEYS[2], '{"id":"' .. id .. '","topic":' .. cjson.encode(ARGV[1]) .. ',"type":' .. cjson.encode(ARGV[2]) .. ',"data":' .. ARGV[3] .. '}')
return id
`;

/** The buffer holds between `kept` and `kept + TRIM_SLACK` events (spec: 1,000 to 1,200). */
export const TRIM_SLACK = 100;
